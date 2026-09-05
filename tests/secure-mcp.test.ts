import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { SecureMcpTunnelClient } from "../src/tunnel/secure-mcp.js";

class FakeChildProcess extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  killed = false;
  readonly pid = 4242;
  readonly kill = vi.fn(() => {
    this.killed = true;
    return true;
  });
}

function makeClient(binaryOverride?: string) {
  const child = new FakeChildProcess();
  let calls = 0;
  const spawnImpl = vi.fn(() => {
    calls += 1;
    if (calls === 1) setImmediate(() => child.emit("exit", 0));
    return child as unknown as ChildProcess;
  });
  const client = new SecureMcpTunnelClient({
    binaryOverride,
    profile: "local-stdio",
    tunnelId: "tunnel-123",
    mcpCommand: "node server.js",
    spawnImpl,
  });
  return { child, spawnImpl, client };
}

describe("SecureMcpTunnelClient", () => {
  it("reports unavailable when tunnel-client is missing", async () => {
    const client = new SecureMcpTunnelClient({
      profile: "local-stdio",
      tunnelId: "tunnel-123",
      mcpCommand: "node server.js",
    });
    const report = await client.doctor();
    expect(report.ok).toBe(false);
    expect(report.errors[0]?.code).toBe("binary_not_found");
  });

  it("reports prerequisite problems before configure", async () => {
    const client = new SecureMcpTunnelClient({ binaryOverride: "/usr/bin/tunnel-client" });
    const report = await client.doctor();
    expect(report.ok).toBe(false);
    expect(report.errors.map((error) => error.code)).toContain("profile_not_configured");
    expect(report.errors.map((error) => error.code)).toContain("entitlement_missing");
  });

  it("runs init and start with the official tunnel-client shape", async () => {
    const { child, spawnImpl, client } = makeClient("/usr/bin/tunnel-client");
    await expect(client.init()).resolves.toMatchObject({ ok: true });
    await expect(client.start()).resolves.toMatchObject({ ok: true, pid: 4242 });
    expect(spawnImpl).toHaveBeenNthCalledWith(
      1,
      "/usr/bin/tunnel-client",
      [
        "init",
        "--sample",
        "sample_mcp_stdio_local",
        "--profile",
        "local-stdio",
        "--tunnel-id",
        "tunnel-123",
        "--mcp-command",
        "node server.js",
      ],
      { stdio: ["ignore", "pipe", "pipe"], windowsHide: true }
    );
    expect(spawnImpl).toHaveBeenNthCalledWith(
      2,
      "/usr/bin/tunnel-client",
      ["run", "--profile", "local-stdio"],
      { stdio: ["ignore", "pipe", "pipe"], windowsHide: true }
    );
    await expect(client.stop()).resolves.toMatchObject({ ok: true });
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
  });
});
