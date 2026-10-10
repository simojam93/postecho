import { describe, expect, it, vi } from "vitest";
import { runAgentLoop } from "./run.js";
import type { Worker } from "./worker.js";

const quiet = { log: vi.fn(), error: vi.fn() };

function fakeWorker() {
  return {
    heartbeat: vi.fn(async () => true),
    claimAndRun: vi.fn(async () => "empty" as const),
    drain: vi.fn(async () => {}),
  } satisfies Worker;
}

function stopper() {
  let stopping = false;
  let resolve!: () => void;
  const stopped = new Promise<void>((r) => { resolve = r; });
  return { isStopping: () => stopping, stopped, stop: () => { stopping = true; resolve(); } };
}

const base = { origin: "http://localhost:3000", awakeMs: 600_000, idleCheckMs: 0, pollIdleSeconds: 5, logger: quiet };

describe("runAgentLoop", () => {
  it("polls as before when AGENT_WAKE_PORT is 0, without opening a server", async () => {
    const worker = fakeWorker();
    const s = stopper();
    const startServer = vi.fn();
    worker.claimAndRun.mockImplementation(async () => { s.stop(); return "empty"; });
    const mode = await runAgentLoop({
      ...base, wakePort: 0, worker, isStopping: s.isStopping, stopped: s.stopped, startServer, sleep: async () => {},
    });
    expect(mode).toBe("poll");
    expect(startServer).not.toHaveBeenCalled();
    expect(worker.heartbeat).toHaveBeenCalledTimes(1);
  });

  it("polls when the port is taken", async () => {
    const worker = fakeWorker();
    const s = stopper();
    worker.claimAndRun.mockImplementation(async () => { s.stop(); return "empty"; });
    const mode = await runAgentLoop({
      ...base, wakePort: 47321, worker, isStopping: s.isStopping, stopped: s.stopped,
      startServer: vi.fn(async () => null), sleep: async () => {},
    });
    expect(mode).toBe("poll");
    expect(worker.claimAndRun).toHaveBeenCalled();
  });

  it("in wake mode sends nothing until the page asks, and closes the server on stop", async () => {
    const worker = fakeWorker();
    const s = stopper();
    const server = { close: vi.fn(), closeAllConnections: vi.fn() };
    let controller: { wake: () => Promise<void> } | undefined;
    const startServer = vi.fn(async (o: { port: number; origin: string; controller: { wake: () => Promise<void> } }) => {
      controller = o.controller;
      return server;
    });
    const running = runAgentLoop({ ...base, wakePort: 47321, worker, isStopping: s.isStopping, stopped: s.stopped, startServer });
    await vi.waitFor(() => expect(startServer).toHaveBeenCalled());
    expect(startServer.mock.calls[0]![0]).toMatchObject({ port: 47321, origin: "http://localhost:3000" });
    expect(worker.claimAndRun).not.toHaveBeenCalled();
    expect(worker.heartbeat).not.toHaveBeenCalled();
    await controller!.wake();
    expect(worker.drain).toHaveBeenCalledTimes(1);
    s.stop();
    expect(await running).toBe("wake");
    expect(server.close).toHaveBeenCalled();
  });
});
