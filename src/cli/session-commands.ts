import { Command } from "commander";
import { appendExecutionRecord } from "../compat/legacy/execution/records.js";
import { saveExecutionOutput } from "../compat/legacy/execution/output.js";
import {
  clearChatPointer,
  mergeSession,
  readSession,
  resolveConversation,
  writeSession,
  PROTOCOL_STATES,
  WAITING_FOR,
  type ConversationMode,
  type ProtocolState,
  type WaitingFor,
} from "../compat/legacy/state/session.js";
import { mergeUiPrefs, readUiPrefs, SETUP_MODES, type SetupMode } from "../compat/legacy/state/ui-prefs.js";
import { Workspace } from "../workspace/manager.js";
import {
  check,
  handleCliError,
  parseChangedFiles,
  parseInteger,
  parseNonNegativeInteger,
  readCappedUtf8,
  MAX_RECORD_OUTPUT_READ,
  resolveWorkspace,
  say,
} from "./shared.js";

export function registerSessionCommands(program: Command): void {
  const session = program
    .command("session")
    .description("Remember the ChatGPT Project and conversation for this workspace");

  session
    .command("get", { isDefault: true })
    .description("Show the saved ChatGPT conversation / Project for this workspace")
    .option("-w, --workspace <path>")
    .option("--json", "machine-readable output", false)
    .action((opts: { workspace?: string; json: boolean }) => {
      const workspace = new Workspace(resolveWorkspace(opts.workspace));
      const saved = readSession(workspace.id);
      const conversation = resolveConversation(saved);
      if (opts.json) say(JSON.stringify({ ok: true, session: saved, conversation }));
      else if (!saved) {
        say("尚未记录 ChatGPT 会话。新仓库默认使用 Project 合集。");
      } else {
        say(`模式：${conversation.mode === "project" ? "Project 合集" : "长对话"}`);
        if (conversation.projectUrl) say(`合集：${conversation.projectUrl}`);
        if (saved.title) say(`会话：${saved.title}`);
        if (saved.url) say(`对话：${saved.url}`);
        if (saved.connectorName) say(`连接器：${saved.connectorName}`);
        if (saved.taskId) say(`任务：${saved.taskId}（第 ${saved.iteration ?? 0} 轮，${saved.lastState ?? "?"}）`);
        if (saved.checkpoint) {
          say(
            `存档：${saved.checkpoint.protocolState} / 等待 ${saved.checkpoint.waitingFor}（第 ${saved.checkpoint.iteration} 轮）`
          );
        }
      }
    });

  session
    .command("set")
    .description("Save the ChatGPT Project and/or conversation for this workspace")
    .option("-w, --workspace <path>")
    .option("--url <url>", "ChatGPT conversation URL from the address bar")
    .option("--title <title>")
    .option("--task <id>")
    .option("--iteration <n>")
    .option("--state <state>", "last protocol state, e.g. EXECUTED")
    .option("--mode <mode>", "long-chat or project")
    .option("--project-url <url>", "ChatGPT Project collection URL (…/g/g-p-…/project)")
    .option("--connector-name <name>", "exact connector title for this workspace")
    .option("--protocol-state <state>", "checkpoint protocol state, e.g. EXECUTED_SENT")
    .option("--waiting-for <who>", "none | GPT_PLAN | GPT_REVIEW | USER")
    .option("--goal <text>", "original task goal for resume / HANDOFF")
    .option("--completed-subtasks <text>")
    .option("--known-issues <text>")
    .option("--next-step <text>")
    .option("--clear-checkpoint", "drop the active checkpoint (task DONE)", false)
    .action(
      (opts: {
        workspace?: string;
        url?: string;
        title?: string;
        task?: string;
        iteration?: string;
        state?: string;
        mode?: string;
        projectUrl?: string;
        connectorName?: string;
        protocolState?: string;
        waitingFor?: string;
        goal?: string;
        completedSubtasks?: string;
        knownIssues?: string;
        nextStep?: string;
        clearCheckpoint: boolean;
      }) => {
        const workspace = new Workspace(resolveWorkspace(opts.workspace));
        const modeRaw = opts.mode?.trim().toLowerCase();
        if (modeRaw && modeRaw !== "long-chat" && modeRaw !== "project") {
          throw new Error("mode must be long-chat or project");
        }
        const protocolRaw = opts.protocolState?.trim().toUpperCase();
        if (protocolRaw && !PROTOCOL_STATES.includes(protocolRaw as ProtocolState)) {
          throw new Error(`protocol-state must be one of ${PROTOCOL_STATES.join(", ")}`);
        }
        const waitingRaw = opts.waitingFor?.trim();
        const waitingNorm = waitingRaw
          ? waitingRaw.toLowerCase() === "none"
            ? "none"
            : waitingRaw.toUpperCase()
          : undefined;
        if (waitingNorm && !WAITING_FOR.includes(waitingNorm as WaitingFor)) {
          throw new Error(`waiting-for must be one of ${WAITING_FOR.join(", ")}`);
        }
        const saved = mergeSession(readSession(workspace.id), {
          url: opts.url,
          title: opts.title,
          taskId: opts.task,
          iteration: opts.iteration ? parseInt(opts.iteration, 10) : undefined,
          lastState: opts.state,
          conversationMode: modeRaw as ConversationMode | undefined,
          projectUrl: opts.projectUrl,
          connectorName: opts.connectorName,
          clearCheckpoint: opts.clearCheckpoint,
          checkpoint: protocolRaw
            ? {
                protocolState: protocolRaw as ProtocolState,
                waitingFor: (waitingNorm as WaitingFor | undefined) ?? undefined,
                originalGoal: opts.goal,
                completedSubtasks: opts.completedSubtasks,
                knownIssues: opts.knownIssues,
                nextExpectedStep: opts.nextStep,
              }
            : undefined,
        });
        writeSession(workspace.id, saved);
        if (saved.projectUrl && saved.conversationMode === "project") {
          check("已记录 ChatGPT 合集，后续从合集页新开或复用对话");
        } else {
          check("已记录 ChatGPT 会话，后续任务将复用");
        }
      }
    );

  session
    .command("clear")
    .description("Forget the current ChatGPT chat (Project binding is kept)")
    .option("-w, --workspace <path>")
    .action((opts: { workspace?: string }) => {
      const workspace = new Workspace(resolveWorkspace(opts.workspace));
      const result = clearChatPointer(workspace.id);
      if (!result.cleared) say("尚未记录 ChatGPT 会话。");
      else if (result.keptProject) check("已清除当前对话，合集绑定仍保留");
      else check("已清除会话记录，下次任务将新建 ChatGPT 会话");
    });

  const prefsCmd = program
    .command("prefs")
    .description("Remember ChatGPT developer mode and setup choice for this machine");

  prefsCmd
    .command("get", { isDefault: true })
    .description("Show remembered ChatGPT setup choices (not per workspace)")
    .option("--json", "machine-readable output", false)
    .action((opts: { json: boolean }) => {
      const prefs = readUiPrefs();
      if (opts.json) {
        say(JSON.stringify({ ok: true, ...prefs }));
        return;
      }
      say(prefs.developerModeEnabled ? "开发人员模式：已记住已开启" : "开发人员模式：尚未记住");
      if (prefs.setupMode === "auto") say("配置方式：AI 自动化配置（预览版）");
      else if (prefs.setupMode === "manual") say("配置方式：手动教学配置");
      else say("配置方式：尚未选择");
    });

  prefsCmd
    .command("set")
    .description("Save a ChatGPT setup choice for this machine")
    .option("--developer-mode", "remember that ChatGPT developer mode is on", false)
    .option("--setup-mode <mode>", "auto (preview) or manual")
    .option("--json", "machine-readable output", false)
    .action((opts: { developerMode: boolean; setupMode?: string; json: boolean }) => {
      try {
        const modeRaw = opts.setupMode?.trim().toLowerCase();
        if (modeRaw && !SETUP_MODES.includes(modeRaw as SetupMode)) {
          throw new Error(`setup-mode must be one of ${SETUP_MODES.join(", ")}`);
        }
        if (!opts.developerMode && !modeRaw) {
          throw new Error("nothing to save: pass --developer-mode and/or --setup-mode");
        }
        const prefs = mergeUiPrefs({
          developerModeEnabled: opts.developerMode ? true : undefined,
          setupMode: modeRaw as SetupMode | undefined,
        });
        if (opts.json) {
          say(JSON.stringify({ ok: true, ...prefs }));
          return;
        }
        if (opts.developerMode) check("已记住开发人员模式已开启");
        if (modeRaw === "auto") check("已记住配置方式：AI 自动化配置（预览版）");
        if (modeRaw === "manual") check("已记住配置方式：手动教学配置");
      } catch (error) {
        handleCliError(error, opts.json);
      }
    });

  program
    .command("record", { hidden: true })
    .description("Record a Codex execution summary (used by the Skill)")
    .option("-w, --workspace <path>")
    .requiredOption("--task <id>")
    .requiredOption("--iteration <n>", "non-negative execution iteration", parseNonNegativeInteger)
    .option("--changed-files <filesOrCount>", "comma-separated files or a count", "0")
    .option("--tests <summary>", "e.g. '27 passed'")
    .option("--exit-status <status>", "ok | failed | blocked", "ok")
    .option("--notes <text>")
    .option("--command <text>", "command whose output may be offered to ChatGPT")
    .option("--output <text>", "command output (prefer --output-file for long logs)")
    .option("--output-file <path>", "read command output from a local file")
    .option("--exit-code <n>", "numeric exit code of that command", parseInteger)
    .action(
      (opts: {
        workspace?: string;
        task: string;
        iteration: number;
        changedFiles: string;
        tests?: string;
        exitStatus: string;
        notes?: string;
        command?: string;
        output?: string;
        outputFile?: string;
        exitCode?: number;
      }) => {
        const workspace = new Workspace(resolveWorkspace(opts.workspace));
        const changed = parseChangedFiles(opts.changedFiles);
        let outputId: number | undefined;
        let outputAvailable = false;
        const rawOutput =
          opts.outputFile !== undefined
            ? readCappedUtf8(resolveWorkspace(opts.outputFile), MAX_RECORD_OUTPUT_READ)
            : opts.output;
        if (opts.command && rawOutput !== undefined) {
          const savedOutput = saveExecutionOutput(workspace.id, {
            command: opts.command,
            raw: rawOutput,
            exitCode: opts.exitCode ?? null,
            taskId: opts.task,
            iteration: opts.iteration,
          });
          outputId = savedOutput.id;
          outputAvailable = savedOutput.allowed;
        }
        appendExecutionRecord(workspace.id, {
          taskId: opts.task,
          iteration: opts.iteration,
          changedFiles: changed,
          tests: opts.tests ?? null,
          exitStatus: opts.exitStatus,
          timestamp: new Date().toISOString(),
          notes: opts.notes?.slice(0, 400),
          outputId,
          outputAvailable,
        });
        if (outputId !== undefined && !outputAvailable) check("已记录执行摘要（输出未对 ChatGPT 开放）");
        else if (outputId !== undefined) check("已记录执行摘要与输出");
        else check("已记录执行摘要");
      }
    );
}
