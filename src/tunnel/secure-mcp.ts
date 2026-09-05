import { spawn, type ChildProcess } from "node:child_process";
import { createInterface, type Interface } from "node:readline";
import { findBinary } from "../core/binary.js";
import type { Logger } from "../logger/index.js";
import { nullLogger } from "../logger/index.js";
import type { TunnelDoctorReport, TunnelError, TunnelProvider, TunnelStartResult, TunnelStatus } from "./provider.js";

const DEFAULT_SAMPLE = "sample_mcp_stdio_local";
const DEFAULT_START_TIMEOUT_MS = 30_000;
const DEFAULT_STOP_TIMEOUT_MS = 5_000;
const DEFAULT_COMMAND_TIMEOUT_MS = 5_000;
const DEFAULT_READINESS_POLL_INTERVAL_MS = 100;
const MAX_CAPTURE_CHARS = 6_000;
const MAX_DETAIL_CHARS = 8_000;
const SECRET_ENV_NAME = "CONTROL_PLANE_API_KEY";
const INCOMPATIBLE_LINE = /\b(incompatible|unsupported|version mismatch|upgrade required|requires .* version)\b/i;
const VERSION_LINE = /\b(?:version|v)\s*(\d+(?:\.\d+){1,2}(?:[-+][\w.-]+)?)\b/i;
const MIN_COMPATIBLE_VERSION = { major: 2, minor: 0, patch: 0 };

export type SecureMcpErrorCode =
  | TunnelError["code"]
  | "entitlement_missing"
  | "profile_not_configured"
  | "command_not_configured"
  | "readiness_not_configured"
  | "doctor_failed"
  | "version_probe_failed"
  | "init_failed";

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
  version: string | null;
  compatible: boolean | null;
  detail: string | null;
  problems: string[];
  errors: SecureMcpError[];
}

export interface SecureMcpStatus {
  configured: boolean;
  running: boolean;
  profile: string | null;
  tunnelId: string | null;
  command: string | null;
  version: string | null;
  pid: number | null;
  detail?: string;
}

export interface SecureMcpVersionProbeResult {
  version: string | null;
  compatible: boolean;
  detail?: string;
  error?: SecureMcpError;
}

export interface SecureMcpReadinessProbeContext {
  localPort: number;
  profile: string;
  tunnelId: string;
  command: string;
  output: string;
  detail: string | null;
  env: NodeJS.ProcessEnv;
  signal: AbortSignal;
}

export interface SecureMcpReadinessProbeResult {
  ready: boolean;
  detail?: string;
  url?: string | null;
}

export interface SecureMcpClientOptions {
  logger?: Logger;
  binaryOverride?: string;
  profile?: string;
  tunnelId?: string;
  mcpCommand?: string;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  readinessUrl?: string | null;
  versionProbeImpl?: () => Promise<SecureMcpVersionProbeResult>;
  readinessProbeImpl?: (context: SecureMcpReadinessProbeContext) => Promise<SecureMcpReadinessProbeResult>;
  startTimeoutMs?: number;
  stopTimeoutMs?: number;
  commandTimeoutMs?: number;
  spawnImpl?: (
    command: string,
    args: string[],
    options: { stdio: ["ignore", "pipe", "pipe"]; windowsHide: true; env: NodeJS.ProcessEnv }
  ) => ChildProcess;
}

export type SecureMcpTunnelOptions = SecureMcpClientOptions;

interface SecureMcpRunResult {
  ok: true;
  provider: string;
  url: string | null;
  pid: number | null;
  detail?: string;
}

interface SecureMcpRunFailure {
  ok: false;
  provider: string;
  error: SecureMcpError;
}

type SecureMcpRunOutcome = SecureMcpRunResult | SecureMcpRunFailure;

interface SpawnCapture {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  spawnError: string | null;
}

function secureMcpError(code: SecureMcpErrorCode, message: string, detail?: string): SecureMcpError {
  return detail ? { code, message, detail } : { code, message };
}

function appendBounded(base: string, next: string, limit: number): string {
  const combined = `${base}${next}`;
  return combined.length <= limit ? combined : combined.slice(combined.length - limit);
}

function redact(text: string, values: Array<string | undefined | null>): string {
  let output = text;
  for (const value of values) {
    const token = value?.trim();
    if (!token) continue;
    output = output.split(token).join("[REDACTED]");
  }
  return output;
}

function normalizeLine(line: string): string {
  return line.replace(/\s+/g, " ").trim();
}

function summarizeOutput(stdout: string, stderr: string, exitCode: number | null, signal: NodeJS.Signals | null): string {
  return [
    `exitCode=${exitCode === null ? "null" : exitCode}`,
    `signal=${signal ?? "null"}`,
    `stdout:\n${stdout || "(empty)"}`,
    `stderr:\n${stderr || "(empty)"}`,
  ].join("\n");
}

function extractVersion(text: string): string | null {
  return text.match(VERSION_LINE)?.[1] ?? null;
}

function parseVersion(version: string | null): { major: number; minor: number; patch: number } | null {
  if (!version) return null;
  const [major, minor = "0", patch = "0"] = version.split(".");
  const parsed = [major, minor, patch].map((part) => Number.parseInt(part, 10));
  if (parsed.some((part) => !Number.isInteger(part) || part < 0)) return null;
  return { major: parsed[0], minor: parsed[1], patch: parsed[2] };
}

function compareVersions(a: { major: number; minor: number; patch: number }, b: { major: number; minor: number; patch: number }): number {
  if (a.major !== b.major) return a.major > b.major ? 1 : -1;
  if (a.minor !== b.minor) return a.minor > b.minor ? 1 : -1;
  if (a.patch !== b.patch) return a.patch > b.patch ? 1 : -1;
  return 0;
}

function containsIncompatibleMarker(text: string): boolean {
  return INCOMPATIBLE_LINE.test(text);
}

export class SecureMcpTunnelClient implements TunnelProvider {
  readonly name = "secure-mcp";

  private readonly logger: Logger;
  private readonly spawnImpl: NonNullable<SecureMcpClientOptions["spawnImpl"]>;
  private readonly binaryOverride?: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly fetchImpl: typeof fetch;
  private readonly readinessUrl: string | null;
  private readonly versionProbeImpl?: () => Promise<SecureMcpVersionProbeResult>;
  private readonly readinessProbeImpl?: (context: SecureMcpReadinessProbeContext) => Promise<SecureMcpReadinessProbeResult>;
  private readonly startTimeoutMs: number;
  private readonly stopTimeoutMs: number;
  private readonly commandTimeoutMs: number;
  private readonly readinessPollIntervalMs: number;
  private profile: string | null;
  private tunnelId: string | null;
  private mcpCommand: string | null;
  private child: ChildProcess | null = null;
  private lifecycle: "stopped" | "starting" | "running" = "stopped";
  private publicUrl: string | null = null;
  private lastDetail: string | null = null;
  private lastVersion: string | null = null;
  private currentStart: Promise<SecureMcpRunOutcome> | null = null;
  private currentStartAbort: AbortController | null = null;

  constructor(options: SecureMcpClientOptions = {}) {
    this.logger = options.logger ?? nullLogger;
    this.spawnImpl = options.spawnImpl ?? ((command, args, spawnOptions) => spawn(command, args, spawnOptions));
    this.binaryOverride = options.binaryOverride;
    this.env = options.env ?? process.env;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.readinessUrl = options.readinessUrl ?? null;
    this.versionProbeImpl = options.versionProbeImpl;
    this.readinessProbeImpl = options.readinessProbeImpl;
    this.startTimeoutMs = options.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS;
    this.stopTimeoutMs = options.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS;
    this.commandTimeoutMs = options.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
    this.readinessPollIntervalMs = DEFAULT_READINESS_POLL_INTERVAL_MS;
    this.profile = options.profile ?? null;
    this.tunnelId = options.tunnelId ?? null;
    this.mcpCommand = options.mcpCommand ?? null;
  }

  configure(options?: { profile?: string; tunnelId?: string; mcpCommand?: string }): SecureMcpStatus {
    if (options?.profile !== undefined) this.profile = options.profile;
    if (options?.tunnelId !== undefined) this.tunnelId = options.tunnelId;
    if (options?.mcpCommand !== undefined) this.mcpCommand = options.mcpCommand;
    return this.status();
  }

  status(): TunnelStatus & SecureMcpStatus {
    return {
      configured: this.isConfigured(),
      running: this.lifecycle !== "stopped" && this.child !== null,
      profile: this.profile,
      tunnelId: this.tunnelId,
      command: this.mcpCommand,
      version: this.lastVersion,
      pid: this.child?.pid ?? null,
      detail: this.lastDetail ?? undefined,
      url: this.publicUrl,
      provider: this.name,
      state: this.lifecycle,
    };
  }

  async doctor(): Promise<TunnelDoctorReport & SecureMcpDoctorReport> {
    const binaryPath = this.binary();
    const versionProbe = await this.probeVersion(binaryPath);
    this.lastVersion = versionProbe.version ?? this.lastVersion;
    const problems: string[] = [];
    const errors: SecureMcpError[] = [];
    const readinessError = this.readinessConfigurationError();
    const prereqs = [
      ...this.prerequisiteErrors(),
      ...(readinessError ? [readinessError] : []),
    ];

    if (!binaryPath) {
      const detail = this.buildDetail("tunnel-client is not installed");
      return this.makeDoctorReport({
        binaryFound: false,
        binaryPath: null,
        version: versionProbe.version,
        compatible: false,
        detail,
        problems: ["tunnel-client is not installed"],
        errors: [secureMcpError("binary_not_found", "tunnel-client is not installed", detail)],
      });
    }

    if (prereqs.length) {
      const detail = this.buildDetail("configuration incomplete");
      return this.makeDoctorReport({
        binaryFound: true,
        binaryPath,
        version: versionProbe.version,
        compatible: versionProbe.compatible,
        detail,
        problems: prereqs.map((error) => error.message),
        errors: prereqs,
      });
    }

    if (versionProbe.error) {
      return this.makeDoctorReport({
        binaryFound: Boolean(binaryPath),
        binaryPath,
        version: versionProbe.version,
        compatible: false,
        detail: this.buildDetail(versionProbe.error.detail ?? versionProbe.error.message),
        problems: [versionProbe.error.message],
        errors: [versionProbe.error],
      });
    }
    if (!versionProbe.compatible) {
      const detail = this.buildDetail(versionProbe.detail ?? "tunnel-client version is incompatible");
      return this.makeDoctorReport({
        binaryFound: true,
        binaryPath,
        version: versionProbe.version,
        compatible: false,
        detail,
        problems: [versionProbe.detail ?? "tunnel-client version is incompatible"],
        errors: [secureMcpError("client_incompatible", "tunnel-client version is incompatible", detail)],
      });
    }

    const capture = await this.captureCommand(binaryPath, ["doctor", "--profile", this.profile!, "--explain"], this.commandTimeoutMs);
    const detail = this.buildDetail(summarizeOutput(capture.stdout, capture.stderr, capture.exitCode, capture.signal));
    const incompatible = containsIncompatibleMarker(`${capture.stdout}\n${capture.stderr}`);
    const version = versionProbe.version ?? extractVersion(`${capture.stdout}\n${capture.stderr}`);
    this.lastVersion = version ?? this.lastVersion;

    if (capture.spawnError) {
      return this.makeDoctorReport({
        binaryFound: true,
        binaryPath,
        version,
        compatible: !incompatible,
        detail,
        problems: ["tunnel-client doctor could not start"],
        errors: [secureMcpError("doctor_failed", "tunnel-client doctor could not start", capture.spawnError)],
      });
    }

    if (capture.exitCode !== 0) {
      const code = incompatible ? "client_incompatible" : "doctor_failed";
      const message = incompatible
        ? "tunnel-client doctor reported an incompatible client"
        : "tunnel-client doctor reported a failure";
      return this.makeDoctorReport({
        binaryFound: true,
        binaryPath,
        version,
        compatible: !incompatible,
        detail,
        problems: [message],
        errors: [secureMcpError(code, message, detail)],
      });
    }

    return this.makeDoctorReport({
      binaryFound: true,
      binaryPath,
      version,
      compatible: true,
      detail,
      problems,
      errors,
    });
  }

  async init(sample = DEFAULT_SAMPLE): Promise<{ ok: true; detail: string | null } | { ok: false; error: SecureMcpError }> {
    const binaryPath = this.binary();
    if (!binaryPath) return { ok: false, error: secureMcpError("binary_not_found", "tunnel-client is not installed") };
    const prereqs = this.prerequisiteErrors();
    if (prereqs.length) return { ok: false, error: prereqs[0] };
    const versionProbe = await this.probeVersion(binaryPath);
    if (versionProbe.error) return { ok: false, error: versionProbe.error };
    if (!versionProbe.compatible) {
      return {
        ok: false,
        error: secureMcpError("client_incompatible", "tunnel-client version is incompatible", versionProbe.detail),
      };
    }

    const capture = await this.captureCommand(binaryPath, [
      "init",
      "--sample",
      sample,
      "--profile",
      this.profile!,
      "--tunnel-id",
      this.tunnelId!,
      "--mcp-command",
      this.mcpCommand!,
    ], this.commandTimeoutMs);
    const detail = this.buildDetail(summarizeOutput(capture.stdout, capture.stderr, capture.exitCode, capture.signal));
    if (capture.spawnError) {
      return {
        ok: false,
        error: secureMcpError("init_failed", "tunnel-client init could not start", capture.spawnError),
      };
    }
    if (capture.exitCode !== 0) {
      const incompatible = containsIncompatibleMarker(`${capture.stdout}\n${capture.stderr}`);
      return {
        ok: false,
        error: secureMcpError(
          incompatible ? "client_incompatible" : "init_failed",
          incompatible ? "tunnel-client init reported an incompatible client" : "tunnel-client init reported a failure",
          detail
        ),
      };
    }
    return { ok: true, detail };
  }

  async start(localPort: number): Promise<SecureMcpRunOutcome> {
    if (this.currentStart) return this.currentStart;
    const binaryPath = this.binary();
    if (!binaryPath) {
      return { ok: false, provider: this.name, error: secureMcpError("binary_not_found", "tunnel-client is not installed") };
    }
    const prereqs = this.prerequisiteErrors();
    if (prereqs.length) return { ok: false, provider: this.name, error: prereqs[0] };
    const readinessError = this.readinessConfigurationError();
    if (readinessError) return { ok: false, provider: this.name, error: readinessError };

    if (this.child && this.lifecycle === "running") {
      return { ok: true, provider: this.name, url: this.publicUrl, pid: this.child.pid ?? null, detail: this.lastDetail ?? undefined };
    }
    if (this.child) {
      return {
        ok: false,
        provider: this.name,
        error: secureMcpError("start_conflict", "A secure MCP process is already starting; stop it before starting another"),
      };
    }

    const abortController = new AbortController();
    this.currentStartAbort = abortController;
    const startPromise = this.startProcess(binaryPath, localPort, abortController.signal);
    this.currentStart = startPromise;
    try {
      return await startPromise;
    } finally {
      if (this.currentStart === startPromise) this.currentStart = null;
      if (this.currentStartAbort === abortController) this.currentStartAbort = null;
    }
  }

  async restart(localPort: number): Promise<SecureMcpRunOutcome> {
    const stopped = await this.stop();
    if (!stopped.ok) return stopped;
    return this.start(localPort);
  }

  getPublicUrl(): string | null {
    return this.publicUrl;
  }

  async stop(): Promise<{ ok: true; provider: string } | { ok: false; provider: string; error: SecureMcpError }> {
    if (!this.child) {
      this.currentStart = null;
      this.currentStartAbort?.abort();
      this.currentStartAbort = null;
      this.lifecycle = "stopped";
      this.publicUrl = null;
      this.lastDetail = null;
      return { ok: true, provider: this.name };
    }

    let killed = false;
    try {
      killed = this.child.kill("SIGTERM");
    } catch (error) {
      killed = false;
      this.lastDetail = error instanceof Error ? error.message : String(error);
    }

    if (!killed) {
      const detail = this.lastDetail ?? "secure MCP tunnel refused SIGTERM";
      return {
        ok: false,
        provider: this.name,
        error: secureMcpError("stop_failed", "secure MCP tunnel refused SIGTERM", detail),
      };
    }

    const child = this.child;
    this.currentStartAbort?.abort();
    const exitWait = this.waitForExit(child, this.stopTimeoutMs);
    const exited = await exitWait;
    if (!exited) {
      return {
        ok: false,
        provider: this.name,
        error: secureMcpError("stop_failed", "secure MCP tunnel did not exit after SIGTERM", this.lastDetail ?? "stop timeout"),
      };
    }
    this.child = null;
    this.publicUrl = null;
    this.lifecycle = "stopped";
    this.lastDetail = null;
    this.currentStartAbort?.abort();
    this.currentStartAbort = null;
    return { ok: true, provider: this.name };
  }

  private async startProcess(binaryPath: string, localPort: number, signal: AbortSignal): Promise<SecureMcpRunOutcome> {
    if (signal.aborted) {
      return { ok: false, provider: this.name, error: secureMcpError("interrupted", "Secure MCP tunnel start interrupted") };
    }
    const versionProbe = await this.probeVersion(binaryPath);
    if (signal.aborted) {
      return { ok: false, provider: this.name, error: secureMcpError("interrupted", "Secure MCP tunnel start interrupted") };
    }
    if (versionProbe.error) {
      return { ok: false, provider: this.name, error: versionProbe.error };
    }
    if (!versionProbe.compatible) {
      return {
        ok: false,
        provider: this.name,
        error: secureMcpError("client_incompatible", "tunnel-client version is incompatible", versionProbe.detail),
      };
    }

    let child: ChildProcess;
    try {
      child = this.spawnImpl(binaryPath, ["run", "--profile", this.profile!], {
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        env: this.env,
      });
    } catch (error) {
      return {
        ok: false,
        provider: this.name,
        error: secureMcpError(
          "process_spawn_failed",
          "tunnel-client run could not start",
          error instanceof Error ? error.message : String(error)
        ),
      };
    }

    this.child = child;
    this.lifecycle = "starting";
    this.publicUrl = null;
    this.lastDetail = null;
    if (signal.aborted) {
      try {
        child.kill("SIGTERM");
      } catch {
        // ignore; interruption should still resolve as interrupted
      }
      this.lastDetail = this.buildDetail("Secure MCP tunnel start interrupted");
      return { ok: false, provider: this.name, error: secureMcpError("interrupted", "Secure MCP tunnel start interrupted") };
    }

    return await new Promise<SecureMcpRunOutcome>((resolve) => {
      let settled = false;
      let timeout: ReturnType<typeof setTimeout> | null = null;
      let readinessTimer: ReturnType<typeof setInterval> | null = null;
      let stdout = "";
      let stderr = "";
      let readinessInFlight = false;
      const readyAbort = new AbortController();
      const trackChildExit = (detail: string): void => {
        if (this.child !== child) return;
        this.child = null;
        this.publicUrl = null;
        this.lifecycle = "stopped";
        this.lastDetail = detail;
      };
      const cleanup = (): void => {
        if (timeout) clearTimeout(timeout);
        if (readinessTimer) clearInterval(readinessTimer);
        readyAbort.abort();
        signal.removeEventListener("abort", onAbort);
      };
      const onAbort = (): void => {
        if (settled) return;
        if (this.child === child) {
          try {
            child.kill("SIGTERM");
          } catch {
            // handled by exit event or timeout
          }
        }
        this.lastDetail = this.buildDetail("Secure MCP tunnel start interrupted");
      };
      signal.addEventListener("abort", onAbort, { once: true });
      const stdoutReader = this.attachReader(child.stdout, (line) => {
        stdout = appendBounded(stdout, `${line}\n`, MAX_CAPTURE_CHARS);
        return line;
      });
      const stderrReader = this.attachReader(child.stderr, (line) => {
        stderr = appendBounded(stderr, `${line}\n`, MAX_CAPTURE_CHARS);
        return line;
      });

      const finish = (result: SecureMcpRunOutcome): void => {
        if (settled) return;
        settled = true;
        cleanup();
        stdoutReader?.close();
        stderrReader?.close();
        resolve(result);
      };

      const fail = (error: SecureMcpError, attemptStop = true): void => {
        if (settled) return;
        this.lastDetail = this.buildDetail(error.detail ?? error.message);
        this.lifecycle = this.child === child ? "starting" : this.lifecycle;
        let stopRequested = false;
        if (attemptStop && this.child === child) {
          try {
            stopRequested = child.kill("SIGTERM");
          } catch {
            stopRequested = false;
          }
        }
        if (attemptStop && this.child === child && stopRequested) {
          void this.waitForExit(child, this.stopTimeoutMs).then((exited) => {
            if (exited) trackChildExit(this.buildDetail(summarizeOutput(stdout, stderr, null, null)));
          });
        }
        finish({ ok: false, provider: this.name, error });
      };

      const succeed = (result: SecureMcpRunResult): void => {
        if (settled) return;
        this.lifecycle = "running";
        this.publicUrl = result.url;
        this.lastDetail = result.detail ?? this.lastDetail;
        finish(result);
      };

      const probeReady = async (): Promise<void> => {
        if (settled || readinessInFlight) return;
        readinessInFlight = true;
        try {
          const readiness = await this.probeReadiness({
            localPort,
            profile: this.profile!,
            tunnelId: this.tunnelId!,
            command: this.mcpCommand!,
            output: `${stdout}\n${stderr}`,
            detail: this.lastDetail,
            env: this.env,
            signal: readyAbort.signal,
          });
          if (settled) return;
          if (readiness.detail) this.lastDetail = this.buildDetail(readiness.detail);
          if (readiness.url !== undefined) this.publicUrl = readiness.url;
          if (readiness.ready) {
            succeed({
              ok: true,
              provider: this.name,
              url: this.publicUrl,
              pid: this.child?.pid ?? null,
              detail: this.lastDetail ?? undefined,
            });
          }
        } catch (error) {
          if (!settled) {
            this.lastDetail = error instanceof Error ? error.message : String(error);
          }
        } finally {
          readinessInFlight = false;
        }
      };

      const onLine = (line: string): void => {
        if (settled) return;
        const normalized = normalizeLine(redact(line, this.redactionValues()));
        if (!normalized) return;
        if (containsIncompatibleMarker(normalized)) {
          const detail = this.buildDetail(normalized);
          this.lastVersion = this.lastVersion ?? extractVersion(normalized);
          fail(secureMcpError("client_incompatible", "tunnel-client reported an incompatible version", detail));
          return;
        }
        const version = extractVersion(normalized);
        if (version) this.lastVersion = version;
      };

      stdoutReader?.on("line", onLine);
      stderrReader?.on("line", onLine);

      timeout = setTimeout(() => {
        if (settled) return;
        fail(secureMcpError("start_timeout", "secure MCP tunnel did not become ready in time", this.buildDetail("start timed out")));
      }, this.startTimeoutMs);

      if (this.readinessProbeImpl || this.readinessUrl) {
        void probeReady();
        readinessTimer = setInterval(() => {
          void probeReady();
        }, DEFAULT_READINESS_POLL_INTERVAL_MS);
      }

      child.once("error", (error) => {
        const detail = this.buildDetail(error instanceof Error ? error.message : String(error));
        trackChildExit(detail);
        if (settled) return;
        finish({
          ok: false,
          provider: this.name,
          error: secureMcpError("process_spawn_failed", "tunnel-client run could not start", detail),
        });
      });

      child.once("exit", (code, childSignal) => {
        const detail = this.buildDetail(summarizeOutput(stdout, stderr, code, childSignal));
        trackChildExit(detail);
        if (settled) return;
        if (signal.aborted) {
          finish({
            ok: false,
            provider: this.name,
            error: secureMcpError("interrupted", "Secure MCP tunnel start interrupted", detail),
          });
          return;
        }
        finish({
          ok: false,
          provider: this.name,
          error: secureMcpError(
            containsIncompatibleMarker(`${stdout}\n${stderr}`) ? "client_incompatible" : "process_exited",
            containsIncompatibleMarker(`${stdout}\n${stderr}`)
              ? "tunnel-client exited with an incompatible version"
              : `tunnel-client exited before it became ready (code ${code ?? "null"})`,
            detail
          ),
        });
      });
    });
  }

  private async probeVersion(binaryPath: string | null): Promise<SecureMcpVersionProbeResult> {
    if (this.versionProbeImpl) {
      try {
        return await this.versionProbeImpl();
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        return {
          version: null,
          compatible: false,
          detail,
          error: secureMcpError("version_probe_failed", "tunnel-client version probe failed", detail),
        };
      }
    }
    if (!binaryPath) {
      return {
        version: null,
        compatible: false,
        detail: "tunnel-client is not installed",
        error: secureMcpError("binary_not_found", "tunnel-client is not installed"),
      };
    }
    const capture = await this.captureCommand(binaryPath, ["--version"], this.commandTimeoutMs);
    if (capture.spawnError) {
      return {
        version: null,
        compatible: false,
        detail: capture.spawnError,
        error: secureMcpError("version_probe_failed", "tunnel-client version probe failed", capture.spawnError),
      };
    }
    if (capture.exitCode !== 0) {
      const detail = summarizeOutput(capture.stdout, capture.stderr, capture.exitCode, capture.signal);
      return {
        version: null,
        compatible: false,
        detail,
        error: secureMcpError("version_probe_failed", "tunnel-client version probe failed", detail),
      };
    }
    const text = `${capture.stdout}\n${capture.stderr}`.trim();
    const version = extractVersion(text) ?? text.match(/\b(\d+\.\d+\.\d+)\b/)?.[1] ?? null;
    const parsed = parseVersion(version);
    if (!parsed) {
      return {
        version,
        compatible: false,
        detail: text || "unable to parse tunnel-client version",
        error: secureMcpError("version_probe_failed", "unable to parse tunnel-client version", text || undefined),
      };
    }
    const compatible = compareVersions(parsed, MIN_COMPATIBLE_VERSION) >= 0;
    return {
      version,
      compatible,
      detail: text || undefined,
      error: compatible ? undefined : secureMcpError("client_incompatible", "tunnel-client version is incompatible", text || undefined),
    };
  }

  private async probeReadiness(context: SecureMcpReadinessProbeContext): Promise<SecureMcpReadinessProbeResult> {
    if (this.readinessProbeImpl) return this.readinessProbeImpl(context);
    if (this.readinessUrl) {
      const probeUrl = new URL(this.readinessUrl);
      const response = await this.fetchImpl(probeUrl, { method: "GET", signal: context.signal });
      const body = await response.text().catch(() => "");
      const ok = response.ok;
      return {
        ready: ok,
        detail: body || `${response.status} ${response.statusText}`,
        url: this.publicUrl,
      };
    }
    return {
      ready: false,
      detail: context.detail ?? "readiness probe is not configured",
      url: this.publicUrl,
    };
  }

  private binary(): string | null {
    return this.binaryOverride ?? findBinary("tunnel-client");
  }

  private isConfigured(): boolean {
    return this.profile !== null
      && this.tunnelId !== null
      && this.mcpCommand !== null
      && this.hasControlPlaneEntitlement()
      && this.readinessConfigurationError() === null;
  }

  private hasControlPlaneEntitlement(): boolean {
    return Boolean(this.env[SECRET_ENV_NAME]?.trim());
  }

  private prerequisiteErrors(): SecureMcpError[] {
    const errors: SecureMcpError[] = [];
    if (!this.profile) errors.push(secureMcpError("profile_not_configured", "profile is not configured"));
    if (!this.tunnelId) errors.push(secureMcpError("entitlement_missing", "tunnel id is not configured"));
    if (!this.mcpCommand) errors.push(secureMcpError("command_not_configured", "MCP command is not configured"));
    if (!this.hasControlPlaneEntitlement()) {
      errors.push(secureMcpError("entitlement_missing", `${SECRET_ENV_NAME} is not configured`));
    }
    return errors;
  }

  private readinessConfigurationError(): SecureMcpError | null {
    if (this.readinessProbeImpl || this.readinessUrl) return null;
    return secureMcpError("readiness_not_configured", "readiness probe or URL is not configured");
  }

  private async captureCommand(command: string, args: string[], timeoutMs = this.commandTimeoutMs): Promise<SpawnCapture> {
    const capture: SpawnCapture = { stdout: "", stderr: "", exitCode: null, signal: null, spawnError: null };
    let child: ChildProcess;
    try {
      child = this.spawnImpl(command, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true, env: this.env });
    } catch (error) {
      capture.spawnError = error instanceof Error ? error.message : String(error);
      return capture;
    }
    child.stdout?.on("data", (chunk: Buffer | string) => {
      capture.stdout = appendBounded(capture.stdout, redact(String(chunk), this.redactionValues()), MAX_CAPTURE_CHARS);
    });
    child.stderr?.on("data", (chunk: Buffer | string) => {
      capture.stderr = appendBounded(capture.stderr, redact(String(chunk), this.redactionValues()), MAX_CAPTURE_CHARS);
    });
    const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null; error?: Error }>((resolve) => {
      let resolved = false;
      const timeout = setTimeout(() => {
        if (resolved) return;
        resolved = true;
        const timeoutError = new Error(`${command} timed out after ${timeoutMs}ms`);
        try {
          child.kill("SIGTERM");
        } catch {
          // ignore; caller receives the timeout failure
        }
        resolve({ code: null, signal: null, error: timeoutError });
      }, timeoutMs);
      child.once("exit", (code, signal) => {
        if (resolved) return;
        resolved = true;
        clearTimeout(timeout);
        resolve({ code, signal });
      });
      child.once("error", (error) => {
        if (resolved) return;
        resolved = true;
        clearTimeout(timeout);
        resolve({ code: null, signal: null, error: error as Error });
      });
    });
    capture.exitCode = exit.code;
    capture.signal = exit.signal;
    capture.spawnError = exit.error?.message ?? null;
    return capture;
  }

  private attachReader(stream: NodeJS.ReadableStream | null | undefined, onLine: (line: string) => void): Interface | null {
    if (!stream) return null;
    const reader = createInterface({ input: stream });
    reader.on("line", onLine);
    return reader;
  }

  private buildDetail(text: string): string {
    return appendBounded("", redact(text, this.redactionValues()), MAX_DETAIL_CHARS);
  }

  private redactionValues(): Array<string | undefined | null> {
    return [this.env[SECRET_ENV_NAME], this.tunnelId ?? undefined, this.mcpCommand ?? undefined];
  }

  private async waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
    return await new Promise<boolean>((resolve) => {
      let resolved = false;
      const timeout = setTimeout(() => {
        if (resolved) return;
        resolved = true;
        child.off("exit", onExit);
        resolve(false);
      }, timeoutMs);
      const onExit = (): void => {
        if (resolved) return;
        resolved = true;
        clearTimeout(timeout);
        resolve(true);
      };
      child.once("exit", onExit);
    });
  }

  private makeDoctorReport(input: {
    binaryFound: boolean;
    binaryPath: string | null;
    version: string | null;
    compatible: boolean | null;
    detail: string | null;
    problems: string[];
    errors: SecureMcpError[];
  }): TunnelDoctorReport & SecureMcpDoctorReport {
    return {
      ok: input.errors.length === 0,
      provider: this.name,
      binaryFound: input.binaryFound,
      binaryPath: input.binaryPath,
      running: this.lifecycle !== "stopped" && this.child !== null,
      url: this.publicUrl,
      problems: input.problems,
      errors: input.errors,
      profile: this.profile ?? "",
      tunnelId: this.tunnelId,
      commandConfigured: Boolean(this.mcpCommand),
      version: input.version,
      compatible: input.compatible,
      detail: input.detail,
    };
  }
}
