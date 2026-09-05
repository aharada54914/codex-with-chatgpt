import path from "node:path";
import express from "express";
import { Workspace } from "../../workspace/manager.js";
import { nullLogger, type Logger } from "../../logger/index.js";
import { createMcpServer } from "./mcp/server.js";
import { createMcpHttpHandler } from "../../mcp/http.js";
import { startBridge as startBridgeCore, type Bridge as CoreBridge, type BridgeCoreContext } from "../../bridge/core.js";
import type { TunnelProvider } from "../../tunnel/provider.js";
import { AuthStore } from "./auth/store.js";
import { PairingManager } from "./pairing/manager.js";
import { createOAuthRouter } from "./auth/oauth.js";
import { bearerAuth } from "./auth/middleware.js";
import { createCloudflareTransportProvider } from "./cloudflare/provider.js";
import { SERVICE_NAME, VERSION } from "../../version.js";

export interface Bridge extends CoreBridge {
  authStore: AuthStore;
  pairing: PairingManager;
}

export interface BridgeOptions {
  workspaceRoot: string;
  port?: number;
  host?: string;
  logger?: Logger;
  persistRuntime?: boolean;
  authStoreFile?: string;
  accessTokenTtlMs?: number;
  pairingTtlMs?: number;
  tunnelProvider?: TunnelProvider;
  compatibilityMode: "legacy-cloudflare";
}

export async function startLegacyBridge(opts: BridgeOptions): Promise<Bridge> {
  if (opts.compatibilityMode !== "legacy-cloudflare") {
    throw new Error("compatibilityMode must be \"legacy-cloudflare\" for the legacy bridge");
  }
  const logger = opts.logger ?? nullLogger;
  const workspace = new Workspace(opts.workspaceRoot);
  const authStore = new AuthStore(workspace.id, opts.authStoreFile ? { file: path.resolve(opts.authStoreFile) } : {});
  const pairing = new PairingManager(workspace.id, { ttlMs: opts.pairingTtlMs });
  const tunnel = opts.tunnelProvider ?? createCloudflareTransportProvider(workspace.id, logger);

  const bridge = await startBridgeCore({
    workspaceRoot: opts.workspaceRoot,
    port: opts.port,
    host: opts.host,
    logger,
    persistRuntime: opts.persistRuntime,
    tunnel,
    extendApp(ctx: BridgeCoreContext) {
      const mcpHandler = createMcpHttpHandler(() => createMcpServer({ workspace, logger: ctx.logger }), ctx.logger);
      ctx.app.use(
        createOAuthRouter({
          store: authStore,
          pairing,
          workspaceName: workspace.name,
          getBaseUrl: ctx.getBaseUrl,
          logger: ctx.logger,
          accessTokenTtlMs: opts.accessTokenTtlMs,
        })
      );
      ctx.app.all(
        "/mcp",
        express.json({ limit: "8mb" }),
        bearerAuth({
          store: authStore,
          workspaceId: workspace.id,
          getBaseUrl: ctx.getBaseUrl,
          logger: ctx.logger,
        }),
        (req, res) => void mcpHandler(req, res)
      );
      ctx.app.post("/admin/pairing", ctx.adminGuard, (_req, res) => {
        const session = pairing.create();
        res.json({ code: session.code, expiresAt: session.expiresAt });
      });
      ctx.app.get("/admin/info", ctx.adminGuard, (_req, res) =>
        res.json({
          service: SERVICE_NAME,
          version: VERSION,
          workspaceId: workspace.id,
          workspaceName: workspace.name,
          workspaceRoot: workspace.root,
          port: ctx.getPort(),
          publicUrl: ctx.getPublicBaseUrl(),
          tunnel: tunnel.status(),
          tokenCount: authStore.tokenCount(),
          pairingActive: pairing.hasActiveSession(),
          pid: process.pid,
          startedAt: ctx.startedAt,
        })
      );
      ctx.app.post("/admin/revoke-all", ctx.adminGuard, (_req, res) => {
        const count = authStore.revokeAll();
        pairing.invalidateAll();
        res.json({ revoked: count });
      });
    },
  });

  return { ...bridge, authStore, pairing };
}

export const startBridge = startLegacyBridge;
