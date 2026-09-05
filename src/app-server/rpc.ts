import { EventEmitter } from "node:events";
import type { Readable, Writable } from "node:stream";
import { createInterface } from "node:readline";

export type JsonRpcId = string | number;

export class AppServerRpcError extends Error {
  constructor(
    message: string,
    readonly code: "disconnected" | "protocol_error" | "remote_error" | "timeout",
  ) {
    super(message);
  }
}

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

export class JsonRpcLineClient extends EventEmitter {
  readonly #pending = new Map<JsonRpcId, PendingRequest>();
  readonly #stdin: Writable;
  #nextId = 1;
  #closed = false;

  constructor(stdin: Writable, stdout: Readable) {
    super();
    this.#stdin = stdin;
    const lines = createInterface({ input: stdout, crlfDelay: Infinity });
    stdin.on("error", (error) => this.disconnect(error.message));
    lines.on("line", (line) => this.#receive(line));
    lines.once("close", () => this.disconnect("App Server stdout closed"));
  }

  request<T>(method: string, params: unknown, timeoutMs = 30_000): Promise<T> {
    if (this.#closed) {
      return Promise.reject(new AppServerRpcError("App Server is disconnected", "disconnected"));
    }
    const id = this.#nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new AppServerRpcError(`App Server request timed out: ${method}`, "timeout"));
      }, timeoutMs);
      timer.unref();
      this.#pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer });
      this.#stdin.write(`${JSON.stringify({ id, method, params })}\n`, (error) => {
        if (!error) return;
        clearTimeout(timer);
        this.#pending.delete(id);
        reject(new AppServerRpcError(error.message, "disconnected"));
      });
    });
  }

  notify(method: string, params?: unknown): Promise<void> {
    if (this.#closed) return Promise.reject(new AppServerRpcError("App Server is disconnected", "disconnected"));
    const message = params === undefined ? { method } : { method, params };
    return new Promise<void>((resolve, reject) => {
      this.#stdin.write(`${JSON.stringify(message)}\n`, (error) => {
        if (error) reject(new AppServerRpcError(error.message, "disconnected"));
        else resolve();
      });
    });
  }

  respond(id: JsonRpcId, result: unknown): Promise<void> {
    if (this.#closed) return Promise.reject(new AppServerRpcError("App Server is disconnected", "disconnected"));
    return new Promise<void>((resolve, reject) => {
      this.#stdin.write(`${JSON.stringify({ id, result })}\n`, (error) => {
        if (error) reject(new AppServerRpcError(error.message, "disconnected"));
        else resolve();
      });
    });
  }

  disconnect(reason = "App Server disconnected"): void {
    if (this.#closed) return;
    this.#closed = true;
    const error = new AppServerRpcError(reason, "disconnected");
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#pending.clear();
    this.emit("disconnect", error);
  }

  #receive(line: string): void {
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      this.emit("protocolError", new AppServerRpcError("invalid JSON from App Server", "protocol_error"));
      return;
    }
    if (!message || typeof message !== "object") return;
    const record = message as Record<string, unknown>;
    const hasId = typeof record.id === "string" || typeof record.id === "number";
    if (typeof record.method === "string") {
      this.emit(hasId ? "serverRequest" : "notification", record);
      return;
    }
    if (hasId && this.#pending.has(record.id as JsonRpcId)) {
      const hasResult = Object.hasOwn(record, "result");
      const hasError = Object.hasOwn(record, "error");
      if (hasResult === hasError) {
        const error = new AppServerRpcError("invalid JSON-RPC response envelope", "protocol_error");
        this.emit("protocolError", error);
        this.disconnect(error.message);
        return;
      }
      const responseId = record.id as JsonRpcId;
      const pending = this.#pending.get(responseId)!;
      this.#pending.delete(responseId);
      clearTimeout(pending.timer);
      if (hasError) {
        pending.reject(new AppServerRpcError(JSON.stringify(record.error), "remote_error"));
      } else {
        pending.resolve(record.result);
      }
      return;
    }
    if (hasId) {
      const error = new AppServerRpcError("response for unknown JSON-RPC request", "protocol_error");
      this.emit("protocolError", error);
      this.disconnect(error.message);
    }
  }
}
