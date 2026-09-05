import { describe, it, expect, afterEach, vi } from "vitest";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import type { ChildProcess } from "node:child_process";
import { PassThrough } from "node:stream";
import { findBinary } from "../src/tunnel/detect.js";
import { createCloudflareTransportProvider } from "../src/tunnel/cloudflare-provider.js";
import {
  CloudflaredQuickTunnel,
  parseQuickTunnelUrl,
  type CloudflaredQuickTunnelOptions,
} from "../src/tunnel/cloudflared.js";
import {
  CloudflaredNamedTunnel,
  normalizeNamedTunnelHostname,
} from "../src/tunnel/cloudflared-named.js";
import { hostnameSlug, parseZoneInput, suggestedNamedHostname } from "../src/tunnel/hostname.js";
import {
  chooseQuickTunnel,
  isBenignRouteError,
  parseCreatedTunnel,
  parseTunnelList,
  provisionNamedTunnel,
  type CloudflaredAccount,
} from "../src/tunnel/named-provision.js";
import { isNamedTunnelReady, needsTunnelChoice, readTunnelState } from "../src/tunnel/state.js";
import { cleanup, isolateStateDir, makeTmpDir, write } from "./helpers.js";

const stateDirs: string[] = [];
const previousStateDir = process.env.C2C_STATE_DIR;
const previousCloudflaredPath = process.env.C2C_CLOUDFLARED_PATH;
const QUICK_URL = "https://random-words-here-1234.trycloudflare.com";
type FetchImpl = NonNullable<CloudflaredQuickTunnelOptions["fetchImpl"]>;

class FakeCloudflaredProcess extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  killed = false;
  readonly kill = vi.fn(() => {
    this.killed = true;
    return true;
  });
}

function setupTunnel(fetchImpl: FetchImpl, startTimeoutMs = 1_000) {
  const child = new FakeCloudflaredProcess();
  const spawnImpl = vi.fn(() => child as unknown as ChildProcess);
  const tunnel = new CloudflaredQuickTunnel(undefined, "cloudflared", {
    spawnImpl,
    fetchImpl,
    startTimeoutMs,
  });
  return { child, spawnImpl, tunnel };
}

function announceUrl(child: FakeCloudflaredProcess): void {
  child.stderr.write(`INF ${QUICK_URL}\n`);
}

function healthResponse(): Response {
  return new Response(JSON.stringify({ service: "c2c-bridge", status: "ok" }), { status: 200 });
}

afterEach(() => {
  while (stateDirs.length) cleanup(stateDirs.pop()!);
  if (previousStateDir === undefined) delete process.env.C2C_STATE_DIR;
  else process.env.C2C_STATE_DIR = previousStateDir;
  if (previousCloudflaredPath === undefined) delete process.env.C2C_CLOUDFLARED_PATH;
  else process.env.C2C_CLOUDFLARED_PATH = previousCloudflaredPath;
});

describe("findBinary", () => {
  it("uses C2C_CLOUDFLARED_PATH for an accessible cloudflared executable", () => {
    const dir = makeTmpDir("cloudflared-path");
    stateDirs.push(dir);
    const filename = process.platform === "win32" ? "cloudflared.exe" : "cloudflared";
    const configured = write(dir, filename, "placeholder");
    if (process.platform !== "win32") fs.chmodSync(configured, 0o755);
    process.env.C2C_CLOUDFLARED_PATH = configured;
    expect(findBinary("cloudflared")).toBe(configured);
  });
});

describe("parseQuickTunnelUrl", () => {
  it("extracts the URL from cloudflared banner output", () => {
    const line =
      "2026-08-28T10:00:00Z INF |  https://random-words-here-1234.trycloudflare.com                              |";
    expect(parseQuickTunnelUrl(line)).toBe(QUICK_URL);
  });

  it("ignores unrelated lines and non-Quick-Tunnel hosts", () => {
    expect(parseQuickTunnelUrl("INF Starting tunnel connection")).toBeNull();
    expect(parseQuickTunnelUrl("visit https://www.cloudflare.com for docs")).toBeNull();
    expect(parseQuickTunnelUrl("https://evil.example.com/trycloudflare.com")).toBeNull();
  });

  it("rejects Cloudflare's API host", () => {
    expect(parseQuickTunnelUrl("INF https://api.trycloudflare.com")).toBeNull();
  });
});

describe("CloudflaredQuickTunnel", () => {
  it("resolves only after the public health endpoint identifies the bridge", async () => {
    const fetchImpl = vi.fn(async () => healthResponse());
    const { child, spawnImpl, tunnel } = setupTunnel(fetchImpl);
    const starting = tunnel.start(3333);
    announceUrl(child);

    await expect(starting).resolves.toMatchObject({ ok: true, provider: "cloudflare-quick", url: QUICK_URL });
    expect(spawnImpl).toHaveBeenCalledWith(
      "cloudflared",
      ["tunnel", "--url", "http://127.0.0.1:3333", "--no-autoupdate"],
      { stdio: ["ignore", "pipe", "pipe"], windowsHide: true }
    );
    expect(fetchImpl).toHaveBeenCalledWith(`${QUICK_URL}/health`, {
      redirect: "error",
      signal: expect.any(AbortSignal),
    });
    expect(tunnel.status()).toMatchObject({ running: true, url: QUICK_URL });
    await tunnel.stop();
  });

  it("keeps consuming cloudflared errors after the tunnel is ready", async () => {
    const { child, tunnel } = setupTunnel(async () => healthResponse());
    const starting = tunnel.start(3333);
    announceUrl(child);
    await expect(starting).resolves.toMatchObject({ ok: true, provider: "cloudflare-quick", url: QUICK_URL });

    child.stderr.write("ERR runtime connection error\n");
    await new Promise((resolve) => setImmediate(resolve));
    expect(tunnel.status().detail).toBe("ERR runtime connection error");
    await tunnel.stop();
  });

  it("does not accept an HTTP 200 response from another service", async () => {
    const { child, tunnel } = setupTunnel(
      async () =>
        new Response(JSON.stringify({ service: "cloudflare", status: "ok" }), { status: 200 }),
      20
    );
    const starting = tunnel.start(3333);
    announceUrl(child);

    await expect(starting).resolves.toMatchObject({ ok: false, provider: "cloudflare-quick" });
    const outcome = await starting;
    if (!outcome.ok) expect(outcome.error.code).toBe("health_check_failed");
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    expect(tunnel.status()).toMatchObject({ running: false, url: null, state: "stopped" });
  });

  it("does not spawn twice or resolve a stopped pending start", async () => {
    const { child, spawnImpl, tunnel } = setupTunnel(() => new Promise<Response>(() => {}));
    const starting = tunnel.start(3333);
    announceUrl(child);
    await new Promise((resolve) => setImmediate(resolve));

    const concurrent = tunnel.start(3333);
    await tunnel.stop();
    await expect(starting).resolves.toMatchObject({ ok: false, provider: "cloudflare-quick" });
    await expect(concurrent).resolves.toMatchObject({ ok: false, provider: "cloudflare-quick" });
    const stopped = await starting;
    if (!stopped.ok) expect(stopped.error.code).toBe("start_stopped");
    expect(spawnImpl).toHaveBeenCalledTimes(1);
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("does not resolve if cloudflared exits while the health probe is in flight", async () => {
    let resolveFetch!: (response: Response) => void;
    const { child, tunnel } = setupTunnel(
      () => new Promise<Response>((resolve) => (resolveFetch = resolve))
    );
    const starting = tunnel.start(3333);
    announceUrl(child);
    await new Promise((resolve) => setImmediate(resolve));

    child.exitCode = 1;
    child.emit("exit", 1, null);
    resolveFetch(healthResponse());
    await expect(starting).resolves.toMatchObject({ ok: false, provider: "cloudflare-quick" });
    const exited = await starting;
    if (!exited.ok) expect(exited.error.code).toBe("process_exited");
    expect(tunnel.status()).toMatchObject({ running: false, url: null, state: "stopped" });
  });

  it("rejects when spawning reports an asynchronous error", async () => {
    const { child, tunnel } = setupTunnel(async () => new Response(null));
    const starting = tunnel.start(3333);
    await new Promise((resolve) => setImmediate(resolve));
    child.emit("error", new Error("spawn cloudflared ENOENT"));

    await expect(starting).resolves.toMatchObject({ ok: false, provider: "cloudflare-quick" });
    const spawnFailed = await starting;
    if (!spawnFailed.ok) expect(spawnFailed.error.code).toBe("process_spawn_failed");
    expect(tunnel.status()).toMatchObject({ running: false, url: null, state: "stopped" });
  });

  it("retries a non-ready health response before resolving", async () => {
    let calls = 0;
    const cancelBody = vi.fn(async () => undefined);
    const { child, tunnel } = setupTunnel(async () => {
      calls += 1;
      return calls === 1
        ? ({ ok: false, status: 503, body: { cancel: cancelBody } } as unknown as Response)
        : healthResponse();
    });
    const starting = tunnel.start(3333);
    announceUrl(child);

    await expect(starting).resolves.toMatchObject({ ok: true, provider: "cloudflare-quick", url: QUICK_URL });
    expect(calls).toBe(2);
    expect(cancelBody).toHaveBeenCalledTimes(1);
  await tunnel.stop();
  });

  it("reports a typed healthy doctor result after the tunnel is ready", async () => {
    const { child, tunnel } = setupTunnel(async () => healthResponse());
    const starting = tunnel.start(3333);
    announceUrl(child);
    await expect(starting).resolves.toMatchObject({ ok: true, provider: "cloudflare-quick", url: QUICK_URL });

    const report = await tunnel.doctor();
    expect(report).toMatchObject({
      ok: true,
      provider: "cloudflare-quick",
      binaryFound: true,
      running: true,
      url: QUICK_URL,
      problems: [],
    });
    await tunnel.stop();
  });

  it("reports a typed doctor failure when the binary is missing", async () => {
    const tunnel = new CloudflaredQuickTunnel(undefined, undefined, {
      spawnImpl: vi.fn(),
      fetchImpl: vi.fn(),
    });
    const report = await tunnel.doctor();
    expect(report).toMatchObject({
      ok: false,
      provider: "cloudflare-quick",
      binaryFound: false,
      running: false,
      url: null,
    });
  });

  it("reports stop_failed when the process refuses to stop", async () => {
    const { child, tunnel } = setupTunnel(async () => healthResponse());
    const starting = tunnel.start(3333);
    announceUrl(child);
    await expect(starting).resolves.toMatchObject({ ok: true });
    child.kill.mockReturnValue(false);

    await expect(tunnel.stop()).resolves.toMatchObject({
      ok: false,
      provider: "cloudflare-quick",
      error: { code: "stop_failed" },
    });
  });

  it("reports stop_failed without losing a pending process reference", async () => {
    const { child, tunnel } = setupTunnel(() => new Promise<Response>(() => {}));
    const starting = tunnel.start(3333);
    announceUrl(child);
    await new Promise((resolve) => setImmediate(resolve));
    child.kill.mockReturnValue(false);

    await expect(tunnel.stop()).resolves.toMatchObject({
      ok: false,
      error: { code: "stop_failed" },
    });
    expect(tunnel.status()).toMatchObject({ running: true, state: "starting", url: null });
    await expect(tunnel.doctor()).resolves.toMatchObject({ running: true, ok: false });
    child.kill.mockReturnValue(true);
    await tunnel.stop();
    await expect(starting).resolves.toMatchObject({ ok: false, error: { code: "start_stopped" } });
  });

  it("reports stop_failed when a failed start cannot terminate its process", async () => {
    const { child, tunnel } = setupTunnel(async () => new Response("unavailable", { status: 503 }), 5);
    child.kill.mockReturnValue(false);
    const starting = tunnel.start(3333);
    announceUrl(child);

    await expect(starting).resolves.toMatchObject({ ok: false, error: { code: "stop_failed" } });
    await expect(tunnel.start(4444)).resolves.toMatchObject({
      ok: false,
      error: { code: "start_conflict" },
    });
    child.kill.mockReturnValue(true);
    await expect(tunnel.stop()).resolves.toMatchObject({ ok: true });
  });
});

describe("CloudflaredNamedTunnel", () => {
  it("matches the provider lifecycle result contract", async () => {
    const child = new FakeCloudflaredProcess();
    const spawnImpl = vi.fn(() => child as unknown as ChildProcess);
    const tunnel = new CloudflaredNamedTunnel({
      tunnelName: "c2c-demo",
      hostname: "demo.example.com",
      binaryOverride: "cloudflared",
      spawnImpl,
    });

    const starting = tunnel.start(3333);
    child.stderr.write("INF Registered tunnel connection\n");
    await expect(starting).resolves.toEqual({
      ok: true,
      provider: "cloudflare-named",
      url: "https://demo.example.com",
    });
    expect(tunnel.status()).toMatchObject({
      state: "running",
      running: true,
      provider: "cloudflare-named",
      url: "https://demo.example.com",
    });
    await expect(tunnel.doctor()).resolves.toMatchObject({ ok: true, errors: [] });
    await expect(tunnel.stop()).resolves.toEqual({ ok: true, provider: "cloudflare-named" });
    expect(tunnel.status()).toMatchObject({ state: "stopped", running: false, url: null });
    expect(spawnImpl).toHaveBeenCalledOnce();
  });

  it("returns a typed binary error without spawning", async () => {
    const tunnel = new CloudflaredNamedTunnel({
      tunnelName: "c2c-demo",
      hostname: "demo.example.com",
      binaryOverride: "",
      spawnImpl: vi.fn(),
    });

    await expect(tunnel.start(3333)).resolves.toMatchObject({
      ok: false,
      provider: "cloudflare-named",
      error: { code: "binary_not_found" },
    });
  });

  it("reports when a timed-out named process cannot be stopped", async () => {
    const child = new FakeCloudflaredProcess();
    child.kill.mockReturnValue(false);
    const tunnel = new CloudflaredNamedTunnel({
      tunnelName: "c2c-demo",
      hostname: "demo.example.com",
      binaryOverride: "cloudflared",
      startTimeoutMs: 5,
      spawnImpl: vi.fn(() => child as unknown as ChildProcess),
    });

    await expect(tunnel.start(3333)).resolves.toMatchObject({
      ok: false,
      provider: "cloudflare-named",
      error: { code: "stop_failed" },
    });
    expect(tunnel.status()).toMatchObject({ running: true, state: "starting", url: null });
    await expect(tunnel.doctor()).resolves.toMatchObject({ running: true, ok: false });
    await expect(tunnel.start(4444)).resolves.toMatchObject({
      ok: false,
      error: { code: "start_conflict" },
    });
    child.kill.mockReturnValue(true);
    await expect(tunnel.stop()).resolves.toMatchObject({ ok: true });
  });

  it("shares a pending start and resolves it as stopped", async () => {
    const child = new FakeCloudflaredProcess();
    const spawnImpl = vi.fn(() => child as unknown as ChildProcess);
    const tunnel = new CloudflaredNamedTunnel({
      tunnelName: "c2c-demo",
      hostname: "demo.example.com",
      binaryOverride: "cloudflared",
      spawnImpl,
    });

    const first = tunnel.start(3333);
    const concurrent = tunnel.start(3333);
    await tunnel.stop();
    await expect(first).resolves.toMatchObject({ ok: false, error: { code: "start_stopped" } });
    await expect(concurrent).resolves.toMatchObject({ ok: false, error: { code: "start_stopped" } });
    expect(spawnImpl).toHaveBeenCalledOnce();
  });

  it("converts a synchronous spawn exception into a typed failure", async () => {
    const tunnel = new CloudflaredNamedTunnel({
      tunnelName: "c2c-demo",
      hostname: "demo.example.com",
      binaryOverride: "cloudflared",
      spawnImpl: () => {
        throw new Error("spawn denied");
      },
    });

    await expect(tunnel.start(3333)).resolves.toMatchObject({
      ok: false,
      error: { code: "process_spawn_failed", message: "spawn denied" },
    });
  });
});

describe("normalizeNamedTunnelHostname", () => {
  it("normalizes a valid hostname", () => {
    expect(normalizeNamedTunnelHostname("Dev.GetRemi.xyz.")).toBe("dev.getremi.xyz");
  });

  it("rejects URLs and invalid hostnames", () => {
    expect(() => normalizeNamedTunnelHostname("https://dev.getremi.xyz")).toThrow(/invalid/i);
    expect(() => normalizeNamedTunnelHostname("localhost")).toThrow(/invalid/i);
  });
});

describe("named hostname helpers", () => {
  it("builds a stable c2c-<project>.<zone> hostname", () => {
    expect(suggestedNamedHostname("Example.COM", "My App", "abcdef123456")).toBe("c2c-my-app.example.com");
  });

  it("falls back to the workspace id when the name is not ASCII", () => {
    expect(hostnameSlug("回声", "abcdef123456")).toBe("c2c-ws-abcdef12");
  });

  it("parses a typed domain", () => {
    expect(parseZoneInput("https://Example.com/")).toBe("example.com");
    expect(parseZoneInput("not a domain")).toBeNull();
  });
});

describe("cloudflared output parsers", () => {
  it("reads a tunnel list table", () => {
    const output = `
ID                                   NAME          CREATED
11111111-1111-1111-1111-111111111111 c2c-abc123    2026-08-30
`;
    expect(parseTunnelList(output)).toEqual([
      { id: "11111111-1111-1111-1111-111111111111", name: "c2c-abc123" },
    ]);
  });

  it("reads created-tunnel output", () => {
    expect(
      parseCreatedTunnel(
        "Created tunnel c2c-abc with id 22222222-2222-2222-2222-222222222222",
        "c2c-abc"
      )
    ).toEqual({ id: "22222222-2222-2222-2222-222222222222", name: "c2c-abc" });
  });

  it("treats an existing DNS route as success", () => {
    expect(isBenignRouteError("Failed to add route: record already exists")).toBe(true);
  });
});

describe("bridge transport seam", () => {
  it("keeps core bridge free of compat imports", () => {
    const source = fs.readFileSync(path.resolve("src/bridge/server.ts"), "utf8");
    expect(source).toContain('from "./core.js"');
    expect(source).not.toContain("../compat/");
  });

  it("keeps core implementation free of compat imports", () => {
    const source = fs.readFileSync(path.resolve("src/bridge/core.ts"), "utf8");
    expect(source).not.toContain("../compat/");
    expect(source).not.toContain("/oauth");
    expect(source).not.toContain("/mcp");
    expect(source).not.toContain("/admin/info");
    expect(source).not.toContain("/admin/pairing");
    expect(source).not.toContain("/admin/revoke-all");
  });

  it("keeps legacy root facades as backward-compatible re-exports", () => {
    const facades: Array<[string, string]> = [
      ["src/auth/html.ts", 'from "../compat/legacy/auth/html.js"'],
      ["src/auth/middleware.ts", 'from "../compat/legacy/auth/middleware.js"'],
      ["src/auth/oauth.ts", 'from "../compat/legacy/auth/oauth.js"'],
      ["src/auth/store.ts", 'from "../compat/legacy/auth/store.js"'],
      ["src/pairing/manager.ts", 'from "../compat/legacy/pairing/manager.js"'],
      ["src/tunnel/cloudflared.ts", 'from "../compat/legacy/cloudflare/cloudflared.js"'],
      ["src/tunnel/cloudflared-named.ts", 'from "../compat/legacy/cloudflare/cloudflared-named.js"'],
      ["src/tunnel/detect.ts", 'from "../compat/legacy/cloudflare/detect.js"'],
      ["src/tunnel/factory.ts", 'from "../compat/legacy/cloudflare/factory.js"'],
      ["src/tunnel/hostname.ts", 'from "../compat/legacy/cloudflare/hostname.js"'],
      ["src/tunnel/named-provision.ts", 'from "../compat/legacy/cloudflare/named-provision.js"'],
      ["src/tunnel/state.ts", 'from "../compat/legacy/cloudflare/state.js"'],
      ["src/tunnel/cloudflare-provider.ts", 'from "../compat/legacy/cloudflare/provider.js"'],
    ];
    for (const [file, needle] of facades) {
      expect(fs.readFileSync(path.resolve(file), "utf8")).toContain(needle);
    }
  });

  it("keeps Cloudflare-specific implementation under compat and the generic provider core-only", () => {
    expect(fs.readFileSync(path.resolve("src/compat/legacy/cloudflare/provider.ts"), "utf8")).toContain(
      "createWorkspaceTunnelProvider"
    );
    expect(fs.readFileSync(path.resolve("src/compat/legacy/cloudflare/provider.ts"), "utf8")).not.toContain(
      "export *"
    );
    expect(fs.readFileSync(path.resolve("src/compat/legacy/cloudflare/factory.ts"), "utf8")).toContain(
      'from "../../../tunnel/provider.js"'
    );
    expect(fs.readFileSync(path.resolve("src/tunnel/provider.ts"), "utf8")).not.toContain("../compat/");
  });

  it("routes the V1 wiring through the compatibility bridge", () => {
    const source = fs.readFileSync(path.resolve("src/compat/legacy/bridge.ts"), "utf8");
    expect(source).toContain('from "./auth/store.js"');
    expect(source).toContain('from "./auth/oauth.js"');
    expect(source).toContain('from "./auth/middleware.js"');
    expect(source).toContain('from "./pairing/manager.js"');
    expect(source).toContain('from "./cloudflare/provider.js"');
    expect(source).not.toContain('from "../../auth/');
    expect(source).not.toContain('from "../../pairing/');
    expect(source).not.toContain('from "../../tunnel/cloudflare-provider.js"');
    expect(source).not.toContain('from "../../tunnel/cloudflared');
    expect(createCloudflareTransportProvider).toBeTypeOf("function");
  });

  it("imports compat Cloudflare helpers directly from the CLI layer", () => {
    const cliFiles: Array<[string, string[]]> = [
      [
        "src/cli/tunnel-commands.ts",
        [
          "../compat/legacy/cloudflare/named-provision.js",
          "../compat/legacy/cloudflare/hostname.js",
          "../compat/legacy/cloudflare/state.js",
        ],
      ],
      [
        "src/cli/shared.ts",
        [
          "../compat/legacy/cloudflare/detect.js",
          "../compat/legacy/cloudflare/named-provision.js",
          "../compat/legacy/cloudflare/hostname.js",
          "../compat/legacy/cloudflare/state.js",
        ],
      ],
      [
        "src/cli/doctor-command.ts",
        ["../compat/legacy/cloudflare/detect.js", "../compat/legacy/cloudflare/state.js"],
      ],
      [
        "src/cli/bridge-commands.ts",
        ["../compat/legacy/auth/store.js", "../compat/legacy/cloudflare/state.js"],
      ],
    ];
    for (const [file, imports] of cliFiles) {
      const source = fs.readFileSync(path.resolve(file), "utf8");
      for (const needle of imports) expect(source).toContain(needle);
    }
  });
});

describe("tunnel preference state", () => {
  it("asks once, then remembers a quick choice", () => {
    stateDirs.push(isolateStateDir());
    const unset = readTunnelState("ws1");
    expect(needsTunnelChoice(unset)).toBe(true);
    const saved = chooseQuickTunnel("ws1");
    expect(saved.preference).toBe("quick");
    expect(needsTunnelChoice(readTunnelState("ws1"))).toBe(false);
    expect(isNamedTunnelReady(saved)).toBe(false);
  });

  it("provisions a named hostname through the account adapter and stores it outside the project", () => {
    stateDirs.push(isolateStateDir());
    const account: CloudflaredAccount = {
      hasCert: () => true,
      login: async () => undefined,
      listTunnels: async () => [],
      createTunnel: async (name) => ({ id: "33333333-3333-3333-3333-333333333333", name }),
      routeDns: async () => undefined,
    };
    return provisionNamedTunnel({
      workspaceId: "abcdef123456",
      workspaceName: "Demo",
      zone: "example.com",
      account,
    }).then((result) => {
      expect(result.fallback).toBe(false);
      expect(result.state.preference).toBe("named");
      expect(result.state.hostname).toBe("c2c-demo.example.com");
      expect(result.state.tunnelName).toBe("c2c-abcdef123456");
      expect(isNamedTunnelReady(readTunnelState("abcdef123456"))).toBe(true);
    });
  });

  it("returns an explicit failure when named provisioning cannot create the tunnel", () => {
    stateDirs.push(isolateStateDir());
    expect(readTunnelState("ws2")).toMatchObject({ preference: "unset" });
    const account: CloudflaredAccount = {
      hasCert: () => true,
      login: async () => undefined,
      listTunnels: async () => [],
      createTunnel: async () => {
        throw new Error("no zone");
      },
      routeDns: async () => undefined,
    };
    return provisionNamedTunnel({
      workspaceId: "ws2",
      workspaceName: "Demo",
      zone: "example.com",
      account,
    }).then((result) => {
      expect(result.ok).toBe(false);
      expect(result.fallback).toBe(false);
      expect(result.error.message).toMatch(/no zone/);
      expect(readTunnelState("ws2")).toMatchObject({ preference: "unset" });
    });
  });

  it("returns an explicit failure when the hostname is invalid and does not persist quick fallback state", () => {
    stateDirs.push(isolateStateDir());
    const account: CloudflaredAccount = {
      hasCert: () => true,
      login: async () => undefined,
      listTunnels: async () => [],
      createTunnel: async () => ({ id: "33333333-3333-3333-3333-333333333333", name: "c2c-ws3" }),
      routeDns: async () => undefined,
    };
    return provisionNamedTunnel({
      workspaceId: "ws3",
      workspaceName: "Demo",
      zone: "example.com",
      hostname: "https://bad.example.com",
      account,
    }).then((result) => {
      expect(result.ok).toBe(false);
      expect(result.fallback).toBe(false);
      expect(result.error.message).toMatch(/invalid/i);
      expect(readTunnelState("ws3")).toMatchObject({ preference: "unset" });
    });
  });
});
