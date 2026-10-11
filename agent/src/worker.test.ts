import { describe, expect, it, vi } from "vitest";
import type { Job, JobOutcome } from "./postecho.js";
import { createWorker, jobBudgetMs, runPollLoop, type WorkerClient } from "./worker.js";

describe("a budget per job (media from a repo, 2026-10-11)", () => {
  const media = (kind: string): Job => ({ ...job("m", "post_media"), payload: { kind } });

  it("gives screenshots and videos 40 minutes, everything else 9", () => {
    expect(jobBudgetMs(media("screenshots"))).toBe(40 * 60_000);
    expect(jobBudgetMs(media("video"))).toBe(40 * 60_000);
    expect(jobBudgetMs(media("card"))).toBe(9 * 60_000);
    expect(jobBudgetMs(media("images"))).toBe(9 * 60_000);
    expect(jobBudgetMs(job("a", "repo_posts"))).toBe(9 * 60_000);
    expect(jobBudgetMs({ ...job("a", "repo_posts"), payload: { kind: "video" } })).toBe(9 * 60_000);
  });

  it("hands a long job's Claude calls its deadline and the time left as their own", async () => {
    const seen: Array<Record<string, unknown>> = [];
    const client = fakeClient([media("video"), media("card")]);
    const runner = fakeRunner();
    runner.runClaudeJson.mockImplementation(async (o: Record<string, unknown>) => { seen.push(o); return {}; });
    const worker = createWorker({
      client, runner, kinds: ["post_media"], pollWaitSeconds: 0, logger: quiet,
      deps: { getProfile: vi.fn(), runClaudeJson: vi.fn() } as never,
      runHandler: async (_job, deps) => { await deps.runClaudeJson({ prompt: "p", system: "s", schema: {}, parse: (x) => x }); return { ok: true, result: {} }; },
    });
    const before = Date.now();
    await worker.drain(() => false);
    const [video, card] = seen;
    expect(video!.deadline as number).toBeGreaterThanOrEqual(before + 40 * 60_000);
    expect(video!.timeoutMs as number).toBeGreaterThan(39 * 60_000);
    expect(card!.deadline as number).toBeLessThan(before + 10 * 60_000);
    expect(card!.timeoutMs).toBeUndefined();
  });
});

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
    heartbeat: vi.fn(async (_kinds: string[], _running?: string[]) => ({ claudeModel: null as "sonnet" | "opus" | "haiku" | null })),
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
    expect(client.claimJob).toHaveBeenCalledWith(["generate_from_idea"], 0, undefined);
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

  it("lists the job it's running, and none once it's reported", async () => {
    const client = fakeClient([job("a")]);
    let worker!: ReturnType<typeof createWorker>;
    worker = createWorker({
      client, runner: fakeRunner(), kinds: ["generate_from_idea"], pollWaitSeconds: 0, logger: quiet,
      deps: { getProfile: vi.fn(), runClaudeJson: vi.fn() } as never,
      runHandler: async () => { await worker.heartbeat(); return { ok: true, result: {} }; },
    });
    await worker.claimAndRun();
    await worker.heartbeat();
    expect(client.heartbeat.mock.calls.map((c) => c[1])).toEqual([["a"], []]);
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
