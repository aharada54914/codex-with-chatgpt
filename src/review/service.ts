import { createHash, randomBytes } from "node:crypto";

import { ActivityService } from "../activities/service.js";
import type { Agent, AuditEvent, Review } from "../domain/types.js";
import { sanitizeExecutionOutput } from "../execution/sanitize.js";
import type { DomainRepositories } from "../state/repository.js";
import type { WorkflowCheckpoints } from "../recovery/checkpoints.js";
import type { VerificationEvidence, VerificationService } from "../verification/service.js";

export type ReviewDecision = "ACCEPTED" | "FIX_REQUIRED";
export interface ReviewPacket {
  activityId: string;
  activityRevision: number;
  repositoryRevision: string;
  goal: string;
  successCriteria: string[];
  diff: string;
  evidence: object;
}
export interface ReviewerAdapter {
  createReviewer(input: { projectId: string; activityId: string; isolatedWorktree: true }): Promise<{ threadId: string; worktreeId: string }>;
  review(input: { threadId: string; packet: ReviewPacket }): Promise<unknown>;
}
export interface ReviewSource {
  loadDiff(projectId: string): Promise<{ repositoryRevision: string; diff: string }>;
}

export type ReviewErrorCode =
  | "UNKNOWN_IMPLEMENTER" | "STALE_REVISION" | "INDEPENDENCE_REQUIRED"
  | "UNSAFE_CONTEXT" | "INVALID_DECISION" | "REVIEW_FAILED" | "REVIEW_LIMIT";

export class ReviewError extends Error {
  constructor(public readonly code: ReviewErrorCode, message: string) {
    super(message);
    this.name = "ReviewError";
  }
}

function id(prefix: string): string { return `${prefix}_${randomBytes(16).toString("hex")}`; }
function bounded(value: string, max: number): string {
  const sanitized = sanitizeExecutionOutput(value);
  if (!sanitized.allowed) throw new ReviewError("UNSAFE_CONTEXT", "Review context contains restricted material");
  return sanitized.text.slice(0, max);
}

export class ReviewService {
  static readonly MAX_ATTEMPTS = 3;

  constructor(
    private readonly repositories: DomainRepositories,
    private readonly verification: VerificationService,
    private readonly adapter: ReviewerAdapter,
    private readonly source: ReviewSource,
    private readonly checkpoints: WorkflowCheckpoints = { checkpoint: () => undefined },
  ) {}

  async request(input: {
    projectId: string;
    activityId: string;
    implementerAgentId: string;
    expectedRevision: number;
    repositoryRevision: string;
    successCriteria: string[];
  }): Promise<Review> {
    const activity = this.repositories.activities.get(input.activityId);
    if (!activity || activity.projectId !== input.projectId || activity.revision !== input.expectedRevision
      || activity.status !== "REVIEWING") {
      throw new ReviewError("STALE_REVISION", "Activity is unavailable, changed, or not awaiting review");
    }
    const implementer = this.repositories.agents.get(input.implementerAgentId);
    if (!implementer || implementer.projectId !== input.projectId || implementer.activityId !== input.activityId
      || implementer.role !== "implementer" || !implementer.threadId || !implementer.worktreeId) {
      throw new ReviewError("UNKNOWN_IMPLEMENTER", "A thread- and worktree-bound implementer agent is required");
    }

    const evidence = this.requireEvidence(input);
    const source = await this.source.loadDiff(input.projectId);
    if (source.repositoryRevision !== input.repositoryRevision) {
      throw new ReviewError("STALE_REVISION", "Diff does not belong to the requested repository revision");
    }
    const packet: ReviewPacket = {
      activityId: activity.id,
      activityRevision: activity.revision,
      repositoryRevision: bounded(source.repositoryRevision, 128),
      goal: bounded(activity.goal, 20_000),
      successCriteria: input.successCriteria.slice(0, 50).map((item) => bounded(item, 1000)),
      diff: bounded(source.diff, 64 * 1024),
      evidence: {
        id: evidence.id,
        status: evidence.status,
        repositoryRevision: evidence.repositoryRevision,
        checks: evidence.checks,
      },
    };
    const reviewer = this.reserveAttempt(input.projectId, input.activityId, packet.activityRevision);

    try {
      const created = await this.adapter.createReviewer({
        projectId: input.projectId,
        activityId: input.activityId,
        isolatedWorktree: true,
      });
      if (!created.threadId || !created.worktreeId || created.threadId === implementer.threadId
        || created.worktreeId === implementer.worktreeId) {
        throw new ReviewError("INDEPENDENCE_REQUIRED", "Reviewer must use a distinct thread and worktree");
      }
      this.bindReviewer(reviewer, created);
      const raw = await this.adapter.review({ threadId: created.threadId, packet });
      this.checkpoints.checkpoint("review");
      const decision = (raw as { decision?: unknown })?.decision;
      if (decision !== "ACCEPTED" && decision !== "FIX_REQUIRED") {
        throw new ReviewError("INVALID_DECISION", "Reviewer returned an invalid decision");
      }

      const freshEvidence = this.requireEvidence(input);
      const freshSource = await this.source.loadDiff(input.projectId);
      if (freshEvidence.id !== evidence.id
        || this.repositories.activities.get(input.activityId)?.revision !== packet.activityRevision
        || freshSource.repositoryRevision !== packet.repositoryRevision
        || bounded(freshSource.diff, 64 * 1024) !== packet.diff) {
        throw new ReviewError("STALE_REVISION", "Review inputs changed while review was running");
      }
      return this.commitDecision(reviewer.id, packet, evidence, decision);
    } catch (error) {
      this.failAttempt(reviewer.id);
      if (error instanceof ReviewError) throw error;
      throw new ReviewError("REVIEW_FAILED", "Reviewer execution failed");
    }
  }

  private requireEvidence(input: {
    projectId: string;
    activityId: string;
    repositoryRevision: string;
  }): VerificationEvidence {
    try {
      return this.verification.assertAcceptable(input);
    } catch {
      throw new ReviewError("STALE_REVISION", "Fresh verification evidence is required");
    }
  }

  private reserveAttempt(projectId: string, activityId: string, expectedRevision: number): Agent {
    return this.repositories.transaction(() => {
      if (this.repositories.activities.get(activityId)?.revision !== expectedRevision) {
        throw new ReviewError("STALE_REVISION", "Activity changed before review reservation");
      }
      const attempts = this.repositories.agents.listByProject(projectId)
        .filter((item) => item.activityId === activityId && item.role === "reviewer");
      if (attempts.length >= ReviewService.MAX_ATTEMPTS) {
        throw new ReviewError("REVIEW_LIMIT", "Maximum review attempts reached");
      }
      const attempt = Math.max(0, ...attempts.map((item) => item.attempt ?? 0)) + 1;
      const now = new Date().toISOString();
      const reviewer: Agent = {
        id: id("agt"), projectId, activityId, role: "reviewer", threadId: null, worktreeId: null,
        attempt, status: "RUNNING", revision: 0, createdAt: now, updatedAt: now,
      };
      try {
        this.repositories.agents.insert(reviewer);
      } catch {
        throw new ReviewError("REVIEW_LIMIT", "A concurrent review attempt already reserved this slot");
      }
      return reviewer;
    });
  }

  private bindReviewer(reviewer: Agent, created: { threadId: string; worktreeId: string }): void {
    const next: Agent = {
      ...reviewer, ...created, revision: reviewer.revision + 1, updatedAt: new Date().toISOString(),
    };
    if (!this.repositories.agents.updateExpected(next, reviewer.revision)) {
      throw new ReviewError("STALE_REVISION", "Reviewer reservation changed");
    }
    Object.assign(reviewer, next);
  }

  private commitDecision(
    reviewerId: string,
    packet: ReviewPacket,
    evidence: VerificationEvidence,
    decision: ReviewDecision,
  ): Review {
    return this.repositories.transaction(() => {
      if (this.repositories.activities.get(packet.activityId)?.revision !== packet.activityRevision) {
        throw new ReviewError("STALE_REVISION", "Activity changed while review was being committed");
      }
      const reviewer = this.repositories.agents.get(reviewerId);
      if (!reviewer || reviewer.status !== "RUNNING" || reviewer.attempt === undefined) {
        throw new ReviewError("STALE_REVISION", "Reviewer attempt is unavailable");
      }
      const now = new Date().toISOString();
      const completed: Agent = { ...reviewer, status: "COMPLETED", revision: reviewer.revision + 1, updatedAt: now };
      if (!this.repositories.agents.updateExpected(completed, reviewer.revision)) {
        throw new ReviewError("STALE_REVISION", "Reviewer attempt changed");
      }
      const draft: Review = {
        id: id("rev"), projectId: reviewer.projectId, activityId: packet.activityId, activityRevision: -1,
        reviewerAgentId: reviewer.id, decision, evidenceId: evidence.id,
        repositoryRevision: evidence.repositoryRevision, attempt: reviewer.attempt,
        inputFingerprint: createHash("sha256").update(JSON.stringify(packet)).digest("hex"),
        revision: 0, createdAt: now, updatedAt: now,
      };
      this.repositories.reviews.insert(draft);
      const recorded = this.repositories.reviews.get(draft.id)!;
      this.checkpoints.checkpoint("transition");
      new ActivityService(this.repositories).transition({
        activityId: packet.activityId,
        to: decision === "ACCEPTED" ? "DONE" : "FIX_REQUIRED",
        expectedRevision: recorded.activityRevision,
        idempotencyKey: `review:${recorded.id}`,
        actor: reviewer.id,
      });
      return recorded;
    });
  }

  private failAttempt(reviewerId: string): void {
    try {
      this.repositories.transaction(() => {
        const reviewer = this.repositories.agents.get(reviewerId);
        if (!reviewer || reviewer.status !== "RUNNING") return;
        const now = new Date().toISOString();
        const failed: Agent = { ...reviewer, status: "FAILED", revision: reviewer.revision + 1, updatedAt: now };
        if (!this.repositories.agents.updateExpected(failed, reviewer.revision)) return;
        const activity = this.repositories.activities.get(reviewer.activityId);
        const event: AuditEvent = {
          id: id("evt"), projectId: reviewer.projectId, activityId: reviewer.activityId,
          eventType: "REVIEW_ATTEMPT_FAILED", actor: reviewer.id,
          fromRevision: activity?.revision ?? -1, toRevision: activity?.revision ?? -1,
          revision: 0, createdAt: now, updatedAt: now,
        };
        this.repositories.auditEvents.insert(event);
      });
    } catch {
      // Preserve the original reviewer error. A RUNNING reservation remains recoverable.
    }
  }
}
