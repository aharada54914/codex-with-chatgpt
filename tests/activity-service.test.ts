import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { ActivityError, ActivityService } from "../src/activities/service.js";
import type { Project } from "../src/domain/types.js";
import { openStateDatabase } from "../src/state/database.js";
import { DomainRepositories } from "../src/state/repository.js";
import { cleanup, makeTmpDir } from "./helpers.js";

const directories: string[] = [];
afterEach(() => { while (directories.length) cleanup(directories.pop()!); });

function setup(): { service: ActivityService; repositories: DomainRepositories; close: () => void } {
  const state = makeTmpDir("c2c-activity"); directories.push(state);
  const database = openStateDatabase(path.join(state, "state.sqlite3"));
  const repositories = new DomainRepositories(database);
  const timestamp = "2026-09-05T00:00:00.000Z";
  const project: Project = {
    id: "prj_test", projectId: null, revision: 0, createdAt: timestamp, updatedAt: timestamp,
    name: "test", canonicalRoot: state, rootFingerprint: "fingerprint", filesystemIdentity: "identity",
  };
  repositories.projects.insert(project);
  return { service: new ActivityService(repositories), repositories, close: () => database.close() };
}

describe("ActivityService", () => {
  it("creates idempotently and follows the legal transition table", () => {
    const { service, close } = setup();
    const created = service.create({ projectId: "prj_test", goal: "ship", expectedRevision: -1, idempotencyKey: "create-1" });
    expect(created.replayed).toBe(false);
    expect(created.activity).toMatchObject({ status: "INTAKE", revision: 0 });
    expect(service.create({ projectId: "prj_test", goal: "ship", expectedRevision: -1, idempotencyKey: "create-1" })).toEqual({
      activity: created.activity, replayed: true,
    });

    const statuses = ["PLANNING", "READY", "DISPATCHED", "EXECUTING", "VERIFYING", "REVIEWING", "DONE"] as const;
    let revision = 0;
    for (const status of statuses) {
      const result = service.transition({
        activityId: created.activity.id, to: status, expectedRevision: revision, idempotencyKey: `to-${status}`, actor: "test",
      });
      revision += 1;
      expect(result.activity).toMatchObject({ status, revision });
    }
    expect(() => service.transition({
      activityId: created.activity.id, to: "EXECUTING", expectedRevision: revision,
      idempotencyKey: "leave-terminal", actor: "test",
    })).toThrow(/terminal|illegal/i);
    close();
  });

  it("rejects illegal transitions and stale concurrent mutations", () => {
    const { service, close } = setup();
    const activity = service.create({ projectId: "prj_test", goal: "ship", expectedRevision: -1, idempotencyKey: "create" }).activity;
    expect(() => service.transition({
      activityId: activity.id, to: "DONE", expectedRevision: 0, idempotencyKey: "illegal", actor: "test",
    })).toThrowError(ActivityError);
    service.transition({ activityId: activity.id, to: "PLANNING", expectedRevision: 0, idempotencyKey: "first", actor: "test" });
    try {
      service.transition({ activityId: activity.id, to: "CANCELLED", expectedRevision: 0, idempotencyKey: "stale", actor: "test" });
      expect.unreachable("stale mutation must fail");
    } catch (error) {
      expect(error).toMatchObject({ code: "STALE_REVISION", currentRevision: 1 });
    }
    close();
  });

  it("replays cancellation exactly once and rejects idempotency-key conflicts", () => {
    const { service, repositories, close } = setup();
    const activity = service.create({ projectId: "prj_test", goal: "ship", expectedRevision: -1, idempotencyKey: "create" }).activity;
    const cancelled = service.cancel({ activityId: activity.id, expectedRevision: 0, idempotencyKey: "cancel", actor: "user" });
    const replay = service.cancel({ activityId: activity.id, expectedRevision: 0, idempotencyKey: "cancel", actor: "user" });
    expect(replay).toEqual({ activity: cancelled.activity, replayed: true });
    expect(repositories.auditEvents.listByProject("prj_test").filter((event) => event.eventType === "ACTIVITY_CANCELLED")).toHaveLength(1);
    expect(() => service.create({ projectId: "prj_test", goal: "different", expectedRevision: -1, idempotencyKey: "cancel" }))
      .toThrow(/idempotency/i);
    close();
  });

  it("canonicalizes equivalent requests before idempotency comparison", () => {
    const { service, close } = setup();
    const activity = service.create({ projectId: "prj_test", goal: "ship", expectedRevision: -1, idempotencyKey: "create" }).activity;
    const first = service.transition({
      activityId: activity.id, to: "PLANNING", expectedRevision: 0, idempotencyKey: "ordered", actor: "user",
    });
    const reordered = {
      actor: "user", idempotencyKey: "ordered", expectedRevision: 0, to: "PLANNING" as const, activityId: activity.id,
    };
    expect(service.transition(reordered)).toEqual({ activity: first.activity, replayed: true });
    expect(() => service.transition({ ...reordered, actor: "other" })).toThrow(/idempotency/i);
    close();
  });

  it("reconciles restart observations without ever guessing DONE", () => {
    const { service, close } = setup();
    const created = service.create({ projectId: "prj_test", goal: "ship", expectedRevision: -1, idempotencyKey: "create" }).activity;
    const planning = service.transition({ activityId: created.id, to: "PLANNING", expectedRevision: 0, idempotencyKey: "p", actor: "test" }).activity;
    const ready = service.transition({ activityId: created.id, to: "READY", expectedRevision: 1, idempotencyKey: "r", actor: "test" }).activity;
    const dispatched = service.transition({ activityId: created.id, to: "DISPATCHED", expectedRevision: 2, idempotencyKey: "d", actor: "test" }).activity;
    expect(planning.status).toBe("PLANNING"); expect(ready.status).toBe("READY");

    const recovered = service.reconcileAfterRestart({
      activityId: created.id, observation: "UNKNOWN", expectedRevision: dispatched.revision,
      idempotencyKey: "reconcile", actor: "recovery",
    });
    expect(recovered.activity.status).toBe("RECOVERY_REQUIRED");
    expect(recovered.activity.status).not.toBe("DONE");
    expect(service.reconcileAfterRestart({
      activityId: created.id, observation: "UNKNOWN", expectedRevision: dispatched.revision,
      idempotencyKey: "reconcile", actor: "recovery",
    })).toEqual({ activity: recovered.activity, replayed: true });
    try {
      service.reconcileAfterRestart({
        activityId: created.id, observation: "RUNNING", expectedRevision: dispatched.revision,
        idempotencyKey: "stale-reconcile", actor: "recovery",
      });
      expect.unreachable("stale reconciliation must fail before terminal validation");
    } catch (error) {
      expect(error).toMatchObject({ code: "STALE_REVISION", currentRevision: recovered.activity.revision });
    }
    close();
  });

  it("reconciles missed events and sends ambiguous observations to recovery", () => {
    const { service, close } = setup();
    const make = (key: string) => service.create({
      projectId: "prj_test", goal: key, expectedRevision: -1, idempotencyKey: `create-${key}`,
    }).activity;
    const advance = (activityId: string, key: string) => {
      service.transition({ activityId, to: "PLANNING", expectedRevision: 0, idempotencyKey: `${key}-p`, actor: "test" });
      service.transition({ activityId, to: "READY", expectedRevision: 1, idempotencyKey: `${key}-r`, actor: "test" });
      return service.transition({ activityId, to: "DISPATCHED", expectedRevision: 2, idempotencyKey: `${key}-d`, actor: "test" }).activity;
    };
    const completed = advance(make("completed").id, "completed");
    const completedResult = service.reconcileAfterRestart({
      activityId: completed.id, observation: "COMPLETED", expectedRevision: completed.revision,
      idempotencyKey: "observed-complete", actor: "recovery",
    });
    expect(completedResult.activity.status).toBe("VERIFYING");
    expect(service.reconcileAfterRestart({
      activityId: completed.id, observation: "COMPLETED", expectedRevision: completed.revision,
      idempotencyKey: "observed-complete", actor: "recovery",
    })).toEqual({ activity: completedResult.activity, replayed: true });

    const failed = advance(make("failed").id, "failed");
    const failedResult = service.reconcileAfterRestart({
      activityId: failed.id, observation: "FAILED", expectedRevision: failed.revision,
      idempotencyKey: "observed-failed", actor: "recovery",
    });
    expect(failedResult.activity.status).toBe("FAILED");
    expect(service.reconcileAfterRestart({
      activityId: failed.id, observation: "FAILED", expectedRevision: failed.revision,
      idempotencyKey: "observed-failed", actor: "recovery",
    })).toEqual({ activity: failedResult.activity, replayed: true });

    const ambiguous = make("ambiguous");
    expect(service.reconcileAfterRestart({
      activityId: ambiguous.id, observation: "RUNNING", expectedRevision: ambiguous.revision,
      idempotencyKey: "observed-ambiguous", actor: "recovery",
    }).activity.status).toBe("RECOVERY_REQUIRED");
    close();
  });

  it("serializes writers before revision reads across database connections", () => {
    const state = makeTmpDir("c2c-activity-race"); directories.push(state);
    const file = path.join(state, "state.sqlite3");
    const firstDatabase = openStateDatabase(file);
    const secondDatabase = openStateDatabase(file);
    secondDatabase.pragma("busy_timeout = 1");
    const first = new DomainRepositories(firstDatabase);
    const second = new DomainRepositories(secondDatabase);
    first.transaction(() => {
      expect(() => second.transaction(() => undefined)).toThrow(/busy|locked/i);
    });
    firstDatabase.close(); secondDatabase.close();
  });

  it("does not leave partial activity, operation, or audit records", () => {
    const { service, repositories, close } = setup();
    expect(() => service.create({ projectId: "missing", goal: "ship", expectedRevision: -1, idempotencyKey: "bad" }))
      .toThrow(/unknown project/i);
    expect(repositories.activities.listByProject("missing")).toEqual([]);
    expect(repositories.operations.listByProject("missing")).toEqual([]);
    expect(repositories.auditEvents.listByProject("missing")).toEqual([]);
    close();
  });
});
