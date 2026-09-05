import { EventEmitter } from "node:events";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

import { projectAppServerEvent, type AppServerInternalEvent } from "./events.js";
import { JsonRpcLineClient } from "./rpc.js";
import { guardAppServerVersion, type ReadAppServerVersion } from "./version.js";

export type AppServerLifecycleState = "stopped" | "starting" | "running" | "crashed";

export interface AppServerProcess {
  stdin: ChildProcessWithoutNullStreams["stdin"];
  stdout: ChildProcessWithoutNullStreams["stdout"];
  stderr: ChildProcessWithoutNullStreams["stderr"];
  kill(signal?: NodeJS.Signals): boolean;
  once(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  on(event: "error", listener: (error: Error) => void): this;
}

export type SpawnAppServer = () => AppServerProcess;

export interface AppServerBackend {
  start(): Promise<void>;
  request<T>(method: string, params: unknown, timeoutMs?: number): Promise<T>;
  respond(id: string | number, result: unknown): Promise<void>;
  interrupt(threadId: string, turnId: string): Promise<unknown>;
  restart(): Promise<void>;
  shutdown(): Promise<void>;
  state(): AppServerLifecycleState;
  onEvent(listener: (event: AppServerInternalEvent) => void): () => void;
}

export type AppServerSupervisorOptions = {
  spawn?: SpawnAppServer;
  readVersion?: ReadAppServerVersion;
  initializeParams?: unknown;
  startupTimeoutMs?: number;
  shutdownTimeoutMs?: number;
};

export class AppServerSupervisor implements AppServerBackend {
  readonly #events = new EventEmitter();
  readonly #spawn: SpawnAppServer;
  readonly #readVersion?: ReadAppServerVersion;
  readonly #initializeParams: unknown;
  readonly #startupTimeoutMs: number;
  readonly #shutdownTimeoutMs: number;
  #process: AppServerProcess | null = null;
  #client: JsonRpcLineClient | null = null;
  #state: AppServerLifecycleState = "stopped";
  #intentionalStop = false;
  #exited = false;
  #lifecycleTail: Promise<void> = Promise.resolve();

  constructor(options: AppServerSupervisorOptions = {}) {
    this.#spawn = options.spawn ?? (() => spawn("codex", ["app-server"], { stdio: "pipe" }));
    this.#readVersion = options.readVersion;
    this.#initializeParams = options.initializeParams ?? {
      clientInfo: { name: "c2c", title: "C2C Orchestrator", version: "2.0.0" },
      capabilities: null,
    };
    this.#startupTimeoutMs = options.startupTimeoutMs ?? 10_000;
    this.#shutdownTimeoutMs = options.shutdownTimeoutMs ?? 5_000;
  }

  state(): AppServerLifecycleState { return this.#state; }

  onEvent(listener: (event: AppServerInternalEvent) => void): () => void {
    this.#events.on("event", listener);
    return () => this.#events.off("event", listener);
  }

  start(): Promise<void> {
    return this.#enqueueLifecycle(() => this.#startInternal());
  }

  async #startInternal(): Promise<void> {
    const compatibility = guardAppServerVersion(this.#readVersion);
    if (!compatibility.ok) throw new Error(compatibility.error.detail);
    if (this.#state === "running") return;
    if (this.#process && !this.#exited) throw new Error("existing App Server process must be shut down before start");
    if (this.#process && this.#exited) {
      this.#process = null;
      this.#client = null;
    }
    this.#state = "starting";
    this.#intentionalStop = false;
    let process: AppServerProcess;
    try {
      process = this.#spawn();
    } catch (error) {
      this.#markCrashed(error instanceof Error ? error.message : "App Server spawn failed");
      throw error;
    }
    this.#exited = false;
    const client = new JsonRpcLineClient(process.stdin, process.stdout);
    this.#process = process;
    this.#client = client;
    client.on("notification", (message: Record<string, unknown>) => {
      this.#events.emit("event", projectAppServerEvent(message));
    });
    client.on("serverRequest", (message: Record<string, unknown>) => {
      this.#events.emit("event", projectAppServerEvent(message));
    });
    client.on("disconnect", () => {
      if (!this.#intentionalStop) this.#markCrashed("App Server disconnected");
    });
    client.on("protocolError", (error: Error) => {
      client.disconnect(error.message);
      if (!this.#intentionalStop) {
        this.#markCrashed(error.message);
        void this.#terminateAfterFailure(process);
      }
    });
    process.stderr.resume();
    process.on("error", (error) => {
      client.disconnect(error.message);
      if (!this.#intentionalStop) {
        this.#markCrashed(error.message);
        void this.#terminateAfterFailure(process);
      }
    });
    process.once("exit", (code, signal) => {
      this.#exited = true;
      client.disconnect(`App Server exited (${code ?? signal ?? "unknown"})`);
      if (!this.#intentionalStop) this.#markCrashed(`App Server exited (${code ?? signal ?? "unknown"})`);
    });
    try {
      await client.request("initialize", this.#initializeParams, this.#startupTimeoutMs);
      await client.notify("initialized");
      this.#state = "running";
    } catch (error) {
      this.#markCrashed(error instanceof Error ? error.message : "App Server startup failed");
      this.#intentionalStop = true;
      try {
        await this.#terminateProcess(process);
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], "App Server startup and cleanup failed");
      } finally {
        this.#intentionalStop = false;
      }
      throw error;
    }
  }

  async request<T>(method: string, params: unknown, timeoutMs?: number): Promise<T> {
    if (this.#state !== "running" || !this.#client) throw new Error("App Server is not running");
    return this.#client.request<T>(method, params, timeoutMs);
  }

  interrupt(threadId: string, turnId: string): Promise<unknown> {
    return this.request("turn/interrupt", { threadId, turnId });
  }

  respond(id: string | number, result: unknown): Promise<void> {
    if (this.#state !== "running" || !this.#client) return Promise.reject(new Error("App Server is not running"));
    return this.#client.respond(id, result);
  }

  async restart(): Promise<void> {
    return this.#enqueueLifecycle(async () => {
      await this.#shutdownInternal();
      await this.#startInternal();
    });
  }

  shutdown(): Promise<void> {
    return this.#enqueueLifecycle(() => this.#shutdownInternal());
  }

  async #shutdownInternal(): Promise<void> {
    const process = this.#process;
    if (!process) { this.#state = "stopped"; return; }
    this.#intentionalStop = true;
    this.#client?.disconnect("App Server shutdown");
    await this.#terminateProcess(process);
    this.#process = null;
    this.#client = null;
    this.#state = "stopped";
  }

  async #terminateProcess(process: AppServerProcess): Promise<void> {
    if (this.#exited) return;
    process.kill("SIGTERM");
    if (await this.#waitForExit(process, this.#shutdownTimeoutMs)) return;
    process.kill("SIGKILL");
    if (await this.#waitForExit(process, this.#shutdownTimeoutMs)) return;
    this.#intentionalStop = false;
    this.#markCrashed("App Server did not exit after SIGKILL");
    throw new Error("App Server did not exit after SIGKILL");
  }

  async #terminateAfterFailure(process: AppServerProcess): Promise<void> {
    await this.#enqueueLifecycle(async () => {
      if (this.#process !== process || this.#exited) return;
      this.#intentionalStop = true;
      try {
        await this.#terminateProcess(process);
      } catch {
        // #terminateProcess records the fail-closed crashed state.
      } finally {
        this.#intentionalStop = false;
      }
    });
  }

  #enqueueLifecycle(operation: () => Promise<void>): Promise<void> {
    const result = this.#lifecycleTail.then(operation, operation);
    this.#lifecycleTail = result.catch(() => undefined);
    return result;
  }

  async #waitForExit(process: AppServerProcess, timeoutMs: number): Promise<boolean> {
    if (this.#exited) return true;
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), timeoutMs);
      timer.unref();
      process.once("exit", () => { clearTimeout(timer); resolve(true); });
    });
  }

  #markCrashed(message: string): void {
    if (this.#state === "crashed") return;
    this.#state = "crashed";
    this.#events.emit("event", { kind: "error", message, raw: null } satisfies AppServerInternalEvent);
  }
}
