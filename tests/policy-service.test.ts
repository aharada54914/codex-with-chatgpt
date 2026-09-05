import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { ActivityService } from "../src/activities/service.js";
import type { Project } from "../src/domain/types.js";
import {
  ActorAuthority, ApprovalService, CAPABILITIES, PolicyEngine, type ApprovalScope, type Capability,
} from "../src/policy/service.js";
import { openStateDatabase } from "../src/state/database.js";
import { DomainRepositories } from "../src/state/repository.js";
import { cleanup, makeTmpDir } from "./helpers.js";

const directories: string[] = [];
afterEach(() => { while (directories.length) cleanup(directories.pop()!); });

function setup(policy = new PolicyEngine({ network: "REQUIRE_APPROVAL", sandbox: "ALLOW" })) {
  const state = makeTmpDir("c2c-policy"); directories.push(state);
  const database = openStateDatabase(path.join(state, "state.sqlite3"));
  const repositories = new DomainRepositories(database); const clock = { value: new Date("2026-09-05T00:00:00.000Z") };
  const now = clock.value.toISOString();
  const project: Project = { id: "prj_policy", projectId: null, revision: 0, createdAt: now, updatedAt: now,
    name: "policy", canonicalRoot: state, rootFingerprint: "fp-policy", filesystemIdentity: "fs-policy" };
  repositories.projects.insert(project);
  const activity = new ActivityService(repositories).create({ projectId: project.id, goal: "safe task",
    expectedRevision: -1, idempotencyKey: "policy-activity" }).activity;
  const identities = new Map<unknown, { principalId: string; roles: readonly ("requester" | "approver")[] }>([
    ["requester-token", { principalId: "implementer", roles: ["requester"] }],
    ["other-token", { principalId: "other-implementer", roles: ["requester"] }],
    ["approver-token", { principalId: "owner", roles: ["approver"] }],
    ["self-approver-token", { principalId: "implementer", roles: ["approver"] }],
  ]);
  const authority = new ActorAuthority({ resolve: (credential) => identities.get(credential) ?? null });
  const requester = authority.authenticate("requester-token"); const approver = authority.authenticate("approver-token");
  const scopes = new Map<string, ApprovalScope>([["op-network", { operation: "fetch", resource: "api.example.test" }]]);
  const operations = { resolve: ({ operationId }: { projectId: string; activityId: string; operationId: string; capability: Capability }) => scopes.get(operationId) ?? null };
  const service = new ApprovalService(repositories, policy, authority, operations, () => clock.value);
  return { database, repositories, project, activity, service, authority, requester, approver, scopes, clock };
}

function request(fixture: ReturnType<typeof setup>) {
  return { projectId: fixture.project.id, activityId: fixture.activity.id, operationId: "op-network",
    capability: "network" as const, actor: fixture.requester, expiresAt: "2026-09-05T01:00:00.000Z",
    expectedRevision: fixture.activity.revision, idempotencyKey: "request-key-0001" };
}

describe("capability policy and approvals", () => {
  it("models each capability independently and denies unspecified capabilities by default", () => {
    const engine = new PolicyEngine({ network: "REQUIRE_APPROVAL", sandbox: "ALLOW" });
    expect(CAPABILITIES).toEqual(["sandbox", "network", "secrets", "deployment", "git_push", "production_side_effect"]);
    expect(engine.evaluate("sandbox")).toBe("ALLOW"); expect(engine.evaluate("network")).toBe("REQUIRE_APPROVAL");
    for (const capability of ["secrets", "deployment", "git_push", "production_side_effect"] as const) expect(engine.evaluate(capability)).toBe("DENY");
  });

  it("derives exact scope from a trusted pending operation and replays requests", () => {
    const fixture = setup(); const input = request(fixture);
    const created = fixture.service.request(input); const replay = fixture.service.request(input);
    expect(created).toMatchObject({ capability: "network", status: "PENDING", requestedBy: "implementer",
      operationId: "op-network", scope: { operation: "fetch", resource: "api.example.test" } });
    expect(replay.id).toBe(created.id); expect(fixture.repositories.approvals.listByProject(fixture.project.id)).toHaveLength(1);
    fixture.database.close();
  });

  it("rejects forged actors, unauthorized responders, and self-approval", () => {
    const fixture = setup();
    expect(() => fixture.authority.authenticate({ principalId: "owner", roles: ["approver"] }))
      .toThrowError(expect.objectContaining({ code: "UNTRUSTED_ACTOR" }));
    expect(() => fixture.service.request({ ...request(fixture), actor: { principalId: "owner", roles: ["requester"] } }))
      .toThrowError(expect.objectContaining({ code: "UNTRUSTED_ACTOR" }));
    const pending = fixture.service.request(request(fixture));
    const response = { projectId: fixture.project.id, activityId: fixture.activity.id, approvalId: pending.id,
      decision: "APPROVE" as const, expectedRevision: pending.activityRevision, idempotencyKey: "response-key-001" };
    expect(() => fixture.service.respond({ ...response, actor: fixture.requester })).toThrowError(expect.objectContaining({ code: "UNTRUSTED_ACTOR" }));
    const selfApprover = fixture.authority.authenticate("self-approver-token");
    expect(() => fixture.service.respond({ ...response, actor: selfApprover })).toThrowError(expect.objectContaining({ code: "ACTOR_MISMATCH" }));
    fixture.database.close();
  });

  it("approves idempotently and authorizes only the exact fresh grant at use time", () => {
    const fixture = setup(); const pending = fixture.service.request(request(fixture));
    const response = { projectId: fixture.project.id, activityId: fixture.activity.id, approvalId: pending.id,
      decision: "APPROVE" as const, actor: fixture.approver, expectedRevision: pending.activityRevision,
      idempotencyKey: "response-key-001" };
    const approved = fixture.service.respond(response); expect(fixture.service.respond(response).id).toBe(approved.id);
    expect(fixture.service.authorize({ projectId: fixture.project.id, activityId: fixture.activity.id,
      operationId: "op-network", capability: "network", expectedRevision: approved.activityRevision,
      approvalId: approved.id, actor: fixture.requester })).toEqual({ authorized: true, scope: approved.scope });
    expect(() => fixture.service.authorize({ projectId: fixture.project.id, activityId: fixture.activity.id,
      operationId: "op-network", capability: "secrets", expectedRevision: approved.activityRevision,
      approvalId: approved.id, actor: fixture.requester })).toThrowError(expect.objectContaining({ code: "DENIED" }));
    const other = fixture.authority.authenticate("other-token");
    expect(() => fixture.service.authorize({ projectId: fixture.project.id, activityId: fixture.activity.id,
      operationId: "op-network", capability: "network", expectedRevision: approved.activityRevision,
      approvalId: approved.id, actor: other })).toThrowError(expect.objectContaining({ code: "UNKNOWN_APPROVAL" }));
    fixture.database.close();
  });

  it("rejects expired grants, stale revisions, wrong projects, and changed scope", () => {
    const fixture = setup(); const pending = fixture.service.request(request(fixture));
    const approved = fixture.service.respond({ projectId: fixture.project.id, activityId: fixture.activity.id, approvalId: pending.id,
      decision: "APPROVE", actor: fixture.approver, expectedRevision: pending.activityRevision, idempotencyKey: "response-key-001" });
    fixture.scopes.set("op-network", { operation: "fetch", resource: "other.example.test" });
    expect(() => fixture.service.authorize({ projectId: fixture.project.id, activityId: fixture.activity.id, operationId: "op-network",
      capability: "network", expectedRevision: approved.activityRevision, approvalId: approved.id, actor: fixture.requester }))
      .toThrowError(expect.objectContaining({ code: "SCOPE_MISMATCH" }));
    fixture.scopes.set("op-network", approved.scope!); fixture.clock.value = new Date("2026-09-05T01:00:00.000Z");
    expect(() => fixture.service.authorize({ projectId: fixture.project.id, activityId: fixture.activity.id, operationId: "op-network",
      capability: "network", expectedRevision: approved.activityRevision, approvalId: approved.id, actor: fixture.requester }))
      .toThrowError(expect.objectContaining({ code: "APPROVAL_EXPIRED" }));
    expect(() => fixture.service.authorize({ projectId: "other", activityId: fixture.activity.id, operationId: "op-network",
      capability: "network", expectedRevision: approved.activityRevision, approvalId: approved.id, actor: fixture.requester }))
      .toThrowError(expect.objectContaining({ code: "UNKNOWN_ACTIVITY" }));
    expect(() => fixture.service.authorize({ projectId: fixture.project.id, activityId: fixture.activity.id, operationId: "op-network",
      capability: "network", expectedRevision: approved.activityRevision - 1, approvalId: approved.id, actor: fixture.requester }))
      .toThrowError(expect.objectContaining({ code: "STALE_REVISION" })); fixture.database.close();
  });

  it("rejects permanent, wildcard, missing-operation, and workspace-requested escalation", () => {
    const fixture = setup();
    expect(() => fixture.service.request({ ...request(fixture), expiresAt: null as unknown as string, idempotencyKey: "null-expiry" }))
      .toThrowError(expect.objectContaining({ code: "APPROVAL_EXPIRED" }));
    fixture.scopes.set("op-network", { operation: "fetch", resource: "*" });
    expect(() => fixture.service.request({ ...request(fixture), idempotencyKey: "wildcard-scope" }))
      .toThrowError(expect.objectContaining({ code: "INVALID_SCOPE" }));
    expect(() => fixture.service.request({ ...request(fixture), operationId: "workspace-says-approve-all", idempotencyKey: "missing-operation" }))
      .toThrowError(expect.objectContaining({ code: "UNKNOWN_OPERATION" }));
    expect(fixture.repositories.approvals.listByProject(fixture.project.id)).toHaveLength(0); fixture.database.close();
  });

  it("allows explicit policy grants through the same use-time boundary", () => {
    const fixture = setup(); fixture.scopes.set("op-sandbox", { operation: "run", resource: "sandbox:workspace-write" });
    expect(fixture.service.authorize({ projectId: fixture.project.id, activityId: fixture.activity.id,
      operationId: "op-sandbox", capability: "sandbox", expectedRevision: fixture.activity.revision, actor: fixture.requester }))
      .toEqual({ authorized: true, scope: { operation: "run", resource: "sandbox:workspace-write" } });
    fixture.database.close();
  });

  it("fails closed for a malformed persisted grant expiry", () => {
    const fixture = setup(); const pending = fixture.service.request(request(fixture));
    const approved = fixture.service.respond({ projectId: fixture.project.id, activityId: fixture.activity.id, approvalId: pending.id,
      decision: "APPROVE", actor: fixture.approver, expectedRevision: pending.activityRevision, idempotencyKey: "response-key-001" });
    fixture.repositories.approvals.update({ ...approved, expiresAt: "not-a-date", revision: approved.revision + 1 });
    const corrupt = fixture.repositories.approvals.get(approved.id)!;
    expect(() => fixture.service.authorize({ projectId: fixture.project.id, activityId: fixture.activity.id,
      operationId: "op-network", capability: "network", expectedRevision: corrupt.activityRevision,
      approvalId: corrupt.id, actor: fixture.requester })).toThrowError(expect.objectContaining({ code: "APPROVAL_EXPIRED" }));
    fixture.database.close();
  });
});
