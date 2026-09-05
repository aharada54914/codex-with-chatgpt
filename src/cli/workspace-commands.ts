import { Command } from "commander";
import fs from "node:fs";
import path from "node:path";
import { Workspace } from "../workspace/manager.js";
import { getStateDir } from "../config/paths.js";
import { isStateDirAllowlisted } from "../compat/legacy/state/sandbox-allow.js";
import { VERSION } from "../version.js";
import { check, cross, handleCliError, resolveWorkspace, runGit, say, trySandboxAllow } from "./shared.js";

export function registerWorkspaceCommands(program: Command): void {
  program
    .command("logs")
    .description("Show recent bridge logs")
    .option("-w, --workspace <path>")
    .option("-n, --lines <n>", "number of lines", "50")
    .option("--verbose", "include debug detail", false)
    .action((opts: { workspace?: string; lines: string; verbose: boolean }) => {
      const workspace = new Workspace(resolveWorkspace(opts.workspace));
      const candidates = [
        path.join(getStateDir(), "logs", "bridge.log"),
        path.join(getStateDir(), "logs", `bridge-${workspace.id}.out.log`),
      ];
      let shown = false;
      for (const file of candidates) {
        if (!fs.existsSync(file)) continue;
        const lines = fs.readFileSync(file, "utf8").trim().split("\n");
        const filtered = opts.verbose ? lines : lines.filter((line) => !line.includes(" DEBUG "));
        say(filtered.slice(-parseInt(opts.lines, 10)).join("\n"));
        shown = true;
      }
      if (!shown) say("暂无日志。");
    });

  program
    .command("workspace")
    .description("Show workspace identity and project info")
    .option("-w, --workspace <path>")
    .option("--json", "machine-readable output", false)
    .action((opts: { workspace?: string; json: boolean }) => {
      const workspace = new Workspace(resolveWorkspace(opts.workspace));
      const project = workspace.detectProject();
      const data = { workspaceId: workspace.id, name: workspace.name, root: workspace.root, ...project };
      if (opts.json) say(JSON.stringify(data));
      else {
        say(`Workspace：${data.name}（${data.workspaceId}）`);
        say(`类型：${data.projectType}  语言：${data.languages.join(", ") || "-"}`);
        say(`路径：${data.root}`);
      }
    });

  program
    .command("sandbox-allow")
    .description("Add the local settings directory to the Codex sandbox allowlist")
    .option("--json", "machine-readable output", false)
    .action((opts: { json: boolean }) => {
      const result = trySandboxAllow();
      if (opts.json) {
        say(JSON.stringify(result));
        if (!result.ok) process.exitCode = 1;
        return;
      }
      if (!result.ok) {
        cross(`无法写入 Codex 沙箱白名单：${result.error}`);
        process.exitCode = 1;
        return;
      }
      if (result.alreadyAllowed) check("沙箱白名单已就绪，后续对话无需再提权");
      else check("已将本地设置目录加入 Codex 沙箱白名单（后续对话无需再提权）");
    });

  program
    .command("update-check")
    .description("Check GitHub for a newer version (real check at most once per local day)")
    .option("--force", "check even if already checked today", false)
    .option("--json", "machine-readable output", false)
    .action((opts: { force: boolean; json: boolean }) => {
      const file = path.join(getStateDir(), "update-check.json");
      const today = new Date().toLocaleDateString("en-CA");
      let last: { date?: string; updateAvailable?: boolean } = {};
      try {
        last = JSON.parse(fs.readFileSync(file, "utf8")) as typeof last;
      } catch {
        /* first run */
      }

      const emit = (data: {
        checked: boolean;
        updateAvailable: boolean;
        localCommit?: string;
        remoteCommit?: string;
        note?: string;
      }): void => {
        if (opts.json) say(JSON.stringify({ ok: true, version: VERSION, ...data }));
        else if (data.updateAvailable) say(`发现新版本（本地 ${data.localCommit?.slice(0, 7)} → 远端 ${data.remoteCommit?.slice(0, 7)}）。`);
        else say(data.note ?? "已是最新版本。");
      };

      if (!opts.force && last.date === today) {
        emit({ checked: false, updateAvailable: last.updateAvailable ?? false, note: "今天已检查过更新。" });
        return;
      }

      const local = runGit(["rev-parse", "HEAD"]);
      const remote = runGit(["ls-remote", "origin", "HEAD"]);
      if (!local.ok || !remote.ok || !remote.stdout) {
        emit({ checked: false, updateAvailable: false, note: "无法检查更新（离线或非 git 安装），已跳过。" });
        return;
      }
      const remoteCommit = remote.stdout.split(/\s/)[0];
      const updateAvailable = remoteCommit !== local.stdout;
      fs.mkdirSync(getStateDir(), { recursive: true });
      fs.writeFileSync(file, JSON.stringify({ date: today, updateAvailable, remoteCommit }), { mode: 0o600 });
      emit({ checked: true, updateAvailable, localCommit: local.stdout, remoteCommit });
    });
}
