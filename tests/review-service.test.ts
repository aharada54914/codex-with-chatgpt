import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ActivityService } from "../src/activities/service.js";
import type { Agent, Project } from "../src/domain/types.js";
import { CrashInjector } from "../src/recovery/checkpoints.js";
import { ReviewService, type ReviewerAdapter, type ReviewSource } from "../src/review/service.js";
import { openStateDatabase } from "../src/state/database.js";
import { DomainRepositories } from "../src/state/repository.js";
import { VerificationService, type VerificationExecutor } from "../src/verification/service.js";
import { cleanup, makeTmpDir } from "./helpers.js";

const directories: string[] = []; afterEach(() => { vi.restoreAllMocks(); while (directories.length) cleanup(directories.pop()!); });
function setup(decision: "ACCEPTED" | "FIX_REQUIRED" = "ACCEPTED") {
  const state = makeTmpDir("c2c-review"); directories.push(state); const database = openStateDatabase(path.join(state, "state.sqlite3"));
  const repositories = new DomainRepositories(database); const now = new Date().toISOString();
  const project: Project = { id: "prj_review", projectId: null, revision: 0, createdAt: now, updatedAt: now,
    name: "review", canonicalRoot: state, rootFingerprint: "fp", filesystemIdentity: "fs" }; repositories.projects.insert(project);
  const activities = new ActivityService(repositories); let activity = activities.create({ projectId: project.id, goal: "ship safely",
    expectedRevision: -1, idempotencyKey: "review-create" }).activity;
  for (const status of ["PLANNING", "READY", "DISPATCHED", "EXECUTING", "VERIFYING", "REVIEWING"] as const)
    activity = activities.transition({ activityId: activity.id, to: status, expectedRevision: activity.revision,
      idempotencyKey: `review-${status}`, actor: "test" }).activity;
  const implementer: Agent = { id: "agt_impl", projectId: project.id, activityId: activity.id, role: "implementer",
    threadId: "thread-impl", worktreeId: "worktree-impl", revision: 0, createdAt: now, updatedAt: now }; repositories.agents.insert(implementer);
  const executor: VerificationExecutor = { repositoryRevision: () => "commit-a", execute: async () => ({ exitCode: 0, outputReference: "out-1" }) };
  const verification = new VerificationService(repositories, executor);
  const adapter: ReviewerAdapter = { createReviewer: vi.fn(async () => ({ threadId: "thread-review", worktreeId: "worktree-review" })),
    review: vi.fn(async () => ({ decision })) };
  const source: ReviewSource = { loadDiff: vi.fn(async () => ({ repositoryRevision: "commit-a", diff: "diff --git a/a b/a" })) };
  return { database, repositories, activity, implementer, verification, adapter, source };
}
async function verified(fixture: ReturnType<typeof setup>) {
  const expectedRevision = fixture.repositories.activities.get(fixture.activity.id)!.revision;
  return fixture.verification.run({ projectId: "prj_review", activityId: fixture.activity.id,
    expectedRevision, checks: [{ name: "test", command: "pnpm test", required: true }] });
}
describe("independent review orchestration", () => {
  it("binds an isolated reviewer to actual diff and verification evidence then accepts", async () => {
    const fixture = setup(); const evidence = await verified(fixture); const service = new ReviewService(fixture.repositories, fixture.verification, fixture.adapter, fixture.source);
    const review = await service.request({ projectId: "prj_review", activityId: fixture.activity.id, implementerAgentId: fixture.implementer.id,
      expectedRevision: evidence.activityRevision, repositoryRevision: "commit-a", successCriteria: ["tests pass"] });
    expect(review).toMatchObject({ decision: "ACCEPTED", evidenceId: evidence.id, repositoryRevision: "commit-a", attempt: 1 });
    expect(fixture.adapter.createReviewer).toHaveBeenCalledWith(expect.objectContaining({ isolatedWorktree: true }));
    expect(fixture.adapter.review).toHaveBeenCalledWith(expect.objectContaining({ threadId: "thread-review", packet: expect.objectContaining({
      goal: "ship safely", successCriteria: ["tests pass"], diff: "diff --git a/a b/a", evidence: expect.objectContaining({ id: evidence.id }) }) }));
    expect(fixture.repositories.activities.get(fixture.activity.id)?.status).toBe("DONE"); fixture.database.close();
  });
  it("rejects same-thread/worktree reviewers and stale evidence", async () => {
    const fixture = setup(); const evidence = await verified(fixture); vi.mocked(fixture.adapter.createReviewer).mockResolvedValue({ threadId: "thread-impl", worktreeId: "worktree-impl" });
    const service = new ReviewService(fixture.repositories, fixture.verification, fixture.adapter, fixture.source);
    await expect(service.request({ projectId: "prj_review", activityId: fixture.activity.id, implementerAgentId: fixture.implementer.id,
      expectedRevision: evidence.activityRevision, repositoryRevision: "commit-a", successCriteria: [] }))
      .rejects.toMatchObject({ code: "INDEPENDENCE_REQUIRED" }); fixture.database.close();
  });
  it("records FIX_REQUIRED and bounds attempts", async () => {
    const fixture = setup("FIX_REQUIRED"); const evidence = await verified(fixture); const service = new ReviewService(fixture.repositories, fixture.verification, fixture.adapter, fixture.source);
    const review = await service.request({ projectId: "prj_review", activityId: fixture.activity.id, implementerAgentId: fixture.implementer.id,
      expectedRevision: evidence.activityRevision, repositoryRevision: "commit-a", successCriteria: ["correct"] });
    expect(review.decision).toBe("FIX_REQUIRED"); expect(fixture.repositories.activities.get(fixture.activity.id)?.status).toBe("FIX_REQUIRED");
    fixture.database.close();

    const bounded = setup(); const boundedEvidence = await verified(bounded);
    const boundedService = new ReviewService(bounded.repositories, bounded.verification, bounded.adapter, bounded.source);
    const now = new Date().toISOString();
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      bounded.repositories.agents.insert({ id: `agt_review_${attempt}`, projectId: "prj_review", activityId: bounded.activity.id,
        role: "reviewer", threadId: `thread-review-${attempt}`, worktreeId: `worktree-review-${attempt}`,
        attempt, status: "COMPLETED", revision: 0, createdAt: now, updatedAt: now });
    }
    await expect(boundedService.request({ projectId: "prj_review", activityId: bounded.activity.id,
      implementerAgentId: bounded.implementer.id, expectedRevision: boundedEvidence.activityRevision,
      repositoryRevision: "commit-a", successCriteria: [] }))
      .rejects.toMatchObject({ code: "REVIEW_LIMIT" }); bounded.database.close();
  });
  it("rejects malformed decisions and restricted context", async () => {
    const fixture = setup(); const evidence = await verified(fixture); const service = new ReviewService(fixture.repositories, fixture.verification, fixture.adapter, fixture.source);
    vi.mocked(fixture.adapter.review).mockResolvedValue({ decision: "looks good" });
    await expect(service.request({ projectId: "prj_review", activityId: fixture.activity.id, implementerAgentId: fixture.implementer.id,
      expectedRevision: evidence.activityRevision, repositoryRevision: "commit-a", successCriteria: [] }))
      .rejects.toMatchObject({ code: "INVALID_DECISION" });
    const key = "-----BEGIN PRIVATE KEY-----\nsecret";
    vi.mocked(fixture.source.loadDiff).mockResolvedValue({ repositoryRevision: "commit-a", diff: key });
    await expect(service.request({ projectId: "prj_review", activityId: fixture.activity.id, implementerAgentId: fixture.implementer.id,
      expectedRevision: evidence.activityRevision, repositoryRevision: "commit-a", successCriteria: [] }))
      .rejects.toMatchObject({ code: "UNSAFE_CONTEXT" }); fixture.database.close();
  });

  it("fails closed when implementer worktree identity is missing", async () => {
    const fixture = setup(); const evidence = await verified(fixture);
    fixture.repositories.agents.update({ ...fixture.implementer, worktreeId: null });
    const service = new ReviewService(fixture.repositories, fixture.verification, fixture.adapter, fixture.source);
    await expect(service.request({ projectId: "prj_review", activityId: fixture.activity.id,
      implementerAgentId: fixture.implementer.id, expectedRevision: evidence.activityRevision,
      repositoryRevision: "commit-a", successCriteria: [] })).rejects.toMatchObject({ code: "UNKNOWN_IMPLEMENTER" });
    expect(fixture.adapter.createReviewer).not.toHaveBeenCalled(); fixture.database.close();
  });

  it("rejects a repository change during review and audits the failed attempt", async () => {
    const fixture = setup(); const evidence = await verified(fixture);
    vi.mocked(fixture.adapter.review).mockImplementation(async () => {
      vi.mocked(fixture.source.loadDiff).mockResolvedValue({ repositoryRevision: "commit-b", diff: "changed" });
      return { decision: "ACCEPTED" };
    });
    const service = new ReviewService(fixture.repositories, fixture.verification, fixture.adapter, fixture.source);
    await expect(service.request({ projectId: "prj_review", activityId: fixture.activity.id,
      implementerAgentId: fixture.implementer.id, expectedRevision: evidence.activityRevision,
      repositoryRevision: "commit-a", successCriteria: [] })).rejects.toMatchObject({ code: "STALE_REVISION" });
    expect(fixture.repositories.reviews.listByProject("prj_review")).toHaveLength(0);
    expect(fixture.repositories.agents.listByProject("prj_review").find((agent) => agent.role === "reviewer")?.status).toBe("FAILED");
    expect(fixture.repositories.auditEvents.listByProject("prj_review").some((event) => event.eventType === "REVIEW_ATTEMPT_FAILED")).toBe(true);
    fixture.database.close();
  });

  it("rejects an activity change while reviewer output is in flight", async () => {
    const fixture = setup(); const evidence = await verified(fixture);
    vi.mocked(fixture.adapter.review).mockImplementation(async () => {
      const now = new Date().toISOString();
      fixture.repositories.approvals.insert({ id: "apr_concurrent", projectId: "prj_review", activityId: fixture.activity.id,
        activityRevision: -1, capability: "network", status: "PENDING", expiresAt: null,
        revision: 0, createdAt: now, updatedAt: now });
      return { decision: "ACCEPTED" };
    });
    const service = new ReviewService(fixture.repositories, fixture.verification, fixture.adapter, fixture.source);
    await expect(service.request({ projectId: "prj_review", activityId: fixture.activity.id,
      implementerAgentId: fixture.implementer.id, expectedRevision: evidence.activityRevision,
      repositoryRevision: "commit-a", successCriteria: [] })).rejects.toMatchObject({ code: "STALE_REVISION" });
    expect(fixture.repositories.reviews.listByProject("prj_review")).toHaveLength(0);
    expect(fixture.repositories.activities.get(fixture.activity.id)?.status).toBe("REVIEWING"); fixture.database.close();
  });

  it("fails and audits the reserved reviewer without partial decisions at review crash boundaries", async () => {
    for (const boundary of ["review", "transition"] as const) {
      const fixture = setup(); const now = new Date().toISOString(); fixture.repositories.approvals.insert({
        id: `apr-${boundary}`, projectId: "prj_review", activityId: fixture.activity.id, activityRevision: -1,
        capability: "network", status: "PENDING", expiresAt: null, revision: 0, createdAt: now, updatedAt: now });
      const evidence = await verified(fixture);
      const service = new ReviewService(fixture.repositories, fixture.verification, fixture.adapter, fixture.source,
        new CrashInjector(boundary));
      await expect(service.request({ projectId: "prj_review", activityId: fixture.activity.id,
        implementerAgentId: fixture.implementer.id, expectedRevision: evidence.activityRevision,
        repositoryRevision: "commit-a", successCriteria: [] })).rejects.toMatchObject({ code: "REVIEW_FAILED" });
      expect(fixture.repositories.reviews.listByProject("prj_review")).toHaveLength(0);
      expect(fixture.repositories.activities.get(fixture.activity.id)?.status).toBe("REVIEWING");
      expect(fixture.repositories.agents.listByProject("prj_review").find((item) => item.role === "reviewer")?.status).toBe("FAILED");
      expect(fixture.repositories.approvals.get(`apr-${boundary}`)?.status).toBe("PENDING");
      fixture.database.close();
    }
  });
});
