import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const cliDir = path.resolve(process.cwd(), "src", "cli");

describe("CLI module structure", () => {
  it("keeps the executable bootstrap thin", () => {
    const source = fs.readFileSync(path.join(cliDir, "index.ts"), "utf8");
    expect(source.split("\n").length).toBeLessThanOrEqual(10);
  });

  it("keeps command modules focused", () => {
    const oversized = fs
      .readdirSync(cliDir)
      .filter((name) => name.endsWith(".ts"))
      .map((name) => ({
        name,
        lines: fs.readFileSync(path.join(cliDir, name), "utf8").split("\n").length,
      }))
      .filter(({ lines }) => lines > 500);

    expect(oversized).toEqual([]);
  });
});
