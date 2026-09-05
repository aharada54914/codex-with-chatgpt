export type IsoTimestamp = string;

export interface DomainRecord {
  id: string;
  projectId: string | null;
  revision: number;
  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
}

export interface Project extends DomainRecord {
  projectId: null;
  name: string;
  /** Local-only canonical path. Never include this field in control-plane projections. */
  canonicalRoot: string;
  rootFingerprint: string;
  filesystemIdentity: string;
}
export type ActivityStatus =
  | "INTAKE" | "PLANNING" | "READY" | "DISPATCHED" | "EXECUTING"
  | "VERIFYING" | "REVIEWING" | "FIX_REQUIRED"
  | "DONE" | "BLOCKED" | "CANCELLED" | "FAILED" | "RECOVERY_REQUIRED";

export interface Activity extends DomainRecord { goal: string; status: ActivityStatus; }
export interface Agent extends DomainRecord { activityId: string; role: "implementer" | "reviewer"; threadId: string | null; }
export interface Job extends DomainRecord { activityId: string; kind: string; status: string; }
export interface Approval extends DomainRecord { activityId: string; activityRevision: number; capability: string; status: string; expiresAt: IsoTimestamp | null; }
export interface Evidence extends DomainRecord { activityId: string; activityRevision: number; kind: string; repositoryRevision: string; status: string; }
export interface Review extends DomainRecord { activityId: string; activityRevision: number; reviewerAgentId: string; decision: string; }
export interface Operation extends DomainRecord {
  activityId: string;
  idempotencyKey: string;
  operationType: string;
  requestFingerprint: string;
  status: "COMPLETED";
  resultActivity: Activity;
}
export interface AuditEvent extends DomainRecord {
  activityId: string | null;
  eventType: string;
  actor: string;
  fromRevision: number;
  toRevision: number;
}

export type DomainRecordByKind = {
  projects: Project;
  activities: Activity;
  agents: Agent;
  jobs: Job;
  approvals: Approval;
  evidence: Evidence;
  reviews: Review;
  operations: Operation;
  audit_events: AuditEvent;
};

export type DomainKind = keyof DomainRecordByKind;
