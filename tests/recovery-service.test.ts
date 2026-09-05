import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ActivityService } from "../src/activities/service.js";
import type { Approval, Job, Project } from "../src/domain/types.js";
import { DurableDispatchService } from "../src/recovery/dispatch.js";
import { CrashInjector, RecoveryService, type RecoveryObservation, type RecoveryProbes } from "../src/recovery/service.js";
import { openStateDatabase } from "../src/state/database.js";
import { DomainRepositories } from "../src/state/repository.js";
import { cleanup, makeTmpDir } from "./helpers.js";

const directories: string[] = [];
afterEach(() => { while (directories.length) cleanup(directories.pop()!); });

function setup(observation: RecoveryObservation = "UNKNOWN") {
  const state = makeTmpDir("c2c-recovery"); directories.push(state); const file = path.join(state, "state.sqlite3");
  const database = openStateDatabase(file); const repositories = new DomainRepositories(database);
  const now = "2026-09-05T00:00:00.000Z";
  const project: Project = { id: "prj_recovery", projectId: null, revision: 0, createdAt: now, updatedAt: now,
    name: "recovery", canonicalRoot: state, rootFingerprint: `fp-${state}`, filesystemIdentity: `fs-${state}` };
  repositories.projects.insert(project); const activities = new ActivityService(repositories);
  let activity = activities.create({ projectId: project.id, goal: "recover", expectedRevision: -1, idempotencyKey: `create-${state}` }).activity;
  for (const status of ["PLANNING", "READY", "DISPATCHED"] as const) activity = activities.transition({ activityId: activity.id,
    to: status, expectedRevision: activity.revision, idempotencyKey: `${state}-${status}`, actor: "test" }).activity;
  const job: Job = { id: `job-${path.basename(state)}`, projectId: project.id, activityId: activity.id, kind: "codex-turn",
    status: "RUNNING", sideEffectKey: `dispatch:${activity.id}`, externalJobId: "turn-1", repositoryRevision: "commit-a",
    revision: 0, createdAt: now, updatedAt: now }; repositories.jobs.insert(job);
  const values = { database: "HEALTHY" as const, bridge: "AVAILABLE" as const, tunnel: "AVAILABLE" as const,
    observation, repositoryRevision: "commit-a" as string | null };
  const probes: RecoveryProbes = { database: async () => values.database, bridge: async () => values.bridge,
    tunnel: async () => values.tunnel, appServer: async () => values.observation,
    repositoryRevision: async () => values.repositoryRevision };
  return { state, file, database, repositories, project, activity, job, probes, values };
}

describe("restart recovery", () => {
  it("maps completed execution to verification and never guesses DONE", async () => {
    const fixture = setup("COMPLETED"); const service = new RecoveryService(fixture.repositories, fixture.probes);
    const recovered = await service.reconcile({ projectId: fixture.project.id, activityId: fixture.activity.id,
      expectedRevision: fixture.activity.revision });
    expect(recovered.status).toBe("VERIFYING"); expect(recovered.status).not.toBe("DONE");
    expect(fixture.repositories.jobs.get(fixture.job.id)?.status).toBe("COMPLETED"); fixture.database.close();
  });

  it("maps running and failed observations without redispatching", async () => {
    for (const [observation, expected] of [["RUNNING", "EXECUTING"], ["FAILED", "FAILED"]] as const) {
      const fixture = setup(observation); const service = new RecoveryService(fixture.repositories, fixture.probes);
      const recovered = await service.reconcile({ projectId: fixture.project.id, activityId: fixture.activity.id,
        expectedRevision: fixture.activity.revision });
      expect(recovered.status).toBe(expected);
      expect(fixture.repositories.jobs.listByProject(fixture.project.id)).toHaveLength(1); fixture.database.close();
    }
  });

  it("sends ambiguous transport, repository, or App Server observations to recovery", async () => {
    for (const ambiguous of ["app", "bridge", "tunnel", "repository"] as const) {
      const fixture = setup(ambiguous === "app" ? "UNKNOWN" : "RUNNING");
      if (ambiguous === "bridge") Object.assign(fixture.probes, { bridge: async () => "UNKNOWN" as const });
      if (ambiguous === "tunnel") Object.assign(fixture.probes, { tunnel: async () => "UNKNOWN" as const });
      if (ambiguous === "repository") fixture.values.repositoryRevision = null;
      const recovered = await new RecoveryService(fixture.repositories, fixture.probes).reconcile({
        projectId: fixture.project.id, activityId: fixture.activity.id, expectedRevision: fixture.activity.revision });
      expect(recovered.status).toBe("RECOVERY_REQUIRED"); fixture.database.close();
    }
  });

  it("fails closed if durable state health cannot be established", async () => {
    const fixture = setup(); Object.assign(fixture.probes, { database: async () => "UNKNOWN" as const });
    await expect(new RecoveryService(fixture.repositories, fixture.probes).reconcile({ projectId: fixture.project.id,
      activityId: fixture.activity.id, expectedRevision: fixture.activity.revision }))
      .rejects.toMatchObject({ code: "DATABASE_UNHEALTHY" });
    expect(fixture.repositories.activities.get(fixture.activity.id)?.status).toBe("DISPATCHED"); fixture.database.close();
  });

  it("prevents duplicate side effects with a durable unique key", () => {
    const fixture = setup();
    expect(() => fixture.repositories.jobs.insert({ ...fixture.job, id: "job-duplicate" })).toThrow(/unique/i);
    expect(fixture.repositories.jobs.listByProject(fixture.project.id)).toHaveLength(1); fixture.database.close();
  });

  it("resumes durable dispatch without repeating a correlated external side effect", async () => {
    for (const boundary of ["dispatch", "execution"] as const) {
      const fixture = setup(); const now = new Date().toISOString();
      const approval: Approval = { id: `apr-${boundary}`, projectId: fixture.project.id, activityId: fixture.activity.id,
        activityRevision: -1, capability: "network", status: "PENDING", expiresAt: null,
        revision: 0, createdAt: now, updatedAt: now }; fixture.repositories.approvals.insert(approval);
      const expectedRevision = fixture.repositories.activities.get(fixture.activity.id)!.revision;
      let authoritative: { externalJobId: string; repositoryRevision: string } | null = null;
      const adapter = {
        lookup: vi.fn(async () => authoritative),
        dispatch: vi.fn(async () => (authoritative = { externalJobId: "turn-durable", repositoryRevision: "commit-a" })),
      };
      const key = `durable-${boundary}`;
      const crashing = new DurableDispatchService(fixture.repositories, adapter, new CrashInjector(boundary));
      await expect(crashing.dispatch({ projectId: fixture.project.id, activityId: fixture.activity.id,
        expectedRevision, sideEffectKey: key })).rejects.toThrow(`Injected crash at ${boundary}`);
      fixture.database.close();
      const reopened = openStateDatabase(fixture.file); const repositories = new DomainRepositories(reopened);
      if (boundary === "execution") {
        const resumed = await new DurableDispatchService(repositories, adapter).dispatch({ projectId: fixture.project.id,
          activityId: fixture.activity.id, expectedRevision, sideEffectKey: key });
        expect(resumed.job.externalJobId).toBe("turn-durable"); expect(adapter.dispatch).toHaveBeenCalledTimes(1);
      } else {
        await expect(new DurableDispatchService(repositories, adapter).dispatch({ projectId: fixture.project.id,
          activityId: fixture.activity.id, expectedRevision, sideEffectKey: key }))
          .rejects.toMatchObject({ code: "DISPATCH_IN_FLIGHT" });
        expect(adapter.dispatch).not.toHaveBeenCalled();
      }
      expect(repositories.jobs.listByProject(fixture.project.id).filter((item) => item.sideEffectKey === key)).toHaveLength(1);
      expect(repositories.approvals.get(approval.id)?.status).toBe("PENDING");
      reopened.close();
    }
  });

  it("does not redispatch for concurrent callers or a lost external response", async () => {
    const fixture = setup(); let authoritative: { externalJobId: string; repositoryRevision: string } | null = null;
    let release!: () => void; const gate = new Promise<void>((resolve) => { release = resolve; });
    const adapter = {
      lookup: vi.fn(async () => authoritative),
      dispatch: vi.fn(async () => { await gate; authoritative = { externalJobId: "turn-once", repositoryRevision: "commit-a" }; return authoritative; }),
    };
    const service = new DurableDispatchService(fixture.repositories, adapter); const input = { projectId: fixture.project.id,
      activityId: fixture.activity.id, expectedRevision: fixture.activity.revision, sideEffectKey: "concurrent-key" };
    const first = service.dispatch(input); await vi.waitFor(() => expect(adapter.dispatch).toHaveBeenCalledTimes(1));
    await expect(service.dispatch(input)).rejects.toMatchObject({ code: "DISPATCH_IN_FLIGHT" });
    release(); await first; expect(adapter.dispatch).toHaveBeenCalledTimes(1);

    let lostAuthoritative: { externalJobId: string; repositoryRevision: string } | null = null;
    const lost = { lookup: vi.fn(async () => lostAuthoritative), dispatch: vi.fn(async () => {
      lostAuthoritative = { externalJobId: "turn-lost", repositoryRevision: "commit-a" }; throw new Error("response lost");
    }) };
    const result = await new DurableDispatchService(fixture.repositories, lost).dispatch({ ...input, sideEffectKey: "lost-key" });
    expect(result.job.externalJobId).toBe("turn-lost"); expect(lost.dispatch).toHaveBeenCalledTimes(1);
    fixture.database.close();
  });

  it("rejects stale activity state before resuming an uncorrelated reservation", async () => {
    const fixture = setup(); const adapter = { lookup: vi.fn(async () => null),
      dispatch: vi.fn(async () => ({ externalJobId: "turn-stale", repositoryRevision: "commit-a" })) };
    const input = { projectId: fixture.project.id, activityId: fixture.activity.id,
      expectedRevision: fixture.activity.revision, sideEffectKey: "stale-key" };
    await expect(new DurableDispatchService(fixture.repositories, adapter, new CrashInjector("dispatch")).dispatch(input))
      .rejects.toThrow("Injected crash at dispatch");
    const now = new Date().toISOString(); fixture.repositories.approvals.insert({ id: "apr-stale-dispatch",
      projectId: fixture.project.id, activityId: fixture.activity.id, activityRevision: -1, capability: "network",
      status: "PENDING", expiresAt: null, revision: 0, createdAt: now, updatedAt: now });
    await expect(new DurableDispatchService(fixture.repositories, adapter).dispatch(input))
      .rejects.toMatchObject({ code: "STALE_REVISION" });
    expect(adapter.dispatch).not.toHaveBeenCalled(); fixture.database.close();
  });

  it("dispatches only from the explicit DISPATCHED activity state", async () => {
    for (const status of ["INTAKE", "PLANNING", "READY", "EXECUTING", "VERIFYING", "REVIEWING",
      "FIX_REQUIRED", "DONE", "BLOCKED", "CANCELLED", "FAILED", "RECOVERY_REQUIRED"] as const) {
      const fixture = setup(); const current = fixture.repositories.activities.get(fixture.activity.id)!;
      fixture.repositories.activities.update({ ...current, status });
      const adapter = { lookup: vi.fn(async () => null),
        dispatch: vi.fn(async () => ({ externalJobId: "forbidden", repositoryRevision: "commit-a" })) };
      const before = fixture.repositories.jobs.listByProject(fixture.project.id).length;
      await expect(new DurableDispatchService(fixture.repositories, adapter).dispatch({ projectId: fixture.project.id,
        activityId: fixture.activity.id, expectedRevision: current.revision, sideEffectKey: `forbidden-${status}` }))
        .rejects.toMatchObject({ code: "STALE_REVISION" });
      expect(fixture.repositories.jobs.listByProject(fixture.project.id)).toHaveLength(before);
      expect(adapter.dispatch).not.toHaveBeenCalled(); fixture.database.close();
    }
  });

  it("fails closed on missing correlation and probe exceptions", async () => {
    const missing = setup("COMPLETED");
    missing.repositories.jobs.update({ ...missing.job, externalJobId: undefined });
    const recovered = await new RecoveryService(missing.repositories, missing.probes).reconcile({ projectId: missing.project.id,
      activityId: missing.activity.id, expectedRevision: missing.activity.revision });
    expect(recovered.status).toBe("RECOVERY_REQUIRED"); missing.database.close();

    for (const probe of ["bridge", "tunnel", "appServer", "repositoryRevision"] as const) {
      const fixture = setup("RUNNING"); Object.assign(fixture.probes, { [probe]: async () => { throw new Error("probe failed"); } });
      const result = await new RecoveryService(fixture.repositories, fixture.probes).reconcile({ projectId: fixture.project.id,
        activityId: fixture.activity.id, expectedRevision: fixture.activity.revision });
      expect(result.status).toBe("RECOVERY_REQUIRED"); fixture.database.close();
    }
    const databaseFailure = setup(); Object.assign(databaseFailure.probes, { database: async () => { throw new Error("db failed"); } });
    await expect(new RecoveryService(databaseFailure.repositories, databaseFailure.probes).reconcile({ projectId: databaseFailure.project.id,
      activityId: databaseFailure.activity.id, expectedRevision: databaseFailure.activity.revision }))
      .rejects.toMatchObject({ code: "DATABASE_UNHEALTHY" }); databaseFailure.database.close();
  });

  it("rejects a job update that races with recovery probes", async () => {
    const fixture = setup("COMPLETED");
    Object.assign(fixture.probes, { appServer: async () => {
      const current = fixture.repositories.jobs.get(fixture.job.id)!;
      fixture.repositories.jobs.updateExpected({ ...current, status: "RUNNING", revision: current.revision + 1,
        updatedAt: new Date().toISOString() }, current.revision);
      return "COMPLETED" as const;
    } });
    await expect(new RecoveryService(fixture.repositories, fixture.probes).reconcile({ projectId: fixture.project.id,
      activityId: fixture.activity.id, expectedRevision: fixture.activity.revision }))
      .rejects.toMatchObject({ code: "STALE_REVISION" });
    expect(fixture.repositories.activities.get(fixture.activity.id)?.status).toBe("DISPATCHED"); fixture.database.close();
  });

  it("rejects activity changes that occur while probes are in flight", async () => {
    const fixture = setup();
    Object.assign(fixture.probes, { bridge: async () => {
      const now = new Date().toISOString(); fixture.repositories.approvals.insert({ id: "apr-race", projectId: fixture.project.id,
        activityId: fixture.activity.id, activityRevision: -1, capability: "network", status: "PENDING", expiresAt: null,
        revision: 0, createdAt: now, updatedAt: now }); return "AVAILABLE" as const;
    } });
    await expect(new RecoveryService(fixture.repositories, fixture.probes).reconcile({ projectId: fixture.project.id,
      activityId: fixture.activity.id, expectedRevision: fixture.activity.revision }))
      .rejects.toMatchObject({ code: "STALE_REVISION" });
    expect(fixture.repositories.jobs.get(fixture.job.id)?.status).toBe("RUNNING"); fixture.database.close();
  });
});
