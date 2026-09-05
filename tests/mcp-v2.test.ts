import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";

import { authorizeV2Tool, createV2McpServer, type V2ControlPlane } from "../src/mcp/v2.js";
import { ProjectRegistry } from "../src/projects/registry.js";
import { ActivityService } from "../src/activities/service.js";
import { openStateDatabase } from "../src/state/database.js";
import { DomainRepositories } from "../src/state/repository.js";
import { cleanup, makeTmpDir, write } from "./helpers.js";

const directories: string[] = [];
afterEach(() => { vi.restoreAllMocks(); while (directories.length) cleanup(directories.pop()!); });

async function setup() {
  const state = makeTmpDir("c2c-mcp-v2-state"); directories.push(state);
  const root = makeTmpDir("c2c-mcp-v2-project"); directories.push(root);
  write(root, "hello.txt", "safe\n"); write(root, ".env", "SECRET=hidden\n");
  const database = openStateDatabase(path.join(state, "state.sqlite3"));
  const repositories = new DomainRepositories(database);
  const projects = new ProjectRegistry(repositories);
  const project = projects.registerLocal(root);
  const response = (name: string, input: object) => ({ name, input });
  const control: V2ControlPlane = {
    startTask: vi.fn((input) => response("start", input)), getTask: vi.fn((input) => response("get", input)),
    continueTask: vi.fn((input) => response("continue", input)), steerTask: vi.fn((input) => response("steer", input)),
    cancelTask: vi.fn((input) => response("cancel", input)), respondApproval: vi.fn((input) => response("approval", input)),
  };
  const server = createV2McpServer({ projects, repositories, control });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "v2-test", version: "1" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, server, database, project, control, projects, repositories, root };
}

function jsonOf(result: { content?: unknown }): Record<string, any> {
  const content = result.content as Array<{ type: string; text: string }>;
  return JSON.parse(content[0]!.text) as Record<string, any>;
}

describe("V2 MCP data and control planes", () => {
  it("exposes only bounded read tools and high-level task/approval controls", async () => {
    const { client, server, database } = await setup();
    const tools = (await client.listTools()).tools;
    const names = tools.map((tool) => tool.name).sort();
    expect(names).toEqual([
      "c2c_approval_respond", "c2c_task_cancel", "c2c_task_continue", "c2c_task_get", "c2c_task_start", "c2c_task_steer",
      "git_diff", "git_status", "list_directory", "read_file", "search_workspace", "workspace_info",
    ]);
    for (const forbidden of ["shell", "execute_shell", "write_file", "git_commit", "git_push", "delete_file"]) {
      expect(names).not.toContain(forbidden);
    }
    const schemas = JSON.stringify(tools.map((tool) => tool.inputSchema));
    expect(schemas).not.toMatch(/"cwd"|"command"|"absolute_path"/);
    await client.close(); await server.close(); database.close();
  });

  it("resolves project_id for data reads and preserves V1 sensitive-file policy", async () => {
    const { client, server, database, project } = await setup();
    const read = jsonOf(await client.callTool({ name: "read_file", arguments: { project_id: project.projectId, path: "hello.txt" } }));
    expect(read.content).toContain("safe");
    const denied = await client.callTool({ name: "read_file", arguments: { project_id: project.projectId, path: ".env" } });
    expect(denied.isError).toBe(true); expect(jsonOf(denied).error).toBe("ACCESS_DENIED_SENSITIVE_FILE");
    const unknown = await client.callTool({ name: "workspace_info", arguments: { project_id: "missing" } });
    expect(unknown.isError).toBe(true); expect(jsonOf(unknown).error).toBe("UNKNOWN_PROJECT");
    await client.close(); await server.close(); database.close();
  });

  it("validates bounded inputs and delegates normalized control arguments", async () => {
    const { client, server, database, project, control } = await setup();
    const result = jsonOf(await client.callTool({ name: "c2c_task_start", arguments: {
      project_id: project.projectId, goal: "implement", expected_revision: -1, idempotency_key: "request-123",
    } }));
    expect(result.name).toBe("start");
    expect(control.startTask).toHaveBeenCalledWith({
      projectId: project.projectId, goal: "implement", expectedRevision: -1, idempotencyKey: "request-123",
    });
    const oversized = await client.callTool({ name: "c2c_task_start", arguments: {
      project_id: project.projectId, goal: "x".repeat(20_001), expected_revision: -1, idempotency_key: "request-456",
    } });
    expect(oversized.isError).toBe(true);
    const cwd = await client.callTool({ name: "c2c_task_start", arguments: {
      project_id: project.projectId, goal: "x", cwd: "/tmp", expected_revision: -1, idempotency_key: "request-789",
    } });
    expect(cwd.isError).toBe(true);
    await client.close(); await server.close(); database.close();
  });

  it("enforces a distinct scope for each capability", () => {
    const auth = (scopes: string[]) => ({ scopes } as AuthInfo);
    expect(authorizeV2Tool("read_file", auth(["workspace.read"]))).toBe(true);
    expect(authorizeV2Tool("read_file", auth(["task.write"]))).toBe(false);
    expect(authorizeV2Tool("c2c_task_get", auth(["task.read"]))).toBe(true);
    expect(authorizeV2Tool("c2c_task_start", auth(["task.read"]))).toBe(false);
    expect(authorizeV2Tool("c2c_approval_respond", auth(["task.write"]))).toBe(false);
  });

  it("fails closed for replaced roots and cross-project control targets", async () => {
    const { client, server, database, project, projects, repositories, root, control } = await setup();
    const otherRoot = makeTmpDir("c2c-mcp-v2-other"); directories.push(otherRoot);
    const other = projects.registerLocal(otherRoot);
    const activity = new ActivityService(repositories).create({
      projectId: other.projectId, goal: "other", expectedRevision: -1, idempotencyKey: "other-create-1",
    }).activity;
    const crossProject = await client.callTool({ name: "c2c_task_get", arguments: {
      project_id: project.projectId, activity_id: activity.id,
    } });
    expect(crossProject.isError).toBe(true);
    expect(jsonOf(crossProject).error).toBe("UNKNOWN_ACTIVITY");
    expect(control.getTask).not.toHaveBeenCalled();

    const ownActivity = new ActivityService(repositories).create({
      projectId: project.projectId, goal: "own", expectedRevision: -1, idempotencyKey: "own-create-1",
    }).activity;
    const now = new Date().toISOString();
    repositories.approvals.insert({
      id: "apr_other", projectId: other.projectId, activityId: activity.id, activityRevision: 0, capability: "network",
      status: "PENDING", expiresAt: null, revision: 0, createdAt: now, updatedAt: now,
    });
    const crossApproval = await client.callTool({ name: "c2c_approval_respond", arguments: {
      project_id: project.projectId, activity_id: ownActivity.id, approval_id: "apr_other",
      decision: "APPROVE", expected_revision: 0, idempotency_key: "approval-cross-1",
    } });
    expect(crossApproval.isError).toBe(true);
    expect(control.respondApproval).not.toHaveBeenCalled();

    const moved = `${root}-moved`; fs.renameSync(root, moved); directories.push(moved);
    fs.mkdirSync(root); write(root, "hello.txt", "replacement\n");
    const replaced = await client.callTool({ name: "c2c_task_start", arguments: {
      project_id: project.projectId, goal: "x", expected_revision: -1, idempotency_key: "replacement-1",
    } });
    expect(replaced.isError).toBe(true);
    expect(jsonOf(replaced).error).toBe("PROJECT_ROOT_CHANGED");
    expect(control.startTask).not.toHaveBeenCalled();
    await client.close(); await server.close(); database.close();
  });

  it("redacts unexpected control errors", async () => {
    const fixture = await setup();
    const { client, server, database, project, repositories, control } = fixture;
    const activity = new ActivityService(repositories).create({
      projectId: project.projectId, goal: "secret", expectedRevision: -1, idempotencyKey: "secret-create-1",
    }).activity;
    vi.mocked(control.getTask).mockImplementation(() => { throw new Error(`leak ${fixture.root}/token-secret`); });
    const result = await client.callTool({ name: "c2c_task_get", arguments: {
      project_id: project.projectId, activity_id: activity.id,
    } });
    expect(result.isError).toBe(true);
    expect(jsonOf(result)).toEqual({ error: "INTERNAL_ERROR", message: "The operation failed without exposing internal details" });
    expect(JSON.stringify(result)).not.toContain(fixture.root);
    expect(JSON.stringify(result)).not.toContain("token-secret");
    await client.close(); await server.close(); database.close();
  });
});
