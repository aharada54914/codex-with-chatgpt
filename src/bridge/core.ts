import express, { type Request, type Response, type NextFunction } from "express";
import type { Server } from "node:http";
import { randomBytes } from "node:crypto";
import { Workspace } from "../workspace/manager.js";
import { createMcpServer } from "../mcp/server.js";
import { createMcpHttpHandler } from "../mcp/http.js";
import type { TunnelProvider } from "../tunnel/provider.js";
import { Logger, nullLogger } from "../logger/index.js";
import { DEFAULT_HOST, DEFAULT_PORT } from "../config/paths.js";
import { SERVICE_NAME, VERSION } from "../version.js";
import { writeRuntimeState, clearRuntimeState, type RuntimeState } from "./runtime.js";

export interface BridgeCoreDependencies {
  authStore: {
    tokenCount(): number;
    revokeAll(): number;
  };
  pairing: {
    hasActiveSession(): boolean;
    create(): { code: string; expiresAt: number };
    invalidateAll(): void;
  };
  tunnel: TunnelProvider;
  registerAuthRoutes(app: express.Express, getBaseUrl: (req: Request) => string, logger: Logger): void;
  registerBearerRoute(app: express.Express, getBaseUrl: (req: Request) => string, logger: Logger): void;
}

export interface BridgeOptions extends BridgeCoreDependencies {
  workspaceRoot: string;
  port?: number;
  host?: string;
  logger?: Logger;
  /** Persist runtime state file (disable in tests). */
  persistRuntime?: boolean;
}

export interface Bridge {
  workspace: Workspace;
  port: number;
  host: string;
  adminToken: string;
  authStore: BridgeCoreDependencies["authStore"];
  pairing: BridgeCoreDependencies["pairing"];
  tunnel: TunnelProvider;
  getPublicBaseUrl(): string | null;
  localBaseUrl(): string;
  close(): Promise<void>;
}

function listen(app: express.Express, host: string, preferredPort: number): Promise<{ server: Server; port: number }> {
  return new Promise((resolve, reject) => {
    const tryListen = (port: number, allowFallback: boolean): void => {
      const server = app.listen(port, host);
      server.once("listening", () => {
        const address = server.address();
        const actual = typeof address === "object" && address ? address.port : port;
        resolve({ server, port: actual });
      });
      server.once("error", (error: NodeJS.ErrnoException) => {
        if (error.code === "EADDRINUSE" && allowFallback) tryListen(0, false);
        else reject(error);
      });
    };
    tryListen(preferredPort, preferredPort !== 0);
  });
}

export async function startBridge(opts: BridgeOptions): Promise<Bridge> {
  const logger = opts.logger ?? nullLogger;
  const workspace = new Workspace(opts.workspaceRoot);
  const host = opts.host ?? DEFAULT_HOST;
  if (host !== "127.0.0.1" && host !== "::1" && host !== "localhost") {
    throw new Error("The bridge only binds to loopback addresses. Public exposure goes through the tunnel.");
  }

  const adminToken = `c2c_admin_${randomBytes(24).toString("base64url")}`;
  let publicBaseUrl: string | null = null;
  const app = express();
  app.set("trust proxy", true);
  app.disable("x-powered-by");
  const getBaseUrl = (req: Request): string => publicBaseUrl ?? `${req.protocol}://${req.get("host") ?? `${host}:${port}`}`;

  app.get("/health", (_req, res) => res.json({ service: SERVICE_NAME, version: VERSION, workspaceId: workspace.id, status: "ok" }));
  opts.registerAuthRoutes(app, getBaseUrl, logger);
  const mcpHandler = createMcpHttpHandler(() => createMcpServer({ workspace, logger }), logger);
  app.all("/mcp", express.json({ limit: "8mb" }), opts.registerBearerRoute.bind(null, app, getBaseUrl, logger) as never, (req: Request, res: Response) => void mcpHandler(req, res));

  const authStore = opts.authStore;
  const pairing = opts.pairing;
  const tunnel = opts.tunnel;
  const adminGuard = (req: Request, res: Response, next: NextFunction): void => {
    const remote = req.socket.remoteAddress ?? "";
    const isLoopback = remote === "127.0.0.1" || remote === "::1" || remote === "::ffff:127.0.0.1";
    const viaProxy = Boolean(req.headers["cf-connecting-ip"] || req.headers["x-forwarded-for"]);
    const header = req.headers.authorization ?? "";
    const token = header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";
    if (!isLoopback || viaProxy || token !== adminToken) {
      res.status(404).end();
      return;
    }
    next();
  };
  app.post("/admin/pairing", adminGuard, (_req, res) => res.json(pairing.create()));
  app.get("/admin/info", adminGuard, (_req, res) => res.json({ service: SERVICE_NAME, version: VERSION, workspaceId: workspace.id, workspaceName: workspace.name, workspaceRoot: workspace.root, port, publicUrl: publicBaseUrl, tunnel: tunnel.status(), tokenCount: authStore.tokenCount(), pairingActive: pairing.hasActiveSession(), pid: process.pid, startedAt }));
  app.post("/admin/tunnel/start", adminGuard, (_req, res) => { void tunnel.start(port).then((result) => { if (!result.ok) { res.status(500).json({ error: result.error.code, message: result.error.message, detail: result.error.detail ?? null }); return; } publicBaseUrl = result.url; persistRuntime(); res.json({ url: result.url, provider: result.provider }); }); });
  app.post("/admin/tunnel/stop", adminGuard, (_req, res) => { void tunnel.stop().then((result) => { if (!result.ok) { res.status(500).json({ error: result.error.code, message: result.error.message }); return; } publicBaseUrl = null; persistRuntime(); res.json({ stopped: true, provider: result.provider }); }); });
  app.post("/admin/revoke-all", adminGuard, (_req, res) => { const count = authStore.revokeAll(); pairing.invalidateAll(); res.json({ revoked: count }); });
  app.post("/admin/shutdown", adminGuard, (_req, res) => { res.json({ shuttingDown: true }); setTimeout(() => void shutdown().then(() => process.exit(0)), 100); });

  const { server, port } = await listen(app, host, opts.port ?? DEFAULT_PORT);
  const startedAt = new Date().toISOString();
  const persistRuntime = (): void => { if (opts.persistRuntime === false) return; const state: RuntimeState = { service: SERVICE_NAME, version: VERSION, workspaceId: workspace.id, workspaceRoot: workspace.root, pid: process.pid, port, adminToken, publicUrl: publicBaseUrl, startedAt }; writeRuntimeState(state); };
  persistRuntime();
  async function shutdown(): Promise<void> { await tunnel.stop().catch(() => undefined); clearRuntimeState(workspace.id); await new Promise<void>((resolve) => server.close(() => resolve())); }
  return { workspace, port, host, adminToken, authStore, pairing, tunnel, getPublicBaseUrl: () => publicBaseUrl, localBaseUrl: () => `http://${host}:${port}`, close: shutdown };
}
