import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { ActivityService } from "../src/activities/service.js";
import { ContextProjector } from "../src/context/projection.js";
import type { Evidence, Project, Review } from "../src/domain/types.js";
import { openStateDatabase } from "../src/state/database.js";
import { DomainRepositories } from "../src/state/repository.js";
import { cleanup, makeTmpDir } from "./helpers.js";

const directories: string[] = [];
afterEach(() => { while (directories.length) cleanup(directories.pop()!); });

function setup() {
  const state = makeTmpDir("c2c-projection"); directories.push(state);
  const database = openStateDatabase(path.join(state, "state.sqlite3"));
  const repositories = new DomainRepositories(database);
  const timestamp = "2026-09-05T00:00:00.000Z";
  const project: Project = { id: "prj_projection", projectId: null, revision: 0, createdAt: timestamp,
    updatedAt: timestamp, name: "projection", canonicalRoot: state, rootFingerprint: "fp", filesystemIdentity: "fs" };
  repositories.projects.insert(project);
  const service = new ActivityService(repositories);
  const activity = service.create({ projectId: project.id, goal: "ship", expectedRevision: -1, idempotencyKey: "create-projection" }).activity;
  return { database, repositories, service, activity, projector: new ContextProjector(repositories), timestamp };
}

describe("ContextProjector", () => {
  it("returns compact state and an explicit tiny unchanged response", () => {
    const { database, projector, activity } = setup();
    expect(projector.project({ projectId: "prj_projection", activityId: activity.id })).toEqual({
      activityId: activity.id, status: "INTAKE", revision: 0, unchanged: false, phase: "intake", requiredAction: "NONE",
    });
    const unchanged = projector.project({ projectId: "prj_projection", activityId: activity.id, view: "debug", sinceRevision: 0 });
    expect(unchanged).toEqual({ activityId: activity.id, status: "INTAKE", revision: 0, unchanged: true });
    expect(JSON.stringify(unchanged).length).toBeLessThan(150);
    database.close();
  });

  it("projects standard evidence without local roots and caps changed files", () => {
    const { database, repositories, projector, activity, timestamp } = setup();
    const evidence: Evidence & { changedFiles: string[] } = {
      id: "ev_1", projectId: "prj_projection", activityId: activity.id, revision: 0, createdAt: timestamp, updatedAt: timestamp,
      kind: "verification", status: "PASSED", repositoryRevision: "abc123", activityRevision: 0,
      changedFiles: [...Array.from({ length: 140 }, (_, index) => `src/file-${index}.ts`), "/opt/private/repo/secret.ts", "../escape.ts"],
    };
    const review: Review = { id: "rev_1", projectId: "prj_projection", activityId: activity.id, revision: 0,
      createdAt: timestamp, updatedAt: timestamp, activityRevision: 0, reviewerAgentId: "agent", decision: "ACCEPTED" };
    repositories.evidence.insert(evidence); repositories.reviews.insert(review);
    const result = projector.project({ projectId: "prj_projection", activityId: activity.id, view: "standard" });
    expect(result.unchanged).toBe(false);
    if (!result.unchanged) {
      expect(result.changedFiles).toHaveLength(100); expect(result.changedFiles?.[0]).toBe("workspace:/src/file-0.ts");
      expect(result.review).toEqual({ decision: "ACCEPTED" });
      expect(JSON.stringify(result)).not.toContain(repositories.projects.get("prj_projection")!.canonicalRoot);
      expect(JSON.stringify(result)).not.toContain("/opt/private");
    }
    database.close();
  });

  it("bounds and sanitizes debug events and evidence references", () => {
    const { database, repositories, projector, activity, timestamp } = setup();
    for (let index = 0; index < 75; index += 1) repositories.auditEvents.insert({
      id: `evt_${index}`, projectId: "prj_projection", activityId: activity.id, revision: 0,
      createdAt: new Date(Date.parse(timestamp) + index).toISOString(), updatedAt: timestamp,
      eventType: index === 74 ? "password=hunter2 /opt/company/private/repo" : `EVENT_${index}`,
      actor: index === 73 ? String.raw`\\server\share\secret` : "/Users/private/project", fromRevision: index, toRevision: index + 1,
    });
    const result = projector.project({ projectId: "prj_projection", activityId: activity.id, view: "debug" });
    expect(result.unchanged).toBe(false);
    if (!result.unchanged) {
      expect(result.events).toHaveLength(50);
      expect(JSON.stringify(result.events)).not.toContain("hunter2");
      expect(JSON.stringify(result.events)).not.toContain("/Users/private");
      expect(JSON.stringify(result.events)).not.toContain("/opt/company");
      expect(JSON.stringify(result.events)).not.toContain("server\\share");
    }
    database.close();
  });

  it("reports pending approvals and emits only post-since deltas", () => {
    const { database, repositories, service, projector, activity, timestamp } = setup();
    expect(projector.project({ projectId: "prj_projection", activityId: activity.id, sinceRevision: 0 })).toMatchObject({ unchanged: true });
    repositories.approvals.insert({ id: "apr_pending", projectId: "prj_projection", activityId: activity.id, activityRevision: -1,
      capability: "network", status: "PENDING", expiresAt: null, revision: 0, createdAt: timestamp, updatedAt: timestamp });
    expect(projector.project({ projectId: "prj_projection", activityId: activity.id, sinceRevision: 0 }))
      .toMatchObject({ revision: 1, unchanged: false, requiredAction: "APPROVAL" });
    service.transition({ activityId: activity.id, to: "PLANNING", expectedRevision: 1, idempotencyKey: "projection-planning", actor: "test" });
    repositories.evidence.insert({ id: "ev_old", projectId: "prj_projection", activityId: activity.id, activityRevision: -1,
      revision: 0, createdAt: timestamp, updatedAt: timestamp, kind: "old", status: "PASSED", repositoryRevision: "old" });
    const afterOld = projector.project({ projectId: "prj_projection", activityId: activity.id, view: "debug" });
    expect(afterOld.unchanged).toBe(false);
    const cursor = afterOld.revision;
    repositories.evidence.insert({ id: "ev_new", projectId: "prj_projection", activityId: activity.id, activityRevision: -1,
      revision: 0, createdAt: timestamp, updatedAt: timestamp, kind: "new", status: "PASSED", repositoryRevision: "new" });
    const delta = projector.project({ projectId: "prj_projection", activityId: activity.id, view: "debug", sinceRevision: cursor });
    expect(delta.unchanged).toBe(false);
    if (!delta.unchanged) {
      expect(delta.evidence?.map((item) => item.id)).toEqual(["ev_new"]);
      expect(delta.events?.every((event) => event.toRevision > cursor)).toBe(true);
    }
    database.close();
  });

  it("sanitizes and caps persisted diagnostic timestamps", () => {
    const { database, repositories, projector, activity } = setup();
    repositories.auditEvents.insert({ id: "evt_bad_time", projectId: "prj_projection", activityId: activity.id,
      revision: 0, createdAt: `password=timestamp-secret /private/var/${"x".repeat(500)}`, updatedAt: "now",
      eventType: "EVENT", actor: String.raw`\private\windows\secret`, fromRevision: 0, toRevision: 1 });
    const result = projector.project({ projectId: "prj_projection", activityId: activity.id, view: "debug" });
    expect(result.unchanged).toBe(false);
    if (!result.unchanged) {
      const serialized = JSON.stringify(result.events);
      expect(serialized).not.toContain("timestamp-secret"); expect(serialized).not.toContain("/private/var");
      expect(serialized).not.toContain(String.raw`\private\windows`);
      expect(result.events?.[0]?.timestamp.length).toBeLessThanOrEqual(64);
    }
    database.close();
  });

  it("rejects cross-project activity reads", () => {
    const { database, projector, activity } = setup();
    expect(() => projector.project({ projectId: "prj_other", activityId: activity.id })).toThrow(/does not belong/i);
    database.close();
  });
});
