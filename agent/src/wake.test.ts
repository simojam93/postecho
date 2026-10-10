import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createWakeController, HEARTBEAT_EVERY_MS } from "./wake.js";

const MIN = 60_000;
const quiet = { log: () => {}, error: () => {} };

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}

function setup({ awakeMs = 10 * MIN, idleCheckMs = 0 } = {}) {
  const drain = vi.fn(async (_isStopping: () => boolean) => {});
  const heartbeat = vi.fn(async () => true);
  const controller = createWakeController({
    drain,
    heartbeat,
    awakeMs,
    idleCheckMs,
    clock: {
      now: () => Date.now(),
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      clearTimeout: (handle) => clearTimeout(handle),
    },
    logger: quiet,
  });
  controller.start();
  return { controller, drain, heartbeat };
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe("the wake controller", () => {
  it("is asleep by default and sends nothing", async () => {
    const { controller, drain, heartbeat } = setup();
    await vi.advanceTimersByTimeAsync(60 * MIN);
    expect(controller.status()).toEqual({ awake: false, busy: false });
    expect(drain).not.toHaveBeenCalled();
    expect(heartbeat).not.toHaveBeenCalled();
  });

  it("wakes on /awake, heartbeats and claims until there are none", async () => {
    const { controller, drain, heartbeat } = setup();
    await controller.awake();
    expect(controller.status()).toEqual({ awake: true, busy: false });
    expect(heartbeat).toHaveBeenCalledTimes(1);
    expect(drain).toHaveBeenCalledTimes(1);
  });

  it("skips the heartbeat when the last is under 2 minutes old", async () => {
    const { controller, drain, heartbeat } = setup();
    await controller.awake();
    await vi.advanceTimersByTimeAsync(MIN);
    await controller.awake();
    expect(heartbeat).toHaveBeenCalledTimes(1);
    expect(drain).toHaveBeenCalledTimes(2);
  });

  it("wakes on /wake too", async () => {
    const { controller, drain } = setup();
    await controller.wake();
    expect(controller.status().awake).toBe(true);
    expect(drain).toHaveBeenCalledTimes(1);
  });

  it("heartbeats every 2 minutes while awake, then sleeps and sends nothing", async () => {
    const { controller, drain, heartbeat } = setup();
    await controller.awake();
    await vi.advanceTimersByTimeAsync(10 * MIN - 1);
    expect(controller.status().awake).toBe(true);
    expect(heartbeat).toHaveBeenCalledTimes(5); // 0, 2, 4, 6, 8 minutes
    await vi.advanceTimersByTimeAsync(1);
    expect(controller.status().awake).toBe(false);
    await vi.advanceTimersByTimeAsync(60 * MIN);
    expect(heartbeat).toHaveBeenCalledTimes(5);
    expect(drain).toHaveBeenCalledTimes(1);
    expect(HEARTBEAT_EVERY_MS).toBe(2 * MIN);
  });

  it("every request from the page keeps it awake for the full time again", async () => {
    const { controller } = setup();
    await controller.awake();
    await vi.advanceTimersByTimeAsync(9 * MIN);
    await controller.awake();
    await vi.advanceTimersByTimeAsync(9 * MIN);
    expect(controller.status().awake).toBe(true);
    await vi.advanceTimersByTimeAsync(MIN);
    expect(controller.status().awake).toBe(false);
  });

  it("finishes and reports a job still running when the time ends, then sleeps", async () => {
    const { controller, drain } = setup();
    const job = deferred();
    drain.mockImplementationOnce(() => job.promise);
    void controller.wake();
    await vi.advanceTimersByTimeAsync(11 * MIN);
    expect(controller.status()).toEqual({ awake: true, busy: true });
    job.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(controller.status()).toEqual({ awake: false, busy: false });
  });

  it("a wake during a drain claims again once it ends, so a new job isn't missed", async () => {
    const { controller, drain } = setup();
    const job = deferred();
    drain.mockImplementationOnce(() => job.promise);
    void controller.wake();
    void controller.wake();
    void controller.wake();
    expect(drain).toHaveBeenCalledTimes(1);
    job.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(drain).toHaveBeenCalledTimes(2);
  });

  it("survives a drain that throws", async () => {
    const { controller, drain } = setup();
    drain.mockRejectedValueOnce(new Error("boom"));
    await controller.wake();
    expect(controller.status().busy).toBe(false);
    await controller.wake();
    expect(drain).toHaveBeenCalledTimes(2);
  });

  it("with an idle check, the asleep agent claims every that many minutes without a heartbeat", async () => {
    const { controller, drain, heartbeat } = setup({ idleCheckMs: 30 * MIN });
    await vi.advanceTimersByTimeAsync(30 * MIN);
    expect(drain).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(30 * MIN);
    expect(drain).toHaveBeenCalledTimes(2);
    expect(heartbeat).not.toHaveBeenCalled();
    expect(controller.status().awake).toBe(false);
  });

  it("the idle check waits while the agent is awake", async () => {
    const { controller, drain } = setup({ awakeMs: 60 * MIN, idleCheckMs: 30 * MIN });
    await controller.awake();
    await vi.advanceTimersByTimeAsync(31 * MIN);
    expect(drain).toHaveBeenCalledTimes(1);
  });

  it("stop waits for the job in hand, tells the drain to stop, and ignores the page after", async () => {
    const { controller, drain, heartbeat } = setup();
    const job = deferred();
    let stopSeen = false;
    drain.mockImplementationOnce(async (isStopping) => { await job.promise; stopSeen = isStopping(); });
    void controller.awake();
    let stopped = false;
    const stopping = controller.stop().then(() => { stopped = true; });
    await vi.advanceTimersByTimeAsync(0);
    expect(stopped).toBe(false);
    job.resolve();
    await stopping;
    expect(stopSeen).toBe(true);
    await controller.awake();
    expect(drain).toHaveBeenCalledTimes(1);
    expect(heartbeat).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60 * MIN);
    expect(heartbeat).toHaveBeenCalledTimes(1);
  });
});
