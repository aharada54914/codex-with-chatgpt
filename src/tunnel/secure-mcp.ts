import { spawn, type ChildProcess } from "node:child_process";
import type { Logger } from "../logger/index.js";
import { nullLogger } from "../logger/index.js";
import { findBinary } from "./detect.js";
import type { TunnelError } from "./provider.js";

export type SecureMcpErrorCode =
  | TunnelError["code"]
  | "entitlement_missing"
  | "profile_not_configured"
  | "command_not_configured"
  | "doctor_failed";

export interface SecureMcpError {
  code: SecureMcpErrorCode;
  message: string;
  detail?: string;
}

export interface SecureMcpDoctorReport {
  ok: boolean;
  binaryFound: boolean;
  binaryPath: string | null;
  profile: string;
  tunnelId: string | null;
  commandConfigured: boolean;
  problems: string[];
  errors: SecureMcpError[];
}

export interface SecureMcpStatus {
  configured: boolean;
  running: boolean;
  profile: string | null;
  tunnelId: string | null;
  command: string | null;
  pid: number | null;
}

export interface SecureMcpClientOptions {
  logger?: Logger;
  binaryOverride?: string;
  profile?: string;
  tunnelId?: string;
  mcpCommand?: string;
  spawnImpl?: (command: string, args: string[], options: { stdio: ["ignore", "pipe", "pipe"]; windowsHide: true }) => ChildProcess;
}

export type SecureMcpTunnelOptions = SecureMcpClientOptions;

function secureMcpError(code: SecureMcpErrorCode, message: string, detail?: string): SecureMcpError {
  return { code, message, detail };
}

export class SecureMcpTunnelClient {
  readonly name = "secure-mcp";
  private readonly logger: Logger;
  private readonly spawnImpl: NonNullable<SecureMcpClientOptions["spawnImpl"]>;
  private readonly binaryOverride?: string;
  private profile: string | null;
  private tunnelId: string | null;
  private mcpCommand: string | null;
  private child: ChildProcess | null = null;

  constructor(options: SecureMcpClientOptions = {}) {
    this.logger = options.logger ?? nullLogger;
    this.spawnImpl = options.spawnImpl ?? ((command, args, spawnOptions) => spawn(command, args, spawnOptions));
    this.binaryOverride = options.binaryOverride;
    this.profile = options.profile ?? null;
    this.tunnelId = options.tunnelId ?? null;
    this.mcpCommand = options.mcpCommand ?? null;
  }

  configure(options?: { profile?: string; tunnelId?: string; mcpCommand?: string }): void {
    if (!options) return;
    if (options.profile !== undefined) this.profile = options.profile;
    if (options.tunnelId !== undefined) this.tunnelId = options.tunnelId;
    if (options.mcpCommand !== undefined) this.mcpCommand = options.mcpCommand;
  }

  status(): SecureMcpStatus {
    return {
      configured: Boolean(this.profile && this.tunnelId && this.mcpCommand),
      running: Boolean(this.child && !this.child.killed),
      profile: this.profile,
      tunnelId: this.tunnelId,
      command: this.mcpCommand,
      pid: this.child?.pid ?? null,
    };
  }

  async doctor(): Promise<SecureMcpDoctorReport> {
    const binaryPath = this.binary();
    const problems: string[] = [];
    const errors: SecureMcpError[] = [];
    if (!binaryPath) {
      problems.push("tunnel-client is not installed");
      errors.push(secureMcpError("binary_not_found", "tunnel-client is not installed"));
      return {
        ok: false,
        binaryFound: false,
        binaryPath: null,
        profile: this.profile ?? "",
        tunnelId: this.tunnelId,
        commandConfigured: Boolean(this.mcpCommand),
        problems,
        errors,
      };
    }
    const status = this.status();
    if (!status.profile) problems.push("profile is not configured");
    if (!status.tunnelId) problems.push("tunnel id is not configured");
    if (!status.command) problems.push("MCP command is not configured");
    if (problems.length) {
      errors.push(
        ...problems.map((problem) =>
          secureMcpError(
            problem.includes("profile")
              ? "profile_not_configured"
              : problem.includes("tunnel id")
                ? "entitlement_missing"
                : "command_not_configured",
            problem
          )
        )
      );
      return {
        ok: false,
        binaryFound: true,
        binaryPath,
        profile: status.profile ?? "",
        tunnelId: status.tunnelId,
        commandConfigured: Boolean(status.command),
        problems,
        errors,
      };
    }
    try {
      const child = this.spawnImpl(binaryPath, ["doctor", "--profile", status.profile!, "--explain"], {
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
      const exitCode = await new Promise<number | null>((resolve) => {
        child.once("exit", (code) => resolve(code));
        child.once("error", () => resolve(null));
      });
      if (exitCode === 0) {
        return {
          ok: true,
          binaryFound: true,
          binaryPath,
          profile: status.profile!,
          tunnelId: status.tunnelId,
          commandConfigured: true,
          problems,
          errors,
        };
      }
      errors.push(secureMcpError("doctor_failed", "tunnel-client doctor reported a failure"));
      problems.push("tunnel-client doctor reported a failure");
      return {
        ok: false,
        binaryFound: true,
        binaryPath,
        profile: status.profile!,
        tunnelId: status.tunnelId,
        commandConfigured: true,
        problems,
        errors,
      };
    } catch (error) {
      errors.push(secureMcpError("doctor_failed", error instanceof Error ? error.message : String(error)));
      return {
        ok: false,
        binaryFound: true,
        binaryPath,
        profile: status.profile!,
        tunnelId: status.tunnelId,
        commandConfigured: true,
        problems: [...problems, "tunnel-client doctor could not start"],
        errors,
      };
    }
  }

  async init(sample = "sample_mcp_stdio_local"): Promise<{ ok: true } | { ok: false; error: SecureMcpError }> {
    const binaryPath = this.binary();
    if (!binaryPath) return { ok: false, error: secureMcpError("binary_not_found", "tunnel-client is not installed") };
    const status = this.status();
    if (!status.profile) return { ok: false, error: secureMcpError("profile_not_configured", "profile is not configured") };
    if (!status.tunnelId) return { ok: false, error: secureMcpError("entitlement_missing", "tunnel id is not configured") };
    if (!status.command) return { ok: false, error: secureMcpError("command_not_configured", "MCP command is not configured") };
    await this.spawnExit(binaryPath, [
      "init",
      "--sample",
      sample,
      "--profile",
      status.profile,
      "--tunnel-id",
      status.tunnelId,
      "--mcp-command",
      status.command,
    ]);
    return { ok: true };
  }

  async start(_localPort?: number): Promise<{ ok: true; provider: string; pid: number | null; url: string | null } | { ok: false; provider: string; error: SecureMcpError }> {
    const binaryPath = this.binary();
    if (!binaryPath) return { ok: false, provider: this.name, error: secureMcpError("binary_not_found", "tunnel-client is not installed") };
    const status = this.status();
    if (!status.profile) return { ok: false, provider: this.name, error: secureMcpError("profile_not_configured", "profile is not configured") };
    if (!status.tunnelId) return { ok: false, provider: this.name, error: secureMcpError("entitlement_missing", "tunnel id is not configured") };
    if (!status.command) return { ok: false, provider: this.name, error: secureMcpError("command_not_configured", "MCP command is not configured") };
    try {
      this.child = this.spawnImpl(binaryPath, ["run", "--profile", status.profile], {
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
      this.logger.info(`Started Secure MCP Tunnel profile=${status.profile}`);
      return { ok: true, provider: this.name, pid: this.child.pid ?? null, url: this.getPublicUrl() };
    } catch (error) {
      return {
        ok: false,
        provider: this.name,
        error: secureMcpError("process_spawn_failed", error instanceof Error ? error.message : String(error)),
      };
    }
  }

  async restart(_localPort?: number): Promise<{ ok: true; provider: string; pid: number | null; url: string | null } | { ok: false; provider: string; error: SecureMcpError }> {
    const stopped = await this.stop();
    if (!stopped.ok) return stopped;
    return this.start();
  }

  getPublicUrl(): string | null {
    return null;
  }

  async stop(): Promise<{ ok: true; provider: string } | { ok: false; provider: string; error: SecureMcpError }> {
    if (!this.child) return { ok: true, provider: this.name };
    try {
      const killed = this.child.kill("SIGTERM");
      this.child = null;
      if (!killed) {
        return { ok: false, provider: this.name, error: secureMcpError("stop_failed", "secure MCP tunnel refused SIGTERM") };
      }
      return { ok: true, provider: this.name };
    } catch (error) {
      return {
        ok: false,
        provider: this.name,
        error: secureMcpError("stop_failed", error instanceof Error ? error.message : String(error)),
      };
    }
  }

  private binary(): string | null {
    return this.binaryOverride ?? findBinary("tunnel-client");
  }

  private async spawnExit(command: string, args: string[]): Promise<void> {
    const child = this.spawnImpl(command, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    await new Promise<void>((resolve) => {
      child.once("exit", () => resolve());
      child.once("error", () => resolve());
    });
  }
}
