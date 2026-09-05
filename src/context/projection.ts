import type { Activity, ActivityStatus, AuditEvent, Evidence, Review } from "../domain/types.js";
import { sanitizeExecutionOutput } from "../execution/sanitize.js";
import type { DomainRepositories } from "../state/repository.js";

export type ProjectionView = "compact" | "standard" | "debug";

export type ActivityProjection =
  | { activityId: string; status: ActivityStatus; revision: number; unchanged: true }
  | {
      activityId: string;
      status: ActivityStatus;
      revision: number;
      unchanged: false;
      phase: string;
      requiredAction: "NONE" | "APPROVAL" | "RECOVERY";
      changedFiles?: string[];
      verification?: Array<{ kind: string; status: string; repositoryRevision: string }>;
      review?: { decision: string } | null;
      events?: Array<{ type: string; actor: string; fromRevision: number; toRevision: number; timestamp: string }>;
      evidence?: Array<{ id: string; kind: string; status: string; repositoryRevision: string }>;
    };

export class ProjectionError extends Error {
  constructor(public readonly code: "UNKNOWN_ACTIVITY" | "PROJECT_MISMATCH", message: string) {
    super(message);
    this.name = "ProjectionError";
  }
}

const MAX_CHANGED_FILES = 100;
const MAX_EVENTS = 50;
const MAX_EVIDENCE = 50;

function safeText(value: unknown, maxLength: number): string {
  const withoutPaths = String(value)
    .replace(/(?:[A-Za-z]:\\|\/)(?:[^\s"'`]+[\\/])*[^\s"'`]*/g, "[PATH]")
    .replace(/\\[^\s"'`]+/g, "[PATH]");
  const sanitized = sanitizeExecutionOutput(withoutPaths);
  if (!sanitized.allowed) return "[RESTRICTED]";
  return sanitized.text.slice(0, maxLength);
}

function safeRelativePath(value: string): string | null {
  const sanitized = sanitizeExecutionOutput(value);
  if (!sanitized.allowed) return null;
  return `workspace:/${sanitized.text.slice(0, 512)}`;
}

function actionFor(status: ActivityStatus, hasPendingApproval: boolean): "NONE" | "APPROVAL" | "RECOVERY" {
  if (status === "RECOVERY_REQUIRED") return "RECOVERY";
  if (hasPendingApproval) return "APPROVAL";
  return "NONE";
}

function changedFiles(evidence: Evidence[]): string[] {
  const values = evidence.flatMap((item) => {
    const candidate = (item as Evidence & { changedFiles?: unknown }).changedFiles;
    return Array.isArray(candidate) ? candidate : [];
  });
  return [...new Set(values.flatMap((value) => {
    const candidate = String(value).replace(/\\/g, "/");
    if (!candidate || candidate.startsWith("/") || /^[A-Za-z]:\//.test(candidate)) return [];
    const parts = candidate.split("/");
    if (parts.some((part) => part === ".." || part === "")) return [];
    const projected = safeRelativePath(candidate);
    return projected ? [projected] : [];
  }))].slice(0, MAX_CHANGED_FILES);
}

function latestReview(reviews: Review[]): Review | null {
  return reviews.reduce<Review | null>((latest, review) =>
    !latest || review.updatedAt > latest.updatedAt ? review : latest, null);
}

export class ContextProjector {
  constructor(private readonly repositories: DomainRepositories) {}

  project(input: {
    projectId: string;
    activityId: string;
    view?: ProjectionView;
    sinceRevision?: number;
  }): ActivityProjection {
    const activity = this.repositories.activities.get(input.activityId);
    if (!activity) throw new ProjectionError("UNKNOWN_ACTIVITY", "Unknown activity");
    if (activity.projectId !== input.projectId) throw new ProjectionError("PROJECT_MISMATCH", "Activity does not belong to project");
    const approvals = this.repositories.approvals.listByProject(input.projectId)
      .filter((approval) => approval.activityId === activity.id && Number.isInteger(approval.activityRevision));
    const allEvidence = this.repositories.evidence.listByProject(input.projectId)
      .filter((item) => item.activityId === activity.id && Number.isInteger(item.activityRevision));
    const allReviews = this.repositories.reviews.listByProject(input.projectId)
      .filter((item) => item.activityId === activity.id && Number.isInteger(item.activityRevision));
    const allEvents = this.repositories.auditEvents.listByProject(input.projectId)
      .filter((event) => event.activityId === activity.id);
    // SQLite triggers atomically advance this authoritative cursor whenever an
    // approval, evidence, or review changes. ActivityService owns status bumps.
    const projectionRevision = activity.revision;
    if (input.sinceRevision !== undefined && input.sinceRevision >= projectionRevision) {
      return { activityId: activity.id, status: activity.status, revision: projectionRevision, unchanged: true };
    }

    const view = input.view ?? "compact";
    const base: Exclude<ActivityProjection, { unchanged: true }> = {
      activityId: activity.id,
      status: activity.status,
      revision: projectionRevision,
      unchanged: false,
      phase: activity.status.toLowerCase(),
      requiredAction: actionFor(activity.status, approvals.some((approval) => approval.status === "PENDING")),
    };
    if (view === "compact") return base;

    const evidence = allEvidence.filter((item) => input.sinceRevision === undefined || item.activityRevision > input.sinceRevision);
    const reviews = allReviews.filter((item) => input.sinceRevision === undefined || item.activityRevision > input.sinceRevision);
    const review = latestReview(reviews);
    base.changedFiles = changedFiles(evidence);
    base.verification = evidence.slice(-MAX_EVIDENCE).map((item) => ({
      kind: safeText(item.kind, 128), status: safeText(item.status, 64),
      repositoryRevision: safeText(item.repositoryRevision, 128),
    }));
    base.review = review ? { decision: safeText(review.decision, 64) } : null;
    if (view === "standard") return base;

    const events = allEvents
      .filter((event) => input.sinceRevision === undefined || event.toRevision > input.sinceRevision)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
      .slice(-MAX_EVENTS);
    base.events = events.map((event: AuditEvent) => ({
      type: safeText(event.eventType, 128), actor: safeText(event.actor, 128),
      fromRevision: event.fromRevision, toRevision: event.toRevision, timestamp: safeText(event.createdAt, 64),
    }));
    base.evidence = evidence.slice(-MAX_EVIDENCE).map((item) => ({
      id: safeText(item.id, 128), kind: safeText(item.kind, 128), status: safeText(item.status, 64),
      repositoryRevision: safeText(item.repositoryRevision, 128),
    }));
    return base;
  }
}
