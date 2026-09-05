import { describe, it, expect, vi } from "vitest";
import path from "node:path";
import { startBridge } from "../src/compat/legacy/bridge.js";
import { probeBridge } from "../src/bridge/runtime.js";
import { makeTmpDir, cleanup, write, isolateStateDir } from "./helpers.js";

describe("port collision handling", () => {
  it("falls back to a free port when the preferred one is taken", async () => {
    isolateStateDir();
    const rootA = makeTmpDir("port-a");
    const rootB = makeTmpDir("port-b");
    write(rootA, "a.txt", "a");
    write(rootB, "b.txt", "b");
    const preferred = 47000 + Math.floor(Math.random() * 1000);

    const bridgeA = await startBridge({
      workspaceRoot: rootA,
      port: preferred,
      persistRuntime: false,
      authStoreFile: path.join(makeTmpDir("auth"), "a.json"),
      compatibilityMode: "legacy-cloudflare",
    });
    const bridgeB = await startBridge({
      workspaceRoot: rootB,
      port: preferred,
      persistRuntime: false,
      authStoreFile: path.join(makeTmpDir("auth"), "b.json"),
      compatibilityMode: "legacy-cloudflare",
    });

    expect(bridgeA.port).toBe(preferred);
    expect(bridgeB.port).not.toBe(preferred);
    expect(bridgeB.port).toBeGreaterThan(0);

    // health identifies each bridge's workspace, so callers can detect reuse
    const healthA = await probeBridge(bridgeA.port);
    const healthB = await probeBridge(bridgeB.port);
    expect(healthA?.workspaceId).toBe(bridgeA.workspace.id);
    expect(healthB?.workspaceId).toBe(bridgeB.workspace.id);
    expect(healthA?.workspaceId).not.toBe(healthB?.workspaceId);

    await bridgeA.close();
    await bridgeB.close();
    cleanup(rootA);
    cleanup(rootB);
  });

  it("refuses to bind non-loopback hosts", async () => {
    const root = makeTmpDir("port-c");
    write(root, "c.txt", "c");
    await expect(
      startBridge({
        workspaceRoot: root,
        host: "0.0.0.0",
        persistRuntime: false,
        compatibilityMode: "legacy-cloudflare",
      })
    ).rejects.toThrow(/loopback/);
    cleanup(root);
  });

  it("uses an injected tunnel provider for admin lifecycle calls", async () => {
    isolateStateDir();
    const root = makeTmpDir("port-d");
    write(root, "d.txt", "d");
    const start = vi.fn(async (localPort: number) => ({
      ok: true as const,
      provider: "fake-tunnel",
      url: `https://fake-${localPort}.example.com`,
    }));
    const stop = vi.fn(async () => ({ ok: true as const, provider: "fake-tunnel" }));
    const tunnel = {
      name: "fake-tunnel",
      start,
      stop,
      restart: start,
      status: () => ({ running: false, url: null, provider: "fake-tunnel", state: "stopped" as const }),
      getPublicUrl: () => null,
      doctor: async () => ({
        ok: true as const,
        provider: "fake-tunnel",
        binaryFound: true,
        binaryPath: null,
        running: false,
        url: null,
        problems: [],
        errors: [],
      }),
    };
    const bridge = await startBridge({
      workspaceRoot: root,
      port: 0,
      persistRuntime: false,
      authStoreFile: path.join(makeTmpDir("auth"), "d.json"),
      tunnelProvider: tunnel,
      compatibilityMode: "legacy-cloudflare",
    });

    try {
      expect(bridge.tunnel).toBe(tunnel);
      const startResponse = await fetch(`${bridge.localBaseUrl()}/admin/tunnel/start`, {
        method: "POST",
        headers: { authorization: `Bearer ${bridge.adminToken}` },
      });
      expect(startResponse.status).toBe(200);
      expect(await startResponse.json()).toMatchObject({
        provider: "fake-tunnel",
        url: expect.stringContaining("fake-"),
      });
      expect(start).toHaveBeenCalledWith(bridge.port);

      const stopResponse = await fetch(`${bridge.localBaseUrl()}/admin/tunnel/stop`, {
        method: "POST",
        headers: { authorization: `Bearer ${bridge.adminToken}` },
      });
      expect(stopResponse.status).toBe(200);
      expect(stop).toHaveBeenCalledTimes(1);
    } finally {
      await bridge.close();
      cleanup(root);
    }
  });

  it("honors the injected pairing ttl", async () => {
    isolateStateDir();
    const root = makeTmpDir("port-e");
    write(root, "e.txt", "e");
    const bridge = await startBridge({
      workspaceRoot: root,
      port: 0,
      persistRuntime: false,
      authStoreFile: path.join(makeTmpDir("auth"), "e.json"),
      pairingTtlMs: 5_000,
      compatibilityMode: "legacy-cloudflare",
    });

    try {
      const started = Date.now();
      const session = bridge.pairing.create();
      expect(session.expiresAt - started).toBeGreaterThanOrEqual(4_500);
      expect(session.expiresAt - started).toBeLessThanOrEqual(5_500);
    } finally {
      await bridge.close();
      cleanup(root);
    }
  });

  it("rejects a type-erased legacy bridge call without the required compatibility mode", async () => {
    const root = makeTmpDir("port-f");
    write(root, "f.txt", "f");
    await expect(
      startBridge({
        workspaceRoot: root,
        port: 0,
        persistRuntime: false,
        authStoreFile: path.join(makeTmpDir("auth"), "f.json"),
      } as any)
    ).rejects.toThrow(/compatibilityMode/);
    cleanup(root);
  });
});
