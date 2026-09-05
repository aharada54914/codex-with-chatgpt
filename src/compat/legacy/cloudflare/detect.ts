import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { findBinary as findGenericBinary } from "../../../core/binary.js";

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
  if (name !== "cloudflared") {
    return findGenericBinary(name);
  }
  const exe = process.platform === "win32" ? `${name}.exe` : name;
  if (name === "cloudflared" && process.env.C2C_CLOUDFLARED_PATH?.trim()) {
    const configured = accessibleFile(process.env.C2C_CLOUDFLARED_PATH.trim());
    if (configured) return configured;
  }
  return findGenericBinary(name) ?? ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", path.join(process.env.HOME ?? "", ".local", "bin"), "C:\\Program Files\\cloudflared", "C:\\Program Files (x86)\\cloudflared"].map((dir) => accessibleFile(path.join(dir, exe))).find((value): value is string => Boolean(value)) ?? null;
}

export interface TunnelBinaries {
  cloudflared: string | null;
  wrangler: string | null;
}

export function detectTunnelBinaries(): TunnelBinaries {
  return {
    cloudflared: findBinary("cloudflared"),
    wrangler: findBinary("wrangler"),
  };
}
