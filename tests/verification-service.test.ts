import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ActivityService } from "../src/activities/service.js";
import type { Project } from "../src/domain/types.js";
import { CrashInjector } from "../src/recovery/checkpoints.js";
import { openStateDatabase } from "../src/state/database.js";
import { DomainRepositories } from "../src/state/repository.js";
import { detectVerificationChecks, VerificationService, type VerificationExecutor } from "../src/verification/service.js";
import { cleanup, makeTmpDir } from "./helpers.js";

const directories: string[] = [];
afterEach(() => { vi.restoreAllMocks(); while (directories.length) cleanup(directories.pop()!); });

function setup(exitCodes = [0]) {
  const state = makeTmpDir("c2c-verification"); directories.push(state);
  const database = openStateDatabase(path.join(state, "state.sqlite3")); const repositories = new DomainRepositories(database);
  const timestamp = new Date().toISOString(); const project: Project = { id: "prj_verify", projectId: null, revision: 0,
    createdAt: timestamp, updatedAt: timestamp, name: "verify", canonicalRoot: state, rootFingerprint: "fp", filesystemIdentity: "fs" };
  repositories.projects.insert(project);
  const activity = new ActivityService(repositories).create({ projectId: project.id, goal: "verify", expectedRevision: -1, idempotencyKey: "verify-create" }).activity;
  let repositoryRevision = "commit-a"; let call = 0;
  const executor: VerificationExecutor = { repositoryRevision: vi.fn(() => repositoryRevision),
    execute: vi.fn(async () => ({ exitCode: exitCodes[call++] ?? 0, outputReference: call === 1 ? "output:1" : "/private/leak" })) };
  return { database, repositories, activity, executor, setRepositoryRevision: (value: string) => { repositoryRevision = value; } };
}

describe("deterministic verification", () => {
  it("gives explicit configuration precedence over detected package scripts", () => {
    expect(detectVerificationChecks({ configured: [], packageScripts: { test: "vitest" }, packageManager: "pnpm" })).toEqual([]);
    expect(detectVerificationChecks({ packageScripts: { build: "tsc", test: "vitest", custom: "x" }, packageManager: "pnpm" }))
      .toEqual([{ name: "test", command: "pnpm run test", required: true }, { name: "build", command: "pnpm run build", required: true }]);
  });

  it("persists complete bounded evidence and accepts only the current revision", async () => {
    const { database, repositories, activity, executor, setRepositoryRevision } = setup([0, 0]);
    const service = new VerificationService(repositories, executor);
    const evidence = await service.run({ projectId: "prj_verify", activityId: activity.id, expectedRevision: 0,
      checks: [{ name: "test", command: "pnpm test", required: true }, { name: "build", command: "pnpm build", required: true }] });
    expect(evidence).toMatchObject({ status: "PASSED", repositoryRevision: "commit-a", activityRevision: 1 });
    expect(evidence.checks[0]).toMatchObject({ exitCode: 0, status: "PASSED", outputReference: "output:1" });
    expect(evidence.checks[1]?.outputReference).toBeNull();
    expect(evidence.checks.every((item) => item.startedAt && item.endedAt && item.durationMs >= 0)).toBe(true);
    expect(service.assertAcceptable({ projectId: "prj_verify", activityId: activity.id, repositoryRevision: "commit-a" }).id).toBe(evidence.id);
    setRepositoryRevision("commit-b");
    expect(() => service.assertAcceptable({ projectId: "prj_verify", activityId: activity.id, repositoryRevision: "commit-a" }))
      .toThrowError(expect.objectContaining({ code: "MISSING_EVIDENCE" }));
    database.close();
  });

  it("blocks acceptance on required failure and stale or missing evidence", async () => {
    const { database, repositories, activity, executor, setRepositoryRevision } = setup([1]); const service = new VerificationService(repositories, executor);
    await service.run({ projectId: "prj_verify", activityId: activity.id, expectedRevision: 0,
      checks: [{ name: "test", command: "pnpm test", required: true }] });
    expect(() => service.assertAcceptable({ projectId: "prj_verify", activityId: activity.id, repositoryRevision: "commit-a" }))
      .toThrowError(expect.objectContaining({ code: "CHECKS_FAILED" }));
    expect(() => service.assertAcceptable({ projectId: "prj_verify", activityId: activity.id, repositoryRevision: "commit-b" }))
      .toThrowError(expect.objectContaining({ code: "MISSING_EVIDENCE" }));
    setRepositoryRevision("commit-b");
    expect(() => service.assertAcceptable({ projectId: "prj_verify", activityId: activity.id, repositoryRevision: "commit-a" }))
      .toThrowError(expect.objectContaining({ code: "MISSING_EVIDENCE" }));
    database.close();
  });

  it("persists executor rejection as deterministic failed evidence", async () => {
    const { database, repositories, activity, executor } = setup();
    vi.mocked(executor.execute).mockRejectedValue(new Error("spawn failed /private/secret"));
    const service = new VerificationService(repositories, executor);
    const evidence = await service.run({ projectId: "prj_verify", activityId: activity.id, expectedRevision: 0,
      checks: [{ name: "test", command: "pnpm test", required: true }] });
    expect(evidence.status).toBe("FAILED");
    expect(evidence.checks[0]).toMatchObject({ exitCode: null, status: "FAILED", outputReference: null });
    expect(JSON.stringify(evidence)).not.toContain("spawn failed"); expect(JSON.stringify(evidence)).not.toContain("/private/secret");
    database.close();
  });

  it("refuses evidence when repository or activity changes during execution", async () => {
    const first = setup([0]); const firstService = new VerificationService(first.repositories, first.executor);
    vi.mocked(first.executor.execute).mockImplementation(async () => { first.setRepositoryRevision("commit-b"); return { exitCode: 0 }; });
    await expect(firstService.run({ projectId: "prj_verify", activityId: first.activity.id, expectedRevision: 0,
      checks: [{ name: "test", command: "test", required: true }] })).rejects.toMatchObject({ code: "STALE_REPOSITORY" });
    expect(first.repositories.evidence.listByProject("prj_verify")).toEqual([]); first.database.close();

    const second = setup([0]); const activityService = new ActivityService(second.repositories);
    vi.mocked(second.executor.execute).mockImplementation(async () => { activityService.transition({ activityId: second.activity.id,
      to: "PLANNING", expectedRevision: 0, idempotencyKey: "during-check", actor: "test" }); return { exitCode: 0 }; });
    await expect(new VerificationService(second.repositories, second.executor).run({ projectId: "prj_verify", activityId: second.activity.id,
      expectedRevision: 0, checks: [{ name: "test", command: "test", required: true }] })).rejects.toMatchObject({ code: "STALE_REVISION" });
    expect(second.repositories.evidence.listByProject("prj_verify")).toEqual([]); second.database.close();
  });

  it("rolls back evidence atomically at the evidence-write crash boundary", async () => {
    const fixture = setup([0]);
    const now = new Date().toISOString(); fixture.repositories.approvals.insert({ id: "apr-evidence-crash",
      projectId: "prj_verify", activityId: fixture.activity.id, activityRevision: -1, capability: "network",
      status: "PENDING", expiresAt: null, revision: 0, createdAt: now, updatedAt: now });
    const expectedRevision = fixture.repositories.activities.get(fixture.activity.id)!.revision;
    const service = new VerificationService(fixture.repositories, fixture.executor, new CrashInjector("evidence_write"));
    await expect(service.run({ projectId: "prj_verify", activityId: fixture.activity.id, expectedRevision,
      checks: [{ name: "test", command: "pnpm test", required: true }] })).rejects.toThrow("Injected crash at evidence_write");
    expect(fixture.repositories.evidence.listByProject("prj_verify")).toHaveLength(0);
    expect(fixture.repositories.activities.get(fixture.activity.id)?.revision).toBe(expectedRevision);
    expect(fixture.repositories.approvals.get("apr-evidence-crash")?.status).toBe("PENDING");
    fixture.database.close();
  });
});
