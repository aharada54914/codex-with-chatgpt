import { z } from "zod";

import type { InitializeParams } from "./protocol/index.js";
import type { AskForApproval, ErrorNotification, Thread, ThreadItem, Turn } from "./protocol/v2/index.js";

const clientInfoSchema = z.object({
  name: z.string().min(1),
  title: z.string().nullable(),
  version: z.string().min(1),
}).strict();

const initializeParamsSchema = z.object({
  clientInfo: clientInfoSchema,
  capabilities: z.null(),
}).strict();

const threadActiveFlagSchema = z.enum(["waitingOnApproval", "waitingOnUserInput"]);

const threadStatusSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("notLoaded") }).strict(),
  z.object({ type: z.literal("idle") }).strict(),
  z.object({ type: z.literal("systemError") }).strict(),
  z.object({
    type: z.literal("active"),
    activeFlags: z.array(threadActiveFlagSchema),
  }).strict(),
]);

const threadSectionSchema = z.object({
  id: z.string().min(1),
  name: z.string().nullable(),
}).passthrough();

const gitInfoSchema = z.object({
  sha: z.string().min(1),
  branch: z.string().min(1),
  originUrl: z.string().min(1),
}).strict();

const commandActionSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("read"),
    command: z.string().min(1),
    name: z.string().min(1),
    path: z.string().min(1),
  }).strict(),
  z.object({
    type: z.literal("listFiles"),
    command: z.string().min(1),
    path: z.string().nullable(),
  }).strict(),
  z.object({
    type: z.literal("search"),
    command: z.string().min(1),
    query: z.string().nullable(),
    path: z.string().nullable(),
  }).strict(),
  z.object({
    type: z.literal("unknown"),
    command: z.string().min(1),
  }).strict(),
]);

const planItemSchema = z.object({
  type: z.literal("plan"),
  id: z.string().min(1),
  text: z.string().min(1),
}).strict();

const commandExecutionItemSchema = z.object({
  type: z.literal("commandExecution"),
  id: z.string().min(1),
  pluginId: z.string().nullable(),
  scriptPath: z.string().nullable(),
  command: z.string().min(1),
  cwd: z.string().min(1),
  processId: z.string().nullable(),
  source: z.enum(["agent", "userShell", "unifiedExecStartup", "unifiedExecInteraction"]),
  status: z.enum(["inProgress", "completed", "failed", "declined"]),
  commandActions: z.array(commandActionSchema),
  aggregatedOutput: z.string().nullable(),
  exitCode: z.number().int().nullable(),
  durationMs: z.number().int().nullable(),
}).strict();

const threadItemSchema = z.union([
  planItemSchema,
  commandExecutionItemSchema,
]);

const turnSchema = z.object({
  id: z.string().min(1),
  items: z.array(threadItemSchema),
  itemsView: z.literal("full"),
  status: z.enum(["completed", "interrupted", "failed", "inProgress"]),
  error: z.null(),
  startedAt: z.number().int().nullable(),
  completedAt: z.number().int().nullable(),
  durationMs: z.number().int().nullable(),
}).strict();

const threadSchema = z.object({
  id: z.string().min(1),
  sessionId: z.string().min(1),
  forkedFromId: z.string().nullable(),
  parentThreadId: z.string().nullable(),
  preview: z.string().min(1),
  ephemeral: z.boolean(),
  section: z.null(),
  sectionEnteredAt: z.number().int().nullable(),
  modelProvider: z.string().min(1),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
  recencyAt: z.number().int().nullable(),
  status: threadStatusSchema,
  path: z.string().nullable(),
  cwd: z.string().min(1),
  cliVersion: z.string().min(1),
  source: z.literal("appServer"),
  threadSource: z.null(),
  agentNickname: z.null(),
  agentRole: z.null(),
  gitInfo: gitInfoSchema,
  name: z.string().nullable(),
  turns: z.array(turnSchema),
}).strict();

const granularApprovalSchema = z.object({
  granular: z.object({
    sandbox_approval: z.boolean(),
    rules: z.boolean(),
    skill_approval: z.boolean(),
    request_permissions: z.boolean(),
    mcp_elicitations: z.boolean(),
  }).strict(),
}).strict();

const askForApprovalSchema = z.union([
  z.literal("untrusted"),
  z.literal("on-request"),
  granularApprovalSchema,
  z.literal("never"),
]);

const turnErrorSchema = z.object({
  message: z.string().min(1),
  codexErrorInfo: z.null(),
  additionalDetails: z.string().nullable(),
}).strict();

const errorNotificationSchema = z.object({
  error: turnErrorSchema,
  willRetry: z.boolean(),
  threadId: z.string().min(1),
  turnId: z.string().min(1),
}).strict();

export function parseInitializeFixture(value: unknown): InitializeParams {
  return initializeParamsSchema.parse(value);
}

export function parseThreadFixture(value: unknown): Thread {
  return threadSchema.parse(value);
}

export function parseTurnFixture(value: unknown): Turn {
  return turnSchema.parse(value);
}

export function parseThreadItemFixture(value: unknown): ThreadItem {
  return threadItemSchema.parse(value);
}

export function parseAskForApprovalFixture(value: unknown): AskForApproval {
  return askForApprovalSchema.parse(value);
}

export function parseErrorNotificationFixture(value: unknown): ErrorNotification {
  return errorNotificationSchema.parse(value);
}
