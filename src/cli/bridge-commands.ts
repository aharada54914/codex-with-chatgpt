import { Command } from "commander";
import { startBridge } from "../bridge/server.js";
import { findBridgeObservation, findLiveBridge } from "../bridge/runtime.js";
import { adminFetch, ensureBridge, stopBridge } from "../process/daemon.js";
import { AuthStore } from "../auth/store.js";
import { Workspace } from "../workspace/manager.js";
import { Logger } from "../logger/index.js";
import { isNamedTunnelReady, readTunnelState } from "../tunnel/state.js";
import {
  readLastEndpoint,
  connectorNameFor,
} from "../config/endpoint.js";
import { PRODUCT_NAME } from "../version.js";
import {
  check,
  cross,
  ensureBridgeAndTunnel,
  handleCliError,
  persistWorkspaceEndpoint,
  resolveWorkspace,
  say,
  trySandboxAllow,
  AdminInfo,
  PairingResponse,
} from "./shared.js";
import { registerDoctorCommand } from "./doctor-command.js";

function parseIntOrUndefined(value?: string): number | undefined {
  return value ? parseInt(value, 10) : undefined;
}

export function registerBridgeCommands(program: Command): void {
  program
    .command("serve", { hidden: true })
    .description("Run the bridge in the foreground (internal)")
    .requiredOption("--workspace <path>")
    .option("--port <port>", "preferred port")
    .action(async (opts: { workspace: string; port?: string }) => {
      const logger = new Logger({ name: "bridge", console: true });
      const bridge = await startBridge({
        workspaceRoot: resolveWorkspace(opts.workspace),
        port: parseIntOrUndefined(opts.port),
        logger,
      });
      const shutdown = (): void => {
        void bridge.close().then(() => process.exit(0));
      };
      process.on("SIGINT", shutdown);
      process.on("SIGTERM", shutdown);
      say(`bridge ready on ${bridge.localBaseUrl()} (workspace ${bridge.workspace.name})`);
    });

  program
    .command("start")
    .description("Start (or reuse) the bridge for this workspace")
    .option("-w, --workspace <path>", "workspace root (defaults to current directory)")
    .option("--tunnel", "also establish the secure public connection", false)
    .option("--json", "machine-readable output", false)
    .action(async (opts: { workspace?: string; tunnel: boolean; json: boolean }) => {
      const root = resolveWorkspace(opts.workspace);
      try {
        const { runtime, info, mcpUrl } = await ensureBridgeAndTunnel(root, { tunnel: opts.tunnel });
        const connectorName = mcpUrl
          ? persistWorkspaceEndpoint({
              workspaceId: info.workspaceId,
              workspaceName: info.workspaceName,
              port: runtime.port,
              publicUrl: info.publicUrl,
              mcpUrl,
            })
          : readLastEndpoint(info.workspaceId)?.connectorName;
        if (opts.json) {
          say(JSON.stringify({ ok: true, port: runtime.port, workspaceId: info.workspaceId, mcpUrl, connectorName }));
          return;
        }
        check(`当前项目已识别（${info.workspaceName}）`);
        check("Workspace Bridge 已启动");
        if (mcpUrl) check("安全连接已建立");
      } catch (error) {
        handleCliError(error, opts.json);
      }
    });

  program
    .command("setup")
    .description("First-time setup: bridge + secure connection + pairing code")
    .option("-w, --workspace <path>")
    .option("--no-tunnel", "local-only setup (development)")
    .option("--json", "machine-readable output", false)
    .action(async (opts: { workspace?: string; tunnel: boolean; json: boolean }) => {
      const root = resolveWorkspace(opts.workspace);
      try {
        if (!opts.json) {
          say(PRODUCT_NAME);
          say("");
          say("正在连接 ChatGPT…");
          say("");
        }
        const sandbox = trySandboxAllow();
        const { runtime, info, mcpUrl } = await ensureBridgeAndTunnel(root, { tunnel: opts.tunnel });
        const lastEndpoint = readLastEndpoint(info.workspaceId);
        const connectorName = mcpUrl
          ? persistWorkspaceEndpoint({
              workspaceId: info.workspaceId,
              workspaceName: info.workspaceName,
              port: runtime.port,
              publicUrl: info.publicUrl,
              mcpUrl,
            })
          : connectorNameFor({
              workspaceName: info.workspaceName,
              workspaceId: info.workspaceId,
              previousName: lastEndpoint?.connectorName,
              hadEndpointBefore: Boolean(lastEndpoint),
            });
        const pairingResult = await adminFetch<PairingResponse>(runtime, "POST", "/admin/pairing");
        const tunnelState = readTunnelState(info.workspaceId);
        if (opts.json) {
          say(
            JSON.stringify({
              ok: true,
              workspaceId: info.workspaceId,
              workspaceName: info.workspaceName,
              connectorName,
              mcpUrl: mcpUrl ?? `http://127.0.0.1:${runtime.port}/mcp`,
              local: mcpUrl === null,
              pairingCode: pairingResult.code,
              pairingExpiresAt: pairingResult.expiresAt,
              sandbox,
              tunnel: {
                mode: isNamedTunnelReady(tunnelState) ? "named" : "quick",
                hostname: tunnelState.hostname ?? null,
                fallback: Boolean(tunnelState.fallbackReason),
              },
            })
          );
          return;
        }
        check(`当前项目已识别（${info.workspaceName}）`);
        check("Workspace Bridge 已启动");
        if (mcpUrl) check("安全连接已建立");
        say("");
        say(`连接地址：${mcpUrl ?? `http://127.0.0.1:${runtime.port}/mcp`}`);
        say(`配对码：${pairingResult.code}（${Math.round((pairingResult.expiresAt - Date.now()) / 60000)} 分钟内有效）`);
        say("");
        say("下一步：在 ChatGPT 的连接器设置中添加以上地址（OAuth），并在授权页输入配对码。");
        say("如果你在使用 Codex Skill，这一步会自动完成。");
      } catch (error) {
        handleCliError(error, opts.json);
      }
    });

  program
    .command("stop")
    .description("Stop the bridge for this workspace")
    .option("-w, --workspace <path>")
    .action(async (opts: { workspace?: string }) => {
      const stopped = await stopBridge(resolveWorkspace(opts.workspace));
      if (stopped) check("Bridge 已停止");
      else say("没有正在运行的 Bridge。");
    });

  program
    .command("restart")
    .description("Restart the bridge for this workspace")
    .option("-w, --workspace <path>")
    .option("--tunnel", "re-establish the secure public connection", false)
    .action(async (opts: { workspace?: string; tunnel: boolean }) => {
      const root = resolveWorkspace(opts.workspace);
      await stopBridge(root);
      await new Promise((resolve) => setTimeout(resolve, 500));
      try {
        const { info, mcpUrl } = await ensureBridgeAndTunnel(root, { tunnel: opts.tunnel });
        check(`Bridge 已重启（${info.workspaceName}）`);
        if (mcpUrl) check(`安全连接已建立`);
      } catch (error) {
        handleCliError(error, false);
      }
    });

  program
    .command("status")
    .description("Show bridge status for this workspace")
    .option("-w, --workspace <path>")
    .option("--json", "machine-readable output", false)
    .action(async (opts: { workspace?: string; json: boolean }) => {
      const root = resolveWorkspace(opts.workspace);
      const workspace = new Workspace(root);
      const observation = await findBridgeObservation(workspace.id);
      if (observation.state === "unknown") {
        if (opts.json) {
          say(JSON.stringify({ ok: false, running: null, state: "unknown", reason: observation.reason }));
        } else {
          cross(`Bridge 状态无法确认（${observation.reason}），未将其视为未运行。`);
        }
        return;
      }
      if (observation.state === "stopped") {
        if (opts.json) say(JSON.stringify({ ok: false, running: false }));
        else say("Bridge 未运行。使用 `c2c start` 启动。");
        return;
      }
      const runtime = observation.runtime;
      const info = await adminFetch<AdminInfo>(runtime, "GET", "/admin/info");
      if (opts.json) {
        say(JSON.stringify({ ok: true, running: true, ...info }));
        return;
      }
      say(PRODUCT_NAME);
      say("");
      check(`Workspace：${info.workspaceName}`);
      check(`Bridge：运行中（端口 ${info.port}）`);
      if (info.tunnel.running && info.tunnel.url) check(`安全连接：${info.tunnel.url}/mcp`);
      else say("· 安全连接：未启用（本地模式）");
      say(`· 已授权连接：${info.tokenCount > 0 ? "是" : "否"}`);
    });

  registerDoctorCommand(program);

  program
    .command("pair")
    .description("Generate a fresh pairing code")
    .option("-w, --workspace <path>")
    .option("--json", "machine-readable output", false)
    .action(async (opts: { workspace?: string; json: boolean }) => {
      try {
        const { runtime } = await ensureBridge(resolveWorkspace(opts.workspace));
        const pairing = await adminFetch<PairingResponse>(runtime, "POST", "/admin/pairing");
        if (opts.json) say(JSON.stringify({ ok: true, pairingCode: pairing.code, expiresAt: pairing.expiresAt }));
        else {
          say(`配对码：${pairing.code}`);
          say(`（${Math.round((pairing.expiresAt - Date.now()) / 60000)} 分钟内有效，仅可使用一次）`);
        }
      } catch (error) {
        handleCliError(error, opts.json);
      }
    });

  program
    .command("unpair")
    .description("Revoke ChatGPT's access to this workspace immediately")
    .option("-w, --workspace <path>")
    .action(async (opts: { workspace?: string }) => {
      const root = resolveWorkspace(opts.workspace);
      const workspace = new Workspace(root);
      const runtime = await findLiveBridge(workspace.id);
      if (runtime) {
        await adminFetch(runtime, "POST", "/admin/revoke-all");
      } else {
        new AuthStore(workspace.id).revokeAll();
      }
      check("已断开 ChatGPT 对当前项目的访问（所有令牌已吊销）");
    });
}
