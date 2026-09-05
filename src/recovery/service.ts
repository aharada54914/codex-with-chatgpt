import { ActivityService } from "../activities/service.js";
import type { Activity, Job } from "../domain/types.js";
import type { DomainRepositories } from "../state/repository.js";
export { CRASH_BOUNDARIES, CrashInjector, InjectedCrash } from "./checkpoints.js";

export type RecoveryObservation = "RUNNING" | "COMPLETED" | "FAILED" | "UNKNOWN";

export interface RecoveryProbes {
  database(): Promise<"HEALTHY" | "UNKNOWN">;
  bridge(): Promise<"AVAILABLE" | "UNAVAILABLE" | "UNKNOWN">;
  tunnel(): Promise<"AVAILABLE" | "UNAVAILABLE" | "UNKNOWN">;
  appServer(input: { projectId: string; activityId: string; externalJobId: string | null }): Promise<RecoveryObservation>;
  repositoryRevision(projectId: string): Promise<string | null>;
}

export class RecoveryError extends Error {
  constructor(public readonly code: "UNKNOWN_ACTIVITY" | "STALE_REVISION" | "DATABASE_UNHEALTHY", message: string) {
    super(message);
    this.name = "RecoveryError";
  }
}

export class RecoveryService {
  constructor(private readonly repositories: DomainRepositories, private readonly probes: RecoveryProbes) {}

  async reconcile(input: { projectId: string; activityId: string; expectedRevision: number }): Promise<Activity> {
    const initial = this.requireActivity(input.projectId, input.activityId);
    if (initial.revision !== input.expectedRevision) throw new RecoveryError("STALE_REVISION", "Activity revision changed");
    const job = this.latestJob(input.projectId, input.activityId);
    let database: "HEALTHY" | "UNKNOWN";
    try { database = await this.probes.database(); } catch { throw new RecoveryError("DATABASE_UNHEALTHY", "Durable state probe failed"); }
    if (database !== "HEALTHY") throw new RecoveryError("DATABASE_UNHEALTHY", "Durable state could not be verified");
    const safe = async <T>(probe: () => Promise<T>, unknown: T): Promise<T> => { try { return await probe(); } catch { return unknown; } };
    const [bridge, tunnel, appServer, repositoryRevision] = await Promise.all([
      safe(() => this.probes.bridge(), "UNKNOWN"), safe(() => this.probes.tunnel(), "UNKNOWN"),
      safe(() => this.probes.appServer({ projectId: input.projectId, activityId: input.activityId,
        externalJobId: job?.externalJobId ?? null }), "UNKNOWN"),
      safe(() => this.probes.repositoryRevision(input.projectId), null),
    ]);
    let observation: RecoveryObservation = appServer;
    if (bridge === "UNKNOWN" || tunnel === "UNKNOWN" || repositoryRevision === null) observation = "UNKNOWN";
    if (observation !== "UNKNOWN" && (!job || !job.externalJobId)) observation = "UNKNOWN";
    if (job?.repositoryRevision && repositoryRevision !== job.repositoryRevision && appServer === "COMPLETED") observation = "UNKNOWN";

    return this.repositories.transaction(() => {
      const current = this.requireActivity(input.projectId, input.activityId);
      if (current.revision !== input.expectedRevision) throw new RecoveryError("STALE_REVISION", "Activity changed during recovery");
      if (["DONE", "BLOCKED", "CANCELLED", "FAILED", "RECOVERY_REQUIRED"].includes(current.status)) return current;
      if (job) {
        const latest = this.latestJob(input.projectId, input.activityId);
        if (!latest || latest.id !== job.id || latest.revision !== job.revision || latest.externalJobId !== job.externalJobId) {
          throw new RecoveryError("STALE_REVISION", "Execution job changed during recovery");
        }
        this.recordJobObservation(job, observation);
      }
      return new ActivityService(this.repositories).reconcileAfterRestart({
        activityId: current.id, observation, expectedRevision: current.revision,
        idempotencyKey: `recovery:${current.id}:${current.revision}:${observation}`, actor: "recovery",
      }).activity;
    });
  }

  private requireActivity(projectId: string, activityId: string): Activity {
    const activity = this.repositories.activities.get(activityId);
    if (!activity || activity.projectId !== projectId) throw new RecoveryError("UNKNOWN_ACTIVITY", "Unknown activity");
    return activity;
  }

  private latestJob(projectId: string, activityId: string): Job | null {
    return this.repositories.jobs.listByProject(projectId).filter((item) => item.activityId === activityId)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)
        || right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id))[0] ?? null;
  }

  private recordJobObservation(job: Job, observation: RecoveryObservation): void {
    const next: Job = { ...job, status: observation, revision: job.revision + 1, updatedAt: new Date().toISOString() };
    if (!this.repositories.jobs.updateExpected(next, job.revision)) throw new RecoveryError("STALE_REVISION", "Job changed during recovery");
  }
}
