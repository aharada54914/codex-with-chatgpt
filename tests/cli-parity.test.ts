import type { Command } from "commander";
import { describe, expect, it } from "vitest";
import { createCliProgram } from "../src/cli/program.js";
import { VERSION } from "../src/version.js";

function command(program: Command, name: string): Command {
  const found = program.commands.find((candidate) => candidate.name() === name);
  if (!found) throw new Error(`missing command: ${name}`);
  return found;
}

function optionFlags(program: Command): string[] {
  return program.options.map((option) => option.flags).sort();
}

describe("CLI command parity", () => {
  it("registers the complete V1 command surface", () => {
    const program = createCliProgram();

    expect(program.name()).toBe("c2c");
    expect(program.version()).toBe(VERSION);
    expect(program.commands.map((item) => item.name()).sort()).toEqual([
      "doctor",
      "logs",
      "pair",
      "prefs",
      "record",
      "restart",
      "sandbox-allow",
      "serve",
      "session",
      "setup",
      "start",
      "status",
      "stop",
      "tunnel",
      "unpair",
      "update-check",
      "workspace",
    ]);
  });

  it("preserves command and nested-command option flags", () => {
    const program = createCliProgram();

    expect(optionFlags(command(program, "start"))).toEqual([
      "--json",
      "--tunnel",
      "-w, --workspace <path>",
    ]);
    expect(optionFlags(command(program, "setup"))).toEqual([
      "--json",
      "--no-tunnel",
      "-w, --workspace <path>",
    ]);
    expect(optionFlags(command(program, "doctor"))).toEqual([
      "--json",
      "--no-fix",
      "-w, --workspace <path>",
    ]);
    expect(command(command(program, "session"), "get").options.map((item) => item.flags).sort()).toEqual([
      "--json",
      "-w, --workspace <path>",
    ]);
    expect(command(command(program, "prefs"), "set").options.map((item) => item.flags).sort()).toEqual([
      "--developer-mode",
      "--json",
      "--setup-mode <mode>",
    ]);
    expect(command(command(program, "tunnel"), "choose").options.map((item) => item.flags).sort()).toEqual([
      "--hostname <hostname>",
      "--json",
      "--mode <mode>",
      "--zone <domain>",
      "-w, --workspace <path>",
    ]);
  });

  it("keeps version, help, and invalid-command exit behavior", async () => {
    const run = async (args: string[]) => {
      const stdout: string[] = [];
      const stderr: string[] = [];
      const program = createCliProgram()
        .exitOverride()
        .configureOutput({
          writeOut: (value) => stdout.push(value),
          writeErr: (value) => stderr.push(value),
        });
      let exitCode = 0;
      try {
        await program.parseAsync(args, { from: "user" });
      } catch (error) {
        exitCode = (error as { exitCode?: number }).exitCode ?? 1;
      }
      return { exitCode, stdout: stdout.join(""), stderr: stderr.join("") };
    };

    await expect(run(["--version"])).resolves.toEqual({ exitCode: 0, stdout: `${VERSION}\n`, stderr: "" });
    const help = await run(["--help"]);
    expect(help.exitCode).toBe(0);
    expect(help.stdout).toContain("Usage: c2c [options] [command]");
    expect(help.stdout).toContain("doctor [options]");
    expect(help.stderr).toBe("");
    await expect(run(["definitely-not-a-command"])).resolves.toEqual({
      exitCode: 1,
      stdout: "",
      stderr: "error: unknown command 'definitely-not-a-command'\n",
    });
  });
});
