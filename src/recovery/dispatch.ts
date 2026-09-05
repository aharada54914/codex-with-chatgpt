import { createHash, randomBytes } from "node:crypto";

import type { Job } from "../domain/types.js";
import type { DomainRepositories } from "../state/repository.js";
import type { WorkflowCheckpoints } from "./checkpoints.js";

export interface DispatchAdapter {
  /** Authoritative lookup for the external side effect identified by idempotencyKey. */
  lookup(input: { projectId: string; activityId: string; idempotencyKey: string }): Promise<{
    externalJobId: string; repositoryRevision: string;
  } | null>;
  dispatch(input: { projectId: string; activityId: string; idempotencyKey: string }): Promise<{ externalJobId: string; repositoryRevision: string }>;
}

export class DispatchError extends Error {
  constructor(public readonly code: "UNKNOWN_ACTIVITY" | "STALE_REVISION" | "IDEMPOTENCY_CONFLICT" | "INVALID_RESULT" | "DISPATCH_IN_FLIGHT", message: string) {
    super(message); this.name = "DispatchError";
  }
}

const noCheckpoints: WorkflowCheckpoints = { checkpoint: () => undefined };
function id(): string { return `job_${randomBytes(16).toString("hex")}`; }
function binding(projectId: string, activityId: string, key: string): string {
  return createHash("sha256").update(JSON.stringify({ projectId, activityId, key })).digest("hex");
}

export class DurableDispatchService {
  constructor(private readonly repositories: DomainRepositories, private readonly adapter: DispatchAdapter,
    private readonly checkpoints: WorkflowCheckpoints = noCheckpoints) {}

  async dispatch(input: { projectId: string; activityId: string; expectedRevision: number; sideEffectKey: string }): Promise<{ job: Job; replayed: boolean }> {
    if (!input.sideEffectKey.trim()) throw new DispatchError("IDEMPOTENCY_CONFLICT", "A side-effect key is required");
    const requestBinding = binding(input.projectId, input.activityId, input.sideEffectKey);
    const reserved = this.repositories.transaction(() => {
      const existing = this.find(input.sideEffectKey);
      if (existing) {
        if (existing.requestBinding !== requestBinding) throw new DispatchError("IDEMPOTENCY_CONFLICT", "Dispatch key was reused");
        const activity = this.requireCurrentActivity(input);
        if (existing.activityRevision !== input.expectedRevision || activity.revision !== existing.activityRevision) {
          throw new DispatchError("STALE_REVISION", "Activity changed after dispatch reservation");
        }
        return { job: existing, replayed: true };
      }
      this.requireCurrentActivity(input);
      const now = new Date().toISOString();
      const job: Job = { id: id(), projectId: input.projectId, activityId: input.activityId,
        kind: "codex-turn", status: "PENDING", sideEffectKey: input.sideEffectKey, requestBinding,
        activityRevision: input.expectedRevision,
        revision: 0, createdAt: now, updatedAt: now };
      this.repositories.jobs.insert(job); return { job, replayed: false };
    });
    if (reserved.job.externalJobId) return { job: reserved.job, replayed: true };
    const attemptId = id();
    const claim = this.repositories.transaction(() => {
      const activity = this.requireCurrentActivity(input);
      const current = this.repositories.jobs.get(reserved.job.id);
      if (!current || activity.revision !== current.activityRevision) throw new DispatchError("STALE_REVISION", "Dispatch reservation changed");
      if (current.externalJobId) return { job: current, owned: false };
      if (current.status === "DISPATCHING") return { job: current, owned: false };
      if (current.status !== "PENDING") throw new DispatchError("STALE_REVISION", "Dispatch reservation is not resumable");
      const next: Job = { ...current, status: "DISPATCHING", dispatchAttemptId: attemptId,
        revision: current.revision + 1, updatedAt: new Date().toISOString() };
      if (!this.repositories.jobs.updateExpected(next, current.revision)) throw new DispatchError("STALE_REVISION", "Dispatch claim changed");
      return { job: next, owned: true };
    });
    if (claim.job.externalJobId) return { job: claim.job, replayed: true };
    this.checkpoints.checkpoint("dispatch");
    const lookup = () => this.adapter.lookup({ projectId: input.projectId, activityId: input.activityId,
      idempotencyKey: input.sideEffectKey });
    if (!claim.owned) {
      const authoritative = await lookup();
      if (!authoritative) throw new DispatchError("DISPATCH_IN_FLIGHT", "Dispatch outcome is not yet authoritative");
      return { job: this.correlate(claim.job.id, authoritative), replayed: true };
    }
    let result: { externalJobId: string; repositoryRevision: string };
    try {
      result = await this.adapter.dispatch({ projectId: input.projectId, activityId: input.activityId,
        idempotencyKey: input.sideEffectKey });
    } catch (error) {
      const authoritative = await lookup();
      if (!authoritative) throw error;
      result = authoritative;
    }
    this.checkpoints.checkpoint("execution");
    return { job: this.correlate(claim.job.id, result), replayed: reserved.replayed };
  }

  private requireCurrentActivity(input: { projectId: string; activityId: string; expectedRevision: number }) {
    const activity = this.repositories.activities.get(input.activityId);
    if (!activity || activity.projectId !== input.projectId) throw new DispatchError("UNKNOWN_ACTIVITY", "Unknown activity");
    if (activity.revision !== input.expectedRevision) throw new DispatchError("STALE_REVISION", "Activity revision changed");
    if (activity.status !== "DISPATCHED") throw new DispatchError("STALE_REVISION", "Activity is not dispatchable");
    return activity;
  }

  private correlate(jobId: string, result: { externalJobId: string; repositoryRevision: string }): Job {
    if (!result.externalJobId || !result.repositoryRevision) throw new DispatchError("INVALID_RESULT", "Dispatch result is not correlatable");
    return this.repositories.transaction(() => {
      const current = this.repositories.jobs.get(jobId);
      if (!current) throw new DispatchError("STALE_REVISION", "Dispatch reservation disappeared");
      if (current.externalJobId) {
        if (current.externalJobId !== result.externalJobId || current.repositoryRevision !== result.repositoryRevision) {
          throw new DispatchError("IDEMPOTENCY_CONFLICT", "Authoritative dispatch result conflicts with durable state");
        }
        return current;
      }
      const next: Job = { ...current, externalJobId: result.externalJobId, repositoryRevision: result.repositoryRevision,
        status: "RUNNING", revision: current.revision + 1, updatedAt: new Date().toISOString() };
      if (!this.repositories.jobs.updateExpected(next, current.revision)) throw new DispatchError("STALE_REVISION", "Dispatch reservation changed");
      return next;
    });
  }

  private find(key: string): Job | null {
    const row = this.repositories.database.prepare("SELECT id FROM jobs WHERE json_extract(payload_json, '$.sideEffectKey') = ?")
      .get(key) as { id: string } | undefined;
    return row ? this.repositories.jobs.get(row.id) : null;
  }
}
