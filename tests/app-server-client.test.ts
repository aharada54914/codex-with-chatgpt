import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";

import { AppServerSupervisor, type AppServerProcess } from "../src/app-server/supervisor.js";

class FakeProcess extends EventEmitter implements AppServerProcess {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  writes: Array<Record<string, unknown>> = [];
  killed: NodeJS.Signals[] = [];

  constructor() {
    super();
    let buffered = "";
    this.stdin.on("data", (chunk) => {
      buffered += chunk.toString();
      for (;;) {
        const newline = buffered.indexOf("\n");
        if (newline < 0) break;
        const message = JSON.parse(buffered.slice(0, newline)) as Record<string, unknown>;
        buffered = buffered.slice(newline + 1);
        this.writes.push(message);
        if (message.id !== undefined) {
          queueMicrotask(() => this.stdout.write(`${JSON.stringify({ id: message.id, result: { accepted: true } })}\n`));
        }
      }
    });
  }

  kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
    this.killed.push(signal);
    queueMicrotask(() => this.emit("exit", 0, signal));
    return true;
  }

  override on(event: "error", listener: (error: Error) => void): this {
    return super.on(event, listener);
  }
}

function compatibleOptions(process: FakeProcess) {
  return { spawn: () => process, readVersion: () => "codex-cli 0.147.0", startupTimeoutMs: 50, shutdownTimeoutMs: 50 };
}

describe("AppServerSupervisor", () => {
  it("initializes, correlates requests, streams events, interrupts, and shuts down", async () => {
    const process = new FakeProcess();
    const supervisor = new AppServerSupervisor(compatibleOptions(process));
    const events: unknown[] = [];
    supervisor.onEvent((event) => events.push(event));

    await supervisor.start();
    expect(supervisor.state()).toBe("running");
    expect(process.writes.slice(0, 2).map((message) => message.method)).toEqual(["initialize", "initialized"]);

    await expect(supervisor.request("thread/read", { threadId: "t1" })).resolves.toEqual({ accepted: true });
    await supervisor.interrupt("t1", "turn1");
    expect(process.writes.at(-1)).toMatchObject({ method: "turn/interrupt", params: { threadId: "t1", turnId: "turn1" } });

    process.stdout.write(`${JSON.stringify({ method: "turn/completed", params: { threadId: "t1", turn: { id: "turn1", status: "completed" } } })}\n`);
    await new Promise((resolve) => setImmediate(resolve));
    expect(events).toContainEqual(expect.objectContaining({ kind: "turn_terminal", status: "completed" }));

    await supervisor.shutdown();
    expect(supervisor.state()).toBe("stopped");
  });

  it("fails closed before spawning an incompatible App Server", async () => {
    const spawn = vi.fn(() => new FakeProcess());
    const supervisor = new AppServerSupervisor({ spawn, readVersion: () => "codex-cli 0.147.1" });
    await expect(supervisor.start()).rejects.toThrow("expected exactly 0.147.0");
    expect(spawn).not.toHaveBeenCalled();
  });

  it("rejects timed-out requests without reporting completion", async () => {
    const process = new FakeProcess();
    const supervisor = new AppServerSupervisor(compatibleOptions(process));
    await supervisor.start();
    process.stdin.removeAllListeners("data");
    await expect(supervisor.request("thread/read", {}, 5)).rejects.toMatchObject({ code: "timeout" });
    expect(supervisor.state()).toBe("running");
    await supervisor.shutdown();
  });

  it("rejects pending requests and marks crashes without a false terminal event", async () => {
    const process = new FakeProcess();
    const supervisor = new AppServerSupervisor(compatibleOptions(process));
    const events: Array<{ kind: string }> = [];
    supervisor.onEvent((event) => events.push(event));
    await supervisor.start();
    process.stdin.removeAllListeners("data");
    const pending = supervisor.request("turn/start", {}, 1_000);
    process.emit("exit", 1, null);
    await expect(pending).rejects.toMatchObject({ code: "disconnected" });
    expect(supervisor.state()).toBe("crashed");
    expect(events.some((event) => event.kind === "turn_terminal")).toBe(false);
  });

  it("restarts from a crash using a fresh process", async () => {
    const processes = [new FakeProcess(), new FakeProcess()];
    const firstProcess = processes[0]!;
    const supervisor = new AppServerSupervisor({
      spawn: () => processes.shift()!,
      readVersion: () => "codex-cli 0.147.0",
      startupTimeoutMs: 50,
      shutdownTimeoutMs: 50,
    });
    await supervisor.start();
    firstProcess.emit("exit", 1, null);
    expect(supervisor.state()).toBe("crashed");
    const first = processes.length;
    await supervisor.restart();
    expect(first).toBe(1);
    expect(processes).toHaveLength(0);
    expect(supervisor.state()).toBe("running");
    await supervisor.shutdown();
  });

  it("serializes shutdown and a subsequent start", async () => {
    const processes = [new FakeProcess(), new FakeProcess()];
    const supervisor = new AppServerSupervisor({
      spawn: () => processes.shift()!, readVersion: () => "codex-cli 0.147.0", shutdownTimeoutMs: 50,
    });
    await supervisor.start();
    const shutdown = supervisor.shutdown();
    const start = supervisor.start();
    await Promise.all([shutdown, start]);
    expect(supervisor.state()).toBe("running");
    expect(processes).toHaveLength(0);
    await supervisor.shutdown();
  });

  it("projects generated turn-start and approval wire shapes", async () => {
    const process = new FakeProcess();
    const supervisor = new AppServerSupervisor(compatibleOptions(process));
    const events: unknown[] = [];
    supervisor.onEvent((event) => events.push(event));
    await supervisor.start();
    process.stdout.write(`${JSON.stringify({ method: "turn/started", params: { threadId: "t1", turn: { id: "u1" } } })}\n`);
    process.stdout.write(`${JSON.stringify({ method: "item/commandExecution/requestApproval", params: {} })}\n`);
    await new Promise((resolve) => setImmediate(resolve));
    expect(events).toContainEqual(expect.objectContaining({ kind: "turn_started", turnId: "u1" }));
    expect(events).toContainEqual(expect.objectContaining({ kind: "approval_requested" }));
    await supervisor.shutdown();
  });

  it("coalesces concurrent starts and handles spawn and process errors", async () => {
    const process = new FakeProcess();
    const spawn = vi.fn(() => process);
    const supervisor = new AppServerSupervisor({ ...compatibleOptions(process), spawn });
    await Promise.all([supervisor.start(), supervisor.start()]);
    expect(spawn).toHaveBeenCalledOnce();
    process.emit("error", new Error("spawn stream failed"));
    expect(supervisor.state()).toBe("crashed");

    const broken = new AppServerSupervisor({ spawn: () => { throw new Error("ENOENT"); }, readVersion: () => "codex-cli 0.147.0" });
    await expect(broken.start()).rejects.toThrow("ENOENT");
    expect(broken.state()).toBe("crashed");
  });

  it("fails closed on malformed protocol input", async () => {
    const process = new FakeProcess();
    const supervisor = new AppServerSupervisor(compatibleOptions(process));
    await supervisor.start();
    process.stdout.write("not-json\n");
    await new Promise((resolve) => setImmediate(resolve));
    expect(supervisor.state()).toBe("crashed");
  });

  it("does not claim stopped until the child confirms exit", async () => {
    const process = new FakeProcess();
    process.kill = vi.fn(() => false);
    const supervisor = new AppServerSupervisor({ ...compatibleOptions(process), shutdownTimeoutMs: 5 });
    await supervisor.start();
    await expect(supervisor.shutdown()).rejects.toThrow("did not exit after SIGKILL");
    expect(supervisor.state()).toBe("crashed");
  });

  it("does not correlate a colliding server-request id as a client response", async () => {
    const process = new FakeProcess();
    const supervisor = new AppServerSupervisor(compatibleOptions(process));
    const events: Array<{ kind: string }> = [];
    supervisor.onEvent((event) => events.push(event));
    await supervisor.start();
    process.stdin.removeAllListeners("data");
    const pending = supervisor.request("thread/read", {}, 1_000);
    process.stdout.write(`${JSON.stringify({ id: 2, method: "item/fileChange/requestApproval", params: {} })}\n`);
    await new Promise((resolve) => setImmediate(resolve));
    expect(events).toContainEqual(expect.objectContaining({ kind: "approval_requested" }));
    process.emit("exit", 1, null);
    await expect(pending).rejects.toMatchObject({ code: "disconnected" });
  });

  it("rejects result-less response envelopes as protocol errors", async () => {
    const process = new FakeProcess();
    const supervisor = new AppServerSupervisor(compatibleOptions(process));
    await supervisor.start();
    process.stdin.removeAllListeners("data");
    const pending = supervisor.request("thread/read", {}, 1_000);
    process.stdout.write(`${JSON.stringify({ id: 2 })}\n`);
    await expect(pending).rejects.toMatchObject({ code: "disconnected" });
    expect(supervisor.state()).toBe("crashed");
  });
});
