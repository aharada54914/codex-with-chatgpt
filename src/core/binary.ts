import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const COMMON_DIRS = [
  "/opt/homebrew/bin",
  "/usr/local/bin",
  "/usr/bin",
  path.join(process.env.HOME ?? "", ".local", "bin"),
  "C:\\Program Files\\cloudflared",
  "C:\\Program Files (x86)\\cloudflared",
];

function accessibleFile(candidate: string): string | null {
  try {
    const resolved = path.resolve(candidate);
    if (!fs.statSync(resolved).isFile()) return null;
    fs.accessSync(resolved, fs.constants.F_OK | fs.constants.X_OK);
    return resolved;
  } catch {
    return null;
  }
}

export function findBinary(name: string): string | null {
  const exe = process.platform === "win32" ? `${name}.exe` : name;
  try {
    const probe = spawnSync(exe, ["--version"], { stdio: "ignore", timeout: 5000 });
    if (probe.status === 0 || probe.status === 1) return exe;
  } catch {
    // not on PATH
  }
  for (const dir of COMMON_DIRS) {
    const full = path.join(dir, exe);
    const configured = accessibleFile(full);
    if (configured) return configured;
  }
  return null;
}
