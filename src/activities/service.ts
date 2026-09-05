import { createHash, randomBytes } from "node:crypto";

import type { Activity, ActivityStatus, AuditEvent, Operation } from "../domain/types.js";
import type { DomainRepositories } from "../state/repository.js";

export type ActivityErrorCode =
  | "UNKNOWN_ACTIVITY" | "UNKNOWN_PROJECT" | "INVALID_TRANSITION"
  | "STALE_REVISION" | "IDEMPOTENCY_CONFLICT" | "INVALID_EXPECTED_REVISION";

export class ActivityError extends Error {
  constructor(
    public readonly code: ActivityErrorCode,
    message: string,
    public readonly currentRevision?: number,
  ) {
    super(message);
    this.name = "ActivityError";
  }
}

export interface MutationResult { activity: Activity; replayed: boolean }

const TERMINAL = new Set<ActivityStatus>(["DONE", "BLOCKED", "CANCELLED", "FAILED", "RECOVERY_REQUIRED"]);
const TRANSITIONS: Readonly<Record<ActivityStatus, readonly ActivityStatus[]>> = {
  INTAKE: ["PLANNING", "BLOCKED", "CANCELLED", "FAILED"],
  PLANNING: ["READY", "BLOCKED", "CANCELLED", "FAILED"],
  READY: ["DISPATCHED", "BLOCKED", "CANCELLED", "FAILED"],
  DISPATCHED: ["EXECUTING", "CANCELLED", "FAILED", "RECOVERY_REQUIRED"],
  EXECUTING: ["VERIFYING", "CANCELLED", "FAILED", "RECOVERY_REQUIRED"],
  VERIFYING: ["REVIEWING", "EXECUTING", "BLOCKED", "CANCELLED", "FAILED", "RECOVERY_REQUIRED"],
  REVIEWING: ["DONE", "FIX_REQUIRED", "BLOCKED", "CANCELLED", "FAILED", "RECOVERY_REQUIRED"],
  FIX_REQUIRED: ["EXECUTING", "BLOCKED", "CANCELLED", "FAILED", "RECOVERY_REQUIRED"],
  DONE: [], BLOCKED: [], CANCELLED: [], FAILED: [], RECOVERY_REQUIRED: [],
};

function fingerprint(value: unknown): string {
  const canonicalize = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(canonicalize);
    if (item && typeof item === "object") {
      return Object.fromEntries(
        Object.entries(item as Record<string, unknown>)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, child]) => [key, canonicalize(child)]),
      );
    }
    return item;
  };
  return createHash("sha256").update(JSON.stringify(canonicalize(value))).digest("hex");
}

function id(prefix: string): string {
  return `${prefix}_${randomBytes(16).toString("hex")}`;
}

export class ActivityService {
  constructor(private readonly repositories: DomainRepositories) {}

  create(input: {
    projectId: string; goal: string; expectedRevision: -1; idempotencyKey: string;
  }): MutationResult {
    const request = fingerprint({ type: "CREATE", ...input });
    return this.repositories.transaction(() => {
      const replay = this.replay(input.idempotencyKey, request);
      if (replay) return replay;
      if (input.expectedRevision !== -1) {
        throw new ActivityError("INVALID_EXPECTED_REVISION", "Activity creation requires expected_revision -1");
      }
      if (!this.repositories.projects.get(input.projectId)) {
        throw new ActivityError("UNKNOWN_PROJECT", `Unknown project_id: ${input.projectId}`);
      }
      const now = new Date().toISOString();
      const activity: Activity = {
        id: id("act"), projectId: input.projectId, revision: 0, createdAt: now, updatedAt: now,
        goal: input.goal, status: "INTAKE",
      };
      this.repositories.activities.insert(activity);
      this.recordAudit(activity, "ACTIVITY_CREATED", "caller", -1, 0);
      this.recordOperation(activity, "CREATE", input.idempotencyKey, request);
      return { activity, replayed: false };
    });
  }

  transition(input: {
    activityId: string; to: ActivityStatus; expectedRevision: number; idempotencyKey: string; actor: string;
  }): MutationResult {
    return this.mutate("TRANSITION", input, "NORMAL");
  }

  cancel(input: {
    activityId: string; expectedRevision: number; idempotencyKey: string; actor: string;
  }): MutationResult {
    return this.mutate("CANCEL", { ...input, to: "CANCELLED" }, "NORMAL");
  }

  reconcileAfterRestart(input: {
    activityId: string; observation: "RUNNING" | "COMPLETED" | "FAILED" | "UNKNOWN";
    expectedRevision: number; idempotencyKey: string; actor: string;
  }): MutationResult {
    return this.mutate("RECONCILE", input, "RECONCILE");
  }

  private mutate(
    operationType: string,
    input: {
      activityId: string; to?: ActivityStatus; expectedRevision: number; idempotencyKey: string; actor: string;
      observation?: "RUNNING" | "COMPLETED" | "FAILED" | "UNKNOWN";
    },
    mode: "NORMAL" | "RECONCILE",
  ): MutationResult {
    const request = fingerprint({ type: operationType, ...input });
    return this.repositories.transaction(() => {
      const replay = this.replay(input.idempotencyKey, request);
      if (replay) return replay;
      const current = this.requireActivity(input.activityId);
      if (current.revision !== input.expectedRevision) {
        throw new ActivityError(
          "STALE_REVISION",
          `STALE_REVISION: expected ${input.expectedRevision}, current ${current.revision}`,
          current.revision,
        );
      }
      let target = input.to;
      if (mode === "RECONCILE") {
        if (TERMINAL.has(current.status)) {
          throw new ActivityError("INVALID_TRANSITION", `terminal state: ${current.status}`);
        }
        switch (input.observation) {
          case "UNKNOWN": target = "RECOVERY_REQUIRED"; break;
          case "FAILED": target = "FAILED"; break;
          case "COMPLETED":
            target = current.status === "DISPATCHED" || current.status === "EXECUTING"
              ? "VERIFYING" : "RECOVERY_REQUIRED";
            break;
          case "RUNNING":
            target = current.status === "DISPATCHED" || current.status === "EXECUTING"
              ? "EXECUTING" : "RECOVERY_REQUIRED";
            break;
          default:
            throw new ActivityError("INVALID_TRANSITION", "Invalid restart observation");
        }
      }
      if (!target) throw new ActivityError("INVALID_TRANSITION", "A target state is required");
      const legal = mode === "RECONCILE"
        ? !TERMINAL.has(current.status)
        : current.status !== target && TRANSITIONS[current.status].includes(target);
      if (!legal) {
        const terminal = TERMINAL.has(current.status) ? "terminal state" : "illegal transition";
        throw new ActivityError("INVALID_TRANSITION", `${terminal}: ${current.status} -> ${target}`);
      }
      const next: Activity = {
        ...current, status: target, revision: current.revision + 1, updatedAt: new Date().toISOString(),
      };
      if (!this.repositories.activities.updateExpected(next, input.expectedRevision)) {
        const latest = this.requireActivity(input.activityId);
        throw new ActivityError("STALE_REVISION", `STALE_REVISION: current ${latest.revision}`, latest.revision);
      }
      const event = target === "CANCELLED" ? "ACTIVITY_CANCELLED" : `ACTIVITY_${target}`;
      this.recordAudit(next, event, input.actor, current.revision, next.revision);
      this.recordOperation(next, operationType, input.idempotencyKey, request);
      return { activity: next, replayed: false };
    });
  }

  private requireActivity(activityId: string): Activity {
    const activity = this.repositories.activities.get(activityId);
    if (!activity) throw new ActivityError("UNKNOWN_ACTIVITY", `Unknown activity: ${activityId}`);
    return activity;
  }

  private replay(idempotencyKey: string, requestFingerprint: string): MutationResult | null {
    const existing = this.repositories.findOperationByIdempotencyKey(idempotencyKey);
    if (!existing) return null;
    if (existing.requestFingerprint !== requestFingerprint) {
      throw new ActivityError("IDEMPOTENCY_CONFLICT", "Idempotency key was already used for a different request");
    }
    return { activity: existing.resultActivity, replayed: true };
  }

  private recordOperation(activity: Activity, operationType: string, idempotencyKey: string, requestFingerprint: string): void {
    const operation: Operation = {
      id: id("op"), projectId: activity.projectId, revision: 0,
      createdAt: activity.updatedAt, updatedAt: activity.updatedAt,
      activityId: activity.id, idempotencyKey, operationType, requestFingerprint,
      status: "COMPLETED", resultActivity: activity,
    };
    this.repositories.operations.insert(operation);
  }

  private recordAudit(activity: Activity, eventType: string, actor: string, fromRevision: number, toRevision: number): void {
    const event: AuditEvent = {
      id: id("evt"), projectId: activity.projectId, revision: 0,
      createdAt: activity.updatedAt, updatedAt: activity.updatedAt,
      activityId: activity.id, eventType, actor, fromRevision, toRevision,
    };
    this.repositories.auditEvents.insert(event);
  }
}
