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
export interface Activity extends DomainRecord { goal: string; status: string; }
export interface Agent extends DomainRecord { activityId: string; role: "implementer" | "reviewer"; threadId: string | null; }
export interface Job extends DomainRecord { activityId: string; kind: string; status: string; }
export interface Approval extends DomainRecord { activityId: string; capability: string; status: string; expiresAt: IsoTimestamp | null; }
export interface Evidence extends DomainRecord { activityId: string; kind: string; repositoryRevision: string; status: string; }
export interface Review extends DomainRecord { activityId: string; reviewerAgentId: string; decision: string; }
export interface Operation extends DomainRecord { activityId: string; idempotencyKey: string; status: string; }
export interface AuditEvent extends DomainRecord { activityId: string | null; eventType: string; actor: string; }

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
