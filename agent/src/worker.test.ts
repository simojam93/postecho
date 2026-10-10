import { describe, expect, it, vi } from "vitest";
import type { Job, JobOutcome } from "./postecho.js";
import { createWorker, runPollLoop, type WorkerClient } from "./worker.js";

function job(id: string, kind = "generate_from_idea"): Job {
  return { id, kind, payload: {}, createdAt: "2026-10-10T10:00:00.000Z", claimedAt: `claimed-${id}` };
}

/** A client whose claims hand out `queue` in order, then nothing. */
function fakeClient(queue: Array<Job | Error> = []) {
  const client = {
    claimJob: vi.fn(async () => {
      const next = queue.shift();
      if (next instanceof Error) throw next;
      return next ?? null;
    }),
    postResult: vi.fn(async (_id: string, _claimedAt: string, _outcome: JobOutcome) => {}),
    heartbeat: vi.fn(async () => ({ claudeModel: null as "sonnet" | "opus" | "haiku" | null })),
    reportProgress: vi.fn(async () => {}),
  } satisfies WorkerClient;
  return client;
}

function fakeRunner() {
  return { model: "sonnet", setModel: vi.fn(function (this: { model: string }, m: string) { this.model = m; }), runClaudeJson: vi.fn() };
}

const quiet = { log: () => {}, error: () => {} };

function setup(queue: Array<Job | Error> = [], outcome: JobOutcome = { ok: true, result: { done: 1 } }) {
  const client = fakeClient(queue);
  const runner = fakeRunner();
  const runHandler = vi.fn(async (_job: Job) => outcome);
  const worker = createWorker({
    client,
    runner,
    deps: { getProfile: vi.fn(), runClaudeJson: vi.fn() } as never,
    kinds: ["generate_from_idea"],
    pollWaitSeconds: 0,
    runHandler,
    logger: quiet,
  });
  return { client, runner, runHandler, worker };
}

describe("claimAndRun", () => {
  it("claims one job, runs it and reports the outcome with the claim's echo", async () => {
    const { client, runHandler, worker } = setup([job("a")]);
    expect(await worker.claimAndRun()).toBe("ran");
    expect(client.claimJob).toHaveBeenCalledWith(["generate_from_idea"], 0);
    expect(runHandler).toHaveBeenCalledTimes(1);
    expect(client.postResult).toHaveBeenCalledWith("a", "claimed-a", { ok: true, result: { done: 1 } });
  });

  it("says empty when nothing is queued, and error when the claim fails", async () => {
    const { worker } = setup([new Error("fetch failed")]);
    expect(await worker.claimAndRun()).toBe("error");
    expect(await worker.claimAndRun()).toBe("empty");
  });

  it("still counts a job as run when its report fails", async () => {
    const { client, worker } = setup([job("a")]);
    client.postResult.mockRejectedValueOnce(new Error("down"));
    expect(await worker.claimAndRun()).toBe("ran");
  });
});

describe("drain", () => {
  it("claims until there are none", async () => {
    const { client, runHandler, worker } = setup([job("a"), job("b")]);
    await worker.drain(() => false);
    expect(runHandler).toHaveBeenCalledTimes(2);
    expect(client.claimJob).toHaveBeenCalledTimes(3);
  });

  it("stops after a failed claim instead of spinning", async () => {
    const { client, worker } = setup([new Error("fetch failed"), job("a")]);
    await worker.drain(() => false);
    expect(client.claimJob).toHaveBeenCalledTimes(1);
  });

  it("stops between jobs once asked to", async () => {
    const { runHandler, worker } = setup([job("a"), job("b")]);
    let stop = false;
    runHandler.mockImplementation(async () => { stop = true; return { ok: true, result: {} }; });
    await worker.drain(() => stop);
    expect(runHandler).toHaveBeenCalledTimes(1);
  });
});

describe("heartbeat", () => {
  it("follows the model the owner picked and says it worked", async () => {
    const { client, runner, worker } = setup();
    client.heartbeat.mockResolvedValueOnce({ claudeModel: "opus" });
    expect(await worker.heartbeat()).toBe(true);
    expect(runner.setModel).toHaveBeenCalledWith("opus");
  });

  it("says false when it fails, without throwing", async () => {
    const { client, worker } = setup();
    client.heartbeat.mockRejectedValueOnce(new Error("down"));
    expect(await worker.heartbeat()).toBe(false);
  });
});

describe("runPollLoop", () => {
  it("polls as before: a heartbeat every 60 s, a pause after an empty claim, a backoff after a failed one", async () => {
    const { client, worker } = setup([job("a"), new Error("fetch failed")]);
    let now = 0;
    const sleeps: number[] = [];
    await runPollLoop({
      worker,
      isStopping: () => client.claimJob.mock.calls.length >= 3,
      sleep: async (ms) => { sleeps.push(ms); now += ms; },
      now: () => now,
      pollIdleSeconds: 5,
    });
    expect(sleeps).toEqual([2_000, 5_000]);
    expect(client.heartbeat).toHaveBeenCalledTimes(1);
  });

  it("heartbeats again once 60 s have passed", async () => {
    const { client, worker } = setup();
    let now = 0;
    let claims = 0;
    client.claimJob.mockImplementation(async () => { claims += 1; return null; });
    await runPollLoop({
      worker,
      isStopping: () => claims >= 13,
      sleep: async (ms) => { now += ms; },
      now: () => now,
      pollIdleSeconds: 5,
    });
    // 13 claims, 5 s apart: heartbeats at 0 and 60 s.
    expect(client.heartbeat).toHaveBeenCalledTimes(2);
  });
});
