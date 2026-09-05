import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

function TypeScriptFiles(root: string): string[] {
  return fs.readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const child = path.join(root, entry.name);
    return entry.isDirectory() ? TypeScriptFiles(child) : entry.isFile() && child.endsWith(".ts") ? [child] : [];
  });
}

describe("legacy compatibility isolation", () => {
  it("keeps V2 control-plane modules independent from legacy compatibility code", () => {
    const roots = ["activities", "context", "domain", "policy", "projects", "recovery", "review", "state", "verification"];
    const files = roots.flatMap((root) => TypeScriptFiles(path.resolve("src", root))).concat(path.resolve("src/mcp/v2.ts"));
    for (const file of files) {
      const source = fs.readFileSync(file, "utf8");
      expect(source, file).not.toMatch(
        /compat\/legacy|(?:\.\.\/)+(?:auth|pairing)\/|execution\/(records|output)|session\/state|sandbox-allow|ui-prefs/
      );
    }
  });

  it("limits legacy imports to explicit local CLI and transport composition adapters", () => {
    const files = TypeScriptFiles(path.resolve("src")).filter((file) => !file.includes(`${path.sep}compat${path.sep}`));
    const importers = files.filter((file) => fs.readFileSync(file, "utf8").includes("compat/legacy"))
      .map((file) => path.relative(process.cwd(), file).split(path.sep).join("/"))
      .sort();
    expect(importers).toEqual([
      "src/cli/bridge-commands.ts",
      "src/cli/doctor-command.ts",
      "src/cli/session-commands.ts",
      "src/cli/shared.ts",
      "src/cli/tunnel-commands.ts",
      "src/cli/workspace-commands.ts",
      "src/transport/factory.ts",
    ]);
  });

  it("has no legacy state or Cloudflare facade left in core source paths", () => {
    for (const candidate of ["src/auth", "src/pairing", "src/execution/records.ts", "src/execution/output.ts",
      "src/session", "src/config/sandbox-allow.ts", "src/config/ui-prefs.ts", "src/tunnel/cloudflared.ts",
      "src/tunnel/cloudflared-named.ts", "src/tunnel/cloudflare-provider.ts", "src/tunnel/detect.ts",
      "src/tunnel/hostname.ts", "src/tunnel/named-provision.ts", "src/tunnel/state.ts"]) {
      expect(fs.existsSync(path.resolve(candidate)), candidate).toBe(false);
    }
  });
});
