import express, { type Request, type Response, type NextFunction } from "express";
import type { Server } from "node:http";
import { randomBytes } from "node:crypto";
import { Workspace } from "../workspace/manager.js";
import type { TunnelProvider } from "../tunnel/provider.js";
import { Logger, nullLogger } from "../logger/index.js";
import { DEFAULT_HOST, DEFAULT_PORT } from "../config/paths.js";
import { SERVICE_NAME, VERSION } from "../version.js";
import { writeRuntimeState, clearRuntimeState, type RuntimeState } from "./runtime.js";

export interface BridgeCoreContext {
  app: express.Express;
  workspace: Workspace;
  host: string;
  adminToken: string;
  logger: Logger;
  getPort(): number;
  getBaseUrl(req: Request): string;
  adminGuard(req: Request, res: Response, next: NextFunction): void;
  getPublicBaseUrl(): string | null;
  setPublicBaseUrl(url: string | null): void;
  startedAt: string;
  persistRuntime(): void;
  tunnel: TunnelProvider;
}

export interface BridgeCoreDependencies {
  tunnel: TunnelProvider;
  extendApp?(ctx: BridgeCoreContext): void;
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
  const startedAt = new Date().toISOString();
  let port = opts.port ?? DEFAULT_PORT;
  let publicBaseUrl: string | null = null;
  if (host !== "127.0.0.1" && host !== "::1" && host !== "localhost") {
    throw new Error("The bridge only binds to loopback addresses. Public exposure goes through the tunnel.");
  }

  const adminToken = `c2c_admin_${randomBytes(24).toString("base64url")}`;
  const app = express();
  app.set("trust proxy", true);
  app.disable("x-powered-by");
  const getBaseUrl = (req: Request): string => publicBaseUrl ?? `${req.protocol}://${req.get("host") ?? `${host}:${port}`}`;

  app.get("/health", (_req, res) => res.json({ service: SERVICE_NAME, version: VERSION, workspaceId: workspace.id, status: "ok" }));
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
  app.post("/admin/tunnel/start", adminGuard, (_req, res) => { void tunnel.start(port).then((result) => { if (!result.ok) { res.status(500).json({ error: result.error.code, message: result.error.message, detail: result.error.detail ?? null }); return; } publicBaseUrl = result.url; persistRuntime(); res.json({ url: result.url, provider: result.provider }); }); });
  app.post("/admin/tunnel/stop", adminGuard, (_req, res) => { void tunnel.stop().then((result) => { if (!result.ok) { res.status(500).json({ error: result.error.code, message: result.error.message }); return; } publicBaseUrl = null; persistRuntime(); res.json({ stopped: true, provider: result.provider }); }); });
  app.post("/admin/shutdown", adminGuard, (_req, res) => { res.json({ shuttingDown: true }); setTimeout(() => void shutdown().then(() => process.exit(0)), 100); });

  const persistRuntime = (): void => {
    if (opts.persistRuntime === false) return;
    const state: RuntimeState = {
      service: SERVICE_NAME,
      version: VERSION,
      workspaceId: workspace.id,
      workspaceRoot: workspace.root,
      pid: process.pid,
      port,
      adminToken,
      publicUrl: publicBaseUrl,
      startedAt,
    };
    writeRuntimeState(state);
  };
  const coreContext: BridgeCoreContext = {
    app,
    workspace,
    host,
    adminToken,
    logger,
    getPort: () => port,
    getBaseUrl,
    adminGuard,
    getPublicBaseUrl: () => publicBaseUrl,
    setPublicBaseUrl: (url: string | null) => {
      publicBaseUrl = url;
      persistRuntime();
    },
    startedAt,
    persistRuntime,
    tunnel,
  };
  opts.extendApp?.(coreContext);

  const { server, port: actualPort } = await listen(app, host, port);
  port = actualPort;
  persistRuntime();
  async function shutdown(): Promise<void> {
    const stopped = await tunnel.stop().catch((error: unknown) => {
      logger.error(`Tunnel stop failed during shutdown: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    });
    if (stopped && !stopped.ok) {
      logger.error(`Tunnel stop failed during shutdown: ${stopped.error.message}`);
    }
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (opts.persistRuntime !== false && stopped?.ok) clearRuntimeState(workspace.id);
  }
  return { workspace, port, host, adminToken, tunnel, getPublicBaseUrl: () => publicBaseUrl, localBaseUrl: () => `http://${host}:${port}`, close: shutdown };
}
