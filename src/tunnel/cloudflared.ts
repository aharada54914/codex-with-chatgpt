import { spawn, type ChildProcess } from "node:child_process";
import readline from "node:readline";
import type { Logger } from "../logger/index.js";
import { nullLogger } from "../logger/index.js";
import { SERVICE_NAME } from "../version.js";
import { findBinary } from "./detect.js";
import type {
  TunnelDoctorReport,
  TunnelError,
  TunnelProvider,
  TunnelStartResult,
  TunnelStatus,
  TunnelStopResult,
} from "./provider.js";

const QUICK_TUNNEL_URL_RE = /https:\/\/[^\s|]+/gi;
const QUICK_TUNNEL_HOST_RE = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)\.trycloudflare\.com$/i;
const HEALTH_CHECK_INTERVAL_MS = 250;
const HEALTH_CHECK_TIMEOUT_MS = 5_000;

function isBridgeHealth(payload: unknown): boolean {
  if (!payload || typeof payload !== "object") return false;
  const health = payload as Record<string, unknown>;
  return health.service === SERVICE_NAME && health.status === "ok";
}

function tunnelError(code: TunnelError["code"], message: string, detail?: string): TunnelError {
  return { code, message, detail };
}

async function bridgeHealth(
  fetchImpl: NonNullable<CloudflaredQuickTunnelOptions["fetchImpl"]>,
  publicUrl: string
): Promise<{ ready: boolean; code?: TunnelError["code"]; detail: string }> {
  const response = await fetchImpl(new URL("/health", publicUrl).toString(), {
    redirect: "error",
    signal: AbortSignal.timeout(HEALTH_CHECK_TIMEOUT_MS),
  });
  if (!response) return { ready: false, code: "health_check_failed", detail: "Health check did not run" };
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    return {
      ready: false,
      code: "health_check_failed",
      detail: `Health check returned HTTP ${response.status}`,
    };
  }
  return {
    ready: isBridgeHealth(await response.json().catch(() => null)),
    code: "health_check_failed",
    detail: `Health check did not identify ${SERVICE_NAME}`,
  };
}

/** Extract a Quick Tunnel public URL from a cloudflared log line. */
export function parseQuickTunnelUrl(line: string): string | null {
  for (const match of line.matchAll(QUICK_TUNNEL_URL_RE)) {
    try {
      const url = new URL(match[0]);
      if (url.protocol !== "https:" || !QUICK_TUNNEL_HOST_RE.test(url.hostname)) continue;
      if (url.hostname.toLowerCase() === "api.trycloudflare.com") continue;
      return url.origin;
    } catch {
      // Ignore malformed URLs embedded in log output.
    }
  }
  return null;
}

export interface CloudflaredQuickTunnelOptions {
  startTimeoutMs?: number;
  spawnImpl?: (
    command: string,
    args: string[],
    options: { stdio: ["ignore", "pipe", "pipe"]; windowsHide: true }
  ) => ChildProcess;
  fetchImpl?: (input: string | URL, init?: RequestInit) => Promise<Response>;
}

/**
 * Cloudflare Quick Tunnel provider.
 * Quick Tunnels need no account/login; the URL changes on every start,
 * which the bridge and the Skill handle by reconfiguring automatically.
 */
export class CloudflaredQuickTunnel implements TunnelProvider {
  readonly name = "cloudflare-quick";
  private child: ChildProcess | null = null;
  private url: string | null = null;
  private lastError: string | null = null;
  private lastFailureCode: TunnelError["code"] | null = null;
  private readonly startTimeoutMs: number;
  private readonly spawnImpl: NonNullable<CloudflaredQuickTunnelOptions["spawnImpl"]>;
  private readonly fetchImpl: NonNullable<CloudflaredQuickTunnelOptions["fetchImpl"]>;
  private starting: Promise<TunnelStartResult> | null = null;
  private cancelStart: (() => void) | null = null;

  constructor(
    private readonly logger: Logger = nullLogger,
    private readonly binaryOverride?: string,
    options: CloudflaredQuickTunnelOptions = {}
  ) {
    this.startTimeoutMs = options.startTimeoutMs ?? 45_000;
    this.spawnImpl = options.spawnImpl ?? ((command, args, spawnOptions) => spawn(command, args, spawnOptions));
    this.fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
  }

  private binary(): string | null {
    return this.binaryOverride ?? findBinary("cloudflared");
  }

  async start(localPort: number): Promise<TunnelStartResult> {
    if (this.child && this.url) return { ok: true, provider: this.name, url: this.url };
    if (this.starting) return this.starting;
    if (this.child) {
      return {
        ok: false,
        provider: this.name,
        error: tunnelError(
          "start_conflict",
          "A tunnel process is still running without a public URL; stop it before starting another"
        ),
      };
    }
    const starting = this.startProcess(localPort);
    this.starting = starting;
    try {
      return await starting;
    } finally {
      if (this.starting === starting) this.starting = null;
    }
  }

  private startProcess(localPort: number): Promise<TunnelStartResult> {
    const bin = this.binary();
    if (!bin) {
      return Promise.resolve({
        ok: false,
        provider: this.name,
        error: tunnelError(
          "binary_not_found",
          "cloudflared is not installed. Install it (e.g. `brew install cloudflared`) and retry."
        ),
      });
    }

    return new Promise<TunnelStartResult>((resolve) => {
      let child: ChildProcess;
      try {
        child = this.spawnImpl(
          bin,
          ["tunnel", "--url", `http://127.0.0.1:${localPort}`, "--no-autoupdate"],
          { stdio: ["ignore", "pipe", "pipe"], windowsHide: true }
        );
      } catch (error) {
        resolve({
          ok: false,
          provider: this.name,
          error: {
            code: "process_spawn_failed",
            message: error instanceof Error ? error.message : String(error),
          },
        });
        return;
      }
      this.child = child;
      this.url = null;
      this.lastError = null;
      this.lastFailureCode = null;
      let settled = false;
      let candidateUrl: string | null = null;
      let cancel: (() => void) | null = null;
      let timeout: ReturnType<typeof setTimeout> | undefined;

      const closeReaders = (): void => {
        child.stdout?.destroy();
        child.stderr?.destroy();
      };

      const isAlive = (): boolean => this.child === child;

      const stopChild = (): boolean => {
        if (this.child !== child) return true;
        try {
          return child.kill("SIGTERM");
        } catch {
          return false;
        }
      };

      const finish = (callback: () => void, closeOutput = true): void => {
        if (settled) return;
        settled = true;
        if (timeout) clearTimeout(timeout);
        if (closeOutput) closeReaders();
        if (cancel && this.cancelStart === cancel) this.cancelStart = null;
        callback();
      };

      const fail = (error: unknown, code?: TunnelError["code"]): void => {
        finish(() => {
          const stopped = stopChild();
          if (stopped && this.child === child) {
            this.child = null;
            this.url = null;
          }
          const resolvedCode =
            !stopped
              ? "stop_failed"
              : code ??
                this.lastFailureCode ??
                (error instanceof Error && error.message.includes("timed out")
                  ? "start_timeout"
                  : error instanceof Error && error.message.includes("stopped")
                    ? "start_stopped"
                    : error instanceof Error && error.message.includes("spawn")
                      ? "process_spawn_failed"
                      : "process_exited");
          const message = error instanceof Error ? error.message : String(error);
          resolve({
            ok: false,
            provider: this.name,
            error: tunnelError(
              resolvedCode,
              stopped ? message : `${message}; tunnel process could not be stopped`
            ),
          });
        });
      };

      cancel = () => fail(new Error("Tunnel start stopped"), "start_stopped");
      this.cancelStart = cancel;

      const ready = (url: string): void => {
        if (!isAlive()) {
          fail(new Error("cloudflared exited before the public health endpoint became ready"));
          return;
        }
        finish(
          () => {
            this.url = url;
            this.lastError = null;
            this.logger.info(`Quick tunnel established: ${url}`);
            resolve({ ok: true, provider: this.name, url });
          },
          false
        );
      };

      const waitForHealth = async (): Promise<void> => {
        const publicUrl = candidateUrl;
        if (!publicUrl) return;
        while (!settled) {
          if (!isAlive()) {
            fail(new Error("cloudflared exited before the public health endpoint became ready"));
            return;
          }

          try {
            const result = await bridgeHealth(this.fetchImpl, publicUrl);
            if (settled) return;
            if (result.ready) {
              ready(publicUrl);
              return;
            }
            this.lastError = result.detail;
            this.lastFailureCode = result.code ?? "health_check_failed";
          } catch (error) {
            if (settled) return;
            this.lastError = error instanceof Error ? error.message : String(error);
            this.lastFailureCode = "health_check_failed";
          }
          if (settled) return;
          await new Promise((resolveWait) => setTimeout(resolveWait, HEALTH_CHECK_INTERVAL_MS));
        }
      };

      timeout = setTimeout(() => {
        if (!settled) {
          this.logger.error(`Quick tunnel did not become ready within ${this.startTimeoutMs}ms`);
          fail(
            new Error(
              this.lastFailureCode === "health_check_failed" && this.lastError
                ? this.lastError
                : "Tunnel start timed out"
            ),
            this.lastFailureCode === "health_check_failed" ? "health_check_failed" : "start_timeout"
          );
        }
      }, this.startTimeoutMs);

      const scan = (stream: NodeJS.ReadableStream): void => {
        const rl = readline.createInterface({ input: stream });
        rl.on("line", (line) => {
          const url = parseQuickTunnelUrl(line);
          if (url && !candidateUrl) {
            candidateUrl = url;
            void waitForHealth().catch((error) => {
              this.logger.error(`Quick tunnel health check failed: ${String(error)}`);
            });
          }
          if (/\b(?:ERR|error|failed|fatal)\b/i.test(line)) {
            this.lastError = line.slice(0, 400);
            if (/health/i.test(line)) this.lastFailureCode = "health_check_failed";
            this.logger.debug(`cloudflared: ${line.slice(0, 400)}`);
          }
        });
      };
      if (child.stdout) scan(child.stdout);
      if (child.stderr) scan(child.stderr);

      child.on("error", (error) => {
        closeReaders();
        if (this.child === child) {
          this.child = null;
          this.url = null;
        }
        if (!settled) fail(error, "process_spawn_failed");
      });
      child.on("exit", (code) => {
        closeReaders();
        if (this.child === child) {
          this.child = null;
          this.url = null;
          this.lastError = `cloudflared exited (code ${code})`;
        }
        this.logger.warn(`cloudflared exited with code ${code}`);
        if (!settled) {
          fail(
            new Error(
              `cloudflared exited (code ${code}) before establishing a tunnel${this.lastError ? `: ${this.lastError}` : ""}`
            ),
            this.lastFailureCode ?? "process_exited"
          );
        }
      });
    });
  }

  async stop(): Promise<TunnelStopResult> {
    if (this.child) {
      const child = this.child;
      const killed = (() => {
        try {
          return child.kill("SIGTERM");
        } catch {
          return false;
        }
      })();
      if (!killed) {
        return {
          ok: false,
          provider: this.name,
          error: { code: "stop_failed", message: "Failed to stop tunnel" },
        };
      }
      if (this.child === child) this.child = null;
      this.cancelStart?.();
    } else {
      this.cancelStart?.();
    }
    this.url = null;
    this.lastError = null;
    this.lastFailureCode = null;
    return { ok: true, provider: this.name };
  }

  async restart(localPort: number): Promise<TunnelStartResult> {
    const stopped = await this.stop();
    if (!stopped.ok) return stopped;
    return this.start(localPort);
  }

  status(): TunnelStatus {
    const processRunning = this.child !== null;
    return {
      running: processRunning,
      url: this.url,
      provider: this.name,
      detail: this.lastError ?? undefined,
      state: processRunning ? (this.url ? "running" : "starting") : "stopped",
    };
  }

  getPublicUrl(): string | null {
    return this.url;
  }

  async doctor(): Promise<TunnelDoctorReport> {
    const bin = this.binary();
    const problems: string[] = [];
    const errors: TunnelError[] = [];
    if (!bin) problems.push("cloudflared binary not found");
    if (!bin) {
      errors.push({ code: "binary_not_found", message: "cloudflared binary not found" });
    }
    if (bin && !this.child) {
      problems.push("tunnel process not running");
      errors.push({ code: "start_stopped", message: "tunnel process not running" });
    }
    if (this.child && !this.url) {
      problems.push("tunnel running but no public URL yet");
      errors.push({
        code: this.lastFailureCode ?? "health_check_failed",
        message: this.lastError ?? "tunnel running but no public URL yet",
      });
    }
    return {
      ok: problems.length === 0,
      provider: this.name,
      binaryFound: bin !== null,
      binaryPath: bin,
      running: this.child !== null,
      url: this.url,
      problems,
      errors,
    };
  }
}
