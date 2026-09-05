import { createHash, randomBytes } from "node:crypto";

import type { Approval, AuditEvent } from "../domain/types.js";
import type { DomainRepositories } from "../state/repository.js";

export const CAPABILITIES = [
  "sandbox", "network", "secrets", "deployment", "git_push", "production_side_effect",
] as const;
export type Capability = typeof CAPABILITIES[number];
export type PolicyDecision = "ALLOW" | "REQUIRE_APPROVAL" | "DENY";
export interface ApprovalScope { operation: string; resource: string }
export interface TrustedActor { readonly principalId: string; readonly roles: readonly ("requester" | "approver")[] }
export interface AuthenticatedPrincipalResolver {
  resolve(credential: unknown): { principalId: string; roles: readonly ("requester" | "approver")[] } | null;
}
export interface PendingOperationResolver {
  resolve(input: { projectId: string; activityId: string; operationId: string; capability: Capability }): ApprovalScope | null;
}

export class PolicyError extends Error {
  constructor(public readonly code:
    | "DENIED" | "INVALID_CAPABILITY" | "INVALID_SCOPE" | "UNKNOWN_OPERATION" | "UNKNOWN_ACTIVITY"
    | "STALE_REVISION" | "IDEMPOTENCY_CONFLICT" | "UNKNOWN_APPROVAL"
    | "APPROVAL_EXPIRED" | "APPROVAL_RESOLVED" | "UNTRUSTED_ACTOR" | "ACTOR_MISMATCH" | "SCOPE_MISMATCH",
  message: string) {
    super(message);
    this.name = "PolicyError";
  }
}

export class ActorAuthority {
  private readonly issued = new WeakSet<object>();

  constructor(private readonly resolver: AuthenticatedPrincipalResolver) {}

  authenticate(credential: unknown): TrustedActor {
    const principal = this.resolver.resolve(credential);
    const normalized = principal?.principalId.trim() ?? "";
    if (!principal || !normalized || normalized.length > 128 || principal.roles.length === 0) {
      throw new PolicyError("UNTRUSTED_ACTOR", "Authentication failed");
    }
    const actor = Object.freeze({ principalId: normalized, roles: Object.freeze([...new Set(principal.roles)]) });
    this.issued.add(actor);
    return actor;
  }

  require(actor: TrustedActor, role: "requester" | "approver"): void {
    if (!actor || !this.issued.has(actor) || !actor.roles.includes(role)) {
      throw new PolicyError("UNTRUSTED_ACTOR", "Actor is not authenticated for this operation");
    }
  }
}

export class PolicyEngine {
  private readonly decisions: Readonly<Partial<Record<Capability, PolicyDecision>>>;

  constructor(decisions: Partial<Record<Capability, PolicyDecision>> = {}) {
    this.decisions = Object.freeze({ ...decisions });
  }

  evaluate(capability: string): PolicyDecision {
    if (!CAPABILITIES.includes(capability as Capability)) throw new PolicyError("INVALID_CAPABILITY", "Unknown capability");
    return this.decisions[capability as Capability] ?? "DENY";
  }
}

function id(prefix: string): string { return `${prefix}_${randomBytes(16).toString("hex")}`; }
function fingerprint(value: unknown): string {
  const canonical = (item: unknown): unknown => Array.isArray(item) ? item.map(canonical)
    : item && typeof item === "object"
      ? Object.fromEntries(Object.entries(item as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right)).map(([key, child]) => [key, canonical(child)]))
      : item;
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}
function validateScope(scope: ApprovalScope): ApprovalScope {
  const operation = scope.operation.trim(); const resource = scope.resource.trim();
  if (!operation || !resource || operation.length > 128 || resource.length > 512
    || operation.includes("\0") || resource.includes("\0") || operation.includes("*") || resource.includes("*")) {
    throw new PolicyError("INVALID_SCOPE", "Approval scope must identify one exact operation and resource");
  }
  return { operation, resource };
}
function sameScope(left: ApprovalScope | undefined, right: ApprovalScope): boolean {
  return left?.operation === right.operation && left.resource === right.resource;
}

export class ApprovalService {
  static readonly MAX_APPROVAL_TTL_MS = 60 * 60 * 1000;

  constructor(
    private readonly repositories: DomainRepositories,
    private readonly policy: PolicyEngine,
    private readonly authority: ActorAuthority,
    private readonly operations: PendingOperationResolver,
    private readonly now: () => Date = () => new Date(),
  ) {}

  request(input: {
    projectId: string; activityId: string; operationId: string; capability: Capability;
    actor: TrustedActor; expiresAt: string; expectedRevision: number; idempotencyKey: string;
  }): Approval {
    this.authority.require(input.actor, "requester");
    const scope = this.resolveScope(input);
    const requestFingerprint = fingerprint({ ...input, actor: input.actor.principalId, scope });
    return this.repositories.transaction(() => {
      const replay = this.findByKey("requestIdempotencyKey", input.idempotencyKey);
      if (replay) {
        if (replay.requestFingerprint !== requestFingerprint) throw new PolicyError("IDEMPOTENCY_CONFLICT", "Request key was reused");
        return replay;
      }
      const activity = this.requireActivity(input.projectId, input.activityId, input.expectedRevision);
      const decision = this.policy.evaluate(input.capability);
      if (decision === "DENY") throw new PolicyError("DENIED", "Capability is denied by policy");
      const expiresAt = new Date(input.expiresAt);
      const ttl = expiresAt.valueOf() - this.now().valueOf();
      if (Number.isNaN(expiresAt.valueOf()) || ttl <= 0 || ttl > ApprovalService.MAX_APPROVAL_TTL_MS) {
        throw new PolicyError("APPROVAL_EXPIRED", "Approval requires a finite expiry within the maximum TTL");
      }
      const timestamp = this.now().toISOString();
      const approval: Approval = {
        id: id("apr"), projectId: input.projectId, activityId: input.activityId, activityRevision: -1,
        operationId: input.operationId, capability: input.capability,
        status: decision === "ALLOW" ? "APPROVED" : "PENDING", expiresAt: expiresAt.toISOString(),
        requestedBy: input.actor.principalId, scope, requestIdempotencyKey: input.idempotencyKey, requestFingerprint,
        revision: 0, createdAt: timestamp, updatedAt: timestamp,
      };
      this.repositories.approvals.insert(approval);
      const recorded = this.repositories.approvals.get(approval.id)!;
      this.audit(recorded, decision === "ALLOW" ? "CAPABILITY_ALLOWED" : "APPROVAL_REQUESTED",
        input.actor.principalId, activity.revision, recorded.activityRevision);
      return recorded;
    });
  }

  respond(input: {
    projectId: string; activityId: string; approvalId: string; decision: "APPROVE" | "DENY";
    actor: TrustedActor; expectedRevision: number; idempotencyKey: string;
  }): Approval {
    this.authority.require(input.actor, "approver");
    const responseFingerprint = fingerprint({ ...input, actor: input.actor.principalId });
    return this.repositories.transaction(() => {
      const replay = this.findByKey("responseIdempotencyKey", input.idempotencyKey);
      if (replay) {
        if (replay.responseFingerprint !== responseFingerprint) throw new PolicyError("IDEMPOTENCY_CONFLICT", "Response key was reused");
        return replay;
      }
      const activity = this.requireActivity(input.projectId, input.activityId, input.expectedRevision);
      const approval = this.repositories.approvals.get(input.approvalId);
      if (!approval || approval.projectId !== input.projectId || approval.activityId !== input.activityId) {
        throw new PolicyError("UNKNOWN_APPROVAL", "Approval does not belong to this activity");
      }
      if (approval.status !== "PENDING") throw new PolicyError("APPROVAL_RESOLVED", "Approval is already resolved");
      if (approval.requestedBy === input.actor.principalId) throw new PolicyError("ACTOR_MISMATCH", "Requester cannot approve their own request");
      if (!this.isFutureExpiry(approval.expiresAt)) throw new PolicyError("APPROVAL_EXPIRED", "Approval has expired or is invalid");
      const next: Approval = {
        ...approval, status: input.decision === "APPROVE" ? "APPROVED" : "DENIED",
        decidedBy: input.actor.principalId, responseIdempotencyKey: input.idempotencyKey, responseFingerprint,
        revision: approval.revision + 1, updatedAt: this.now().toISOString(),
      };
      if (!this.repositories.approvals.updateExpected(next, approval.revision)) throw new PolicyError("STALE_REVISION", "Approval changed concurrently");
      const recorded = this.repositories.approvals.get(next.id)!;
      this.audit(recorded, `APPROVAL_${recorded.status}`, input.actor.principalId, activity.revision, recorded.activityRevision);
      return recorded;
    });
  }

  authorize(input: {
    projectId: string; activityId: string; operationId: string; capability: Capability;
    actor: TrustedActor; expectedRevision: number; approvalId?: string;
  }): { authorized: true; scope: ApprovalScope } {
    this.authority.require(input.actor, "requester");
    const scope = this.resolveScope(input);
    const activity = this.requireActivity(input.projectId, input.activityId, input.expectedRevision);
    const decision = this.policy.evaluate(input.capability);
    if (decision === "DENY") throw new PolicyError("DENIED", "Capability is denied at use time");
    if (decision === "ALLOW") return { authorized: true, scope };
    const approval = input.approvalId ? this.repositories.approvals.get(input.approvalId) : null;
    if (!approval || approval.projectId !== input.projectId || approval.activityId !== input.activityId
      || approval.operationId !== input.operationId || approval.capability !== input.capability
      || approval.requestedBy !== input.actor.principalId) {
      throw new PolicyError("UNKNOWN_APPROVAL", "No matching approval grant");
    }
    if (approval.status !== "APPROVED") throw new PolicyError("DENIED", "Approval is not granted");
    if (!this.isFutureExpiry(approval.expiresAt)) throw new PolicyError("APPROVAL_EXPIRED", "Approval grant expired or is invalid");
    if (approval.activityRevision !== activity.revision) throw new PolicyError("STALE_REVISION", "Approval grant is stale");
    if (!sameScope(approval.scope, scope)) throw new PolicyError("SCOPE_MISMATCH", "Approval grant scope changed");
    return { authorized: true, scope };
  }

  private resolveScope(input: { projectId: string; activityId: string; operationId: string; capability: Capability }): ApprovalScope {
    const scope = this.operations.resolve(input);
    if (!scope) throw new PolicyError("UNKNOWN_OPERATION", "No trusted pending operation exists");
    return validateScope(scope);
  }

  private requireActivity(projectId: string, activityId: string, expectedRevision: number) {
    const activity = this.repositories.activities.get(activityId);
    if (!activity || activity.projectId !== projectId) throw new PolicyError("UNKNOWN_ACTIVITY", "Unknown activity");
    if (activity.revision !== expectedRevision) throw new PolicyError("STALE_REVISION", "Activity revision changed");
    return activity;
  }

  private isFutureExpiry(value: string | null): boolean {
    if (!value) return false;
    const timestamp = new Date(value).valueOf();
    return Number.isFinite(timestamp) && timestamp > this.now().valueOf();
  }

  private findByKey(field: "requestIdempotencyKey" | "responseIdempotencyKey", value: string): Approval | null {
    const row = this.repositories.database.prepare(`SELECT id FROM approvals WHERE json_extract(payload_json, ?) = ?`)
      .get(`$.${field}`, value) as { id: string } | undefined;
    return row ? this.repositories.approvals.get(row.id) : null;
  }

  private audit(approval: Approval, eventType: string, actor: string, fromRevision: number, toRevision: number): void {
    const event: AuditEvent = {
      id: id("evt"), projectId: approval.projectId, activityId: approval.activityId, eventType, actor,
      fromRevision, toRevision, revision: 0, createdAt: approval.updatedAt, updatedAt: approval.updatedAt,
    };
    this.repositories.auditEvents.insert(event);
  }
}
