import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { SecureMcpTunnelClient } from "../src/tunnel/secure-mcp.js";

const SECRET = "control-plane-secret";
const TUNNEL_ID = "tunnel-123";
const COMMAND = "node server.js";

class FakeChildProcess extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly pid = 4242;
  readonly kill = vi.fn(() => true);
}

function tick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function makeEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return { CONTROL_PLANE_API_KEY: SECRET, ...extra };
}

function createClient(options: {
  env?: NodeJS.ProcessEnv;
  versionProbeImpl?: () => Promise<{ version: string | null; compatible: boolean; detail?: string }>;
  readinessProbeImpl?: ConstructorParameters<typeof SecureMcpTunnelClient>[0]["readinessProbeImpl"];
  readinessUrl?: string | null;
  startTimeoutMs?: number;
  stopTimeoutMs?: number;
  profile?: string;
  tunnelId?: string;
  mcpCommand?: string;
  spawnImpl?: ConstructorParameters<typeof SecureMcpTunnelClient>[0]["spawnImpl"];
} = {}) {
  const versionProbeImpl =
    options.versionProbeImpl ?? (async () => ({ version: "2.1.0", compatible: true }));
  return new SecureMcpTunnelClient({
    binaryOverride: "/usr/local/bin/tunnel-client",
    env: options.env ?? makeEnv(),
    profile: options.profile ?? "local-stdio",
    tunnelId: options.tunnelId ?? TUNNEL_ID,
    mcpCommand: options.mcpCommand ?? COMMAND,
    versionProbeImpl,
    readinessProbeImpl: options.readinessProbeImpl,
    readinessUrl: options.readinessUrl ?? null,
    startTimeoutMs: options.startTimeoutMs,
    stopTimeoutMs: options.stopTimeoutMs,
    spawnImpl: options.spawnImpl,
  });
}

describe("SecureMcpTunnelClient", () => {
  it("reports unavailable binary without throwing", async () => {
    const client = new SecureMcpTunnelClient({
      env: makeEnv({ PATH: "" }),
      profile: "local-stdio",
      tunnelId: TUNNEL_ID,
      mcpCommand: COMMAND,
    });

    const report = await client.doctor();
    expect(report.ok).toBe(false);
    expect(report.errors[0]?.code).toBe("binary_not_found");
  });

  it("spawns tunnel-client --version and applies the compatibility policy", async () => {
    const versionChild = new FakeChildProcess();
    const doctorChild = new FakeChildProcess();
    const spawnImpl = vi.fn((command: string, args: string[], options: Parameters<NonNullable<ConstructorParameters<typeof SecureMcpTunnelClient>[0]["spawnImpl"]>>[2]) => {
      expect(command).toBe("/usr/local/bin/tunnel-client");
      expect(options.env).toMatchObject(makeEnv());
      if (args[0] === "--version") {
        queueMicrotask(() => {
          versionChild.stdout.write("tunnel-client version 2.1.0\n");
          versionChild.emit("exit", 0, null);
        });
        return versionChild as unknown as ChildProcess;
      }
      queueMicrotask(() => doctorChild.emit("exit", 0, null));
      return doctorChild as unknown as ChildProcess;
    });
    const client = new SecureMcpTunnelClient({
      binaryOverride: "/usr/local/bin/tunnel-client",
      env: makeEnv(),
      profile: "local-stdio",
      tunnelId: TUNNEL_ID,
      mcpCommand: COMMAND,
      spawnImpl,
    });

    const report = await client.doctor();
    expect(report.ok).toBe(true);
    expect(report.version).toBe("2.1.0");
    expect(report.compatible).toBe(true);
  });

  it("returns a typed failure when the version probe throws", async () => {
    const client = createClient({
      versionProbeImpl: async () => {
        throw new Error("probe boom");
      },
    });

    const report = await client.doctor();
    expect(report.ok).toBe(false);
    expect(report.errors[0]?.code).toBe("version_probe_failed");
  });

  it("redacts secret, tunnel id, and command from start detail", async () => {
    const child = new FakeChildProcess();
    const spawnImpl = vi.fn(() => {
      queueMicrotask(() => {
        child.stdout.write(`connecting ${SECRET} ${TUNNEL_ID} ${COMMAND}\n`);
        child.stdout.write("readyz ok\n");
      });
      return child as unknown as ChildProcess;
    });
    const readinessProbeImpl = vi.fn(async (context: Parameters<NonNullable<ConstructorParameters<typeof SecureMcpTunnelClient>[0]["readinessProbeImpl"]>>[0]) => ({
      ready: true,
      detail: context.output,
    }));
    const client = createClient({
      spawnImpl,
      readinessProbeImpl,
    });

    const result = await client.start(3333);
    expect(result.ok).toBe(true);
    expect(result.url).toBeNull();
    expect(readinessProbeImpl).toHaveBeenCalledTimes(1);
    const status = client.status();
    expect(status.detail).toContain("[REDACTED]");
    expect(status.detail).not.toContain(SECRET);
    expect(status.detail).not.toContain(TUNNEL_ID);
    expect(status.detail).not.toContain(COMMAND);
  });

  it("updates lifecycle when a running child exits after readiness", async () => {
    const child = new FakeChildProcess();
    const spawnImpl = vi.fn(() => {
      queueMicrotask(() => child.stdout.write("readyz ok\n"));
      return child as unknown as ChildProcess;
    });
    const client = createClient({
      spawnImpl,
      readinessProbeImpl: async () => ({ ready: true, detail: "ready" }),
    });

    await expect(client.start(3333)).resolves.toMatchObject({ ok: true });
    child.emit("exit", 1, null);
    await tick();
    expect(client.status()).toMatchObject({ running: false, state: "stopped" });
    expect(client.status().detail).toContain("exitCode=1");
  });

  it("shares concurrent starts", async () => {
    const child = new FakeChildProcess();
    const spawnImpl = vi.fn(() => {
      queueMicrotask(() => child.stdout.write("readyz ok\n"));
      return child as unknown as ChildProcess;
    });
    const client = createClient({
      spawnImpl,
      readinessProbeImpl: async () => ({ ready: true }),
    });

    const first = client.start(3333);
    const second = client.start(3333);
    await expect(Promise.all([first, second])).resolves.toMatchObject([
      { ok: true, provider: "secure-mcp" },
      { ok: true, provider: "secure-mcp" },
    ]);
    expect(spawnImpl).toHaveBeenCalledTimes(1);
  });

  it("treats stop during start as interrupted", async () => {
    const child = new FakeChildProcess();
    child.kill.mockImplementation(() => {
      queueMicrotask(() => child.emit("exit", 0, "SIGTERM"));
      return true;
    });
    const spawnImpl = vi.fn(() => child as unknown as ChildProcess);
    const client = createClient({
      spawnImpl,
      readinessProbeImpl: async () => new Promise((resolve) => setTimeout(() => resolve({ ready: true }), 50)),
      startTimeoutMs: 200,
      stopTimeoutMs: 25,
    });

    const starting = client.start(3333);
    await tick();
    const stopped = await client.stop();
    expect(stopped.ok).toBe(true);
    await expect(starting).resolves.toMatchObject({ ok: false, provider: "secure-mcp" });
    const outcome = await starting;
    if (!outcome.ok) expect(outcome.error.code).toBe("interrupted");
  });

  it("returns stop_failed and retains the child when SIGTERM does not exit", async () => {
    const child = new FakeChildProcess();
    child.kill.mockReturnValue(true);
    const spawnImpl = vi.fn(() => {
      queueMicrotask(() => child.stdout.write("readyz ok\n"));
      return child as unknown as ChildProcess;
    });
    const client = createClient({
      spawnImpl,
      readinessProbeImpl: async () => ({ ready: true }),
      stopTimeoutMs: 10,
    });

    await expect(client.start(3333)).resolves.toMatchObject({ ok: true });
    const stopped = await client.stop();
    expect(stopped.ok).toBe(false);
    if (!stopped.ok) expect(stopped.error.code).toBe("stop_failed");
    expect(client.status()).toMatchObject({ running: true, state: "running" });
  });

  it("returns init_failed on nonzero init exit", async () => {
    const child = new FakeChildProcess();
    const spawnImpl = vi.fn((command: string, args: string[], options: Parameters<NonNullable<ConstructorParameters<typeof SecureMcpTunnelClient>[0]["spawnImpl"]>>[2]) => {
      expect(command).toBe("/usr/local/bin/tunnel-client");
      expect(args[0]).toBe("init");
      expect(options.env).toMatchObject(makeEnv());
      queueMicrotask(() => {
        child.stderr.write("init failed\n");
        child.emit("exit", 1, null);
      });
      return child as unknown as ChildProcess;
    });
    const client = createClient({
      spawnImpl,
      versionProbeImpl: async () => ({ version: "2.1.0", compatible: true }),
    });

    const result = await client.init();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("init_failed");
  });

  it("forwards env to every spawn invocation", async () => {
    const child = new FakeChildProcess();
    const seen: Array<NodeJS.ProcessEnv> = [];
    const spawnImpl = vi.fn((command: string, args: string[], options: { env: NodeJS.ProcessEnv; stdio: ["ignore", "pipe", "pipe"]; windowsHide: true }) => {
      seen.push(options.env);
      queueMicrotask(() => {
        child.stdout.write(args[0] === "doctor" ? "doctor ok\n" : "readyz ok\n");
        child.emit("exit", 0, null);
      });
      return child as unknown as ChildProcess;
    });
    const client = createClient({
      spawnImpl,
      versionProbeImpl: async () => ({ version: "2.1.0", compatible: true }),
    });

    await client.doctor();
    await client.start(3333);
    expect(seen).toHaveLength(2);
    expect(seen[0]).toMatchObject(makeEnv());
    expect(seen[1]).toMatchObject(makeEnv());
  });
});
