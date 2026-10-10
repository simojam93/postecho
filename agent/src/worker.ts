import type { ClaudeRunner } from "./claude.js";
import { runHandler as realRunHandler, type HandlerDeps } from "./handlers.js";
import type { Job, JobOutcome, PostEchoClient } from "./postecho.js";

const HEARTBEAT_INTERVAL_MS = 60_000;
const CLAIM_ERROR_BACKOFF_MS = 2_000;
/**
 * Every job is over within this, however many Claude calls it makes: the web
 * puts a job still claimed after 10 minutes back in the queue
 * (web/src/app/api/agent/jobs/route.ts's STALE_CLAIM_MS), and a result posted
 * after that would be lost while the job ran twice.
 */
const JOB_BUDGET_MS = 9 * 60_000;
/** The jobs that read a whole video's transcript, or a whole repository: their Claude calls get twice the time. */
const LONG_READS = new Set(["video_ideas", "generate_from_video", "repo_posts"]);

export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export type WorkerClient = Pick<PostEchoClient, "claimJob" | "postResult" | "heartbeat" | "reportProgress">;

/** The part of claude.ts's runner the worker touches. */
export type WorkerRunner = Pick<ClaudeRunner, "model" | "setModel" | "runClaudeJson">;

export type Logger = { log: (line: string) => void; error: (line: string) => void };

export type WorkerOptions = {
  client: WorkerClient;
  runner: WorkerRunner;
  /** Everything a handler needs except runClaudeJson and reportProgress, which are per job. */
  deps: HandlerDeps;
  kinds: string[];
  pollWaitSeconds: number;
  /** Injected for testing; defaults to handlers.ts's runHandler. */
  runHandler?: (job: Job, deps: HandlerDeps) => Promise<JobOutcome>;
  logger?: Logger;
};

export type ClaimResult = "ran" | "empty" | "error";

/**
 * Claim, run and report, shared by the poll loop and the wake mode. Single
 * concurrency by construction: a caller awaits one claimAndRun before the
 * next, never Promise.all across jobs. The point is one job on the owner's
 * computer at a time, not throughput.
 */
export function createWorker(opts: WorkerOptions) {
  const { client, runner, deps, kinds } = opts;
  const run = opts.runHandler ?? realRunHandler;
  const logger = opts.logger ?? console;

  /** POST /api/agent/heartbeat, following the model picked in Settings › AI tools. False when it failed. */
  async function heartbeat(): Promise<boolean> {
    try {
      const answer = await client.heartbeat(kinds);
      if (answer.claudeModel && answer.claudeModel !== runner.model) {
        runner.setModel(answer.claudeModel);
        logger.log(`[agent] writing with Claude ${answer.claudeModel} from now on (Settings › AI tools)`);
      }
      return true;
    } catch (e) {
      logger.error(`[agent] heartbeat failed: ${errorMessage(e)}`);
      return false;
    }
  }

  /**
   * One claim; a job it returns is run and reported. A job that came back
   * from a claim already in flight when a stop signal arrived is still ours
   * (the server marked it claimed), so it always runs rather than sitting in
   * `claimed` until the 10-minute stale sweep.
   */
  async function claimAndRun(): Promise<ClaimResult> {
    let job: Job | null;
    try {
      job = await client.claimJob(kinds, opts.pollWaitSeconds);
    } catch (e) {
      logger.error(`[agent] claimJob failed: ${errorMessage(e)}`);
      return "error";
    }
    if (!job) return "empty";

    logger.log(`[agent] claimed job ${job.id} (${job.kind})`);
    const startedAt = Date.now();
    // Progress is per job: it posts to this job's id with this claim's ownership echo.
    const claimed = job;
    const deadline = startedAt + JOB_BUDGET_MS;
    const long = LONG_READS.has(job.kind);
    const outcome = await run(job, {
      ...deps,
      runClaudeJson: (o) => runner.runClaudeJson({ ...o, long, deadline }),
      reportProgress: (progress) => client.reportProgress(claimed.id, claimed.claimedAt, progress),
    });
    const elapsedMs = Date.now() - startedAt;
    logger.log(
      `[agent] job ${job.id} ${outcome.ok ? "done" : "failed"} in ${elapsedMs}ms` + (outcome.ok ? "" : `: ${outcome.error}`),
    );

    try {
      await client.postResult(job.id, job.claimedAt, outcome);
    } catch (e) {
      logger.error(`[agent] postResult failed for job ${job.id}: ${errorMessage(e)}`);
    }
    return "ran";
  }

  /** Claims until the queue is empty. A failed claim ends it too: the next wake tries again, so an unreachable app isn't hammered. */
  async function drain(isStopping: () => boolean): Promise<void> {
    while (!isStopping()) {
      if ((await claimAndRun()) !== "ran") return;
    }
  }

  return { heartbeat, claimAndRun, drain };
}

export type Worker = ReturnType<typeof createWorker>;

/**
 * The poll loop, for AGENT_WAKE_PORT=0 or a taken port: heartbeat every 60 s,
 * claim one job (a quick ask by default, a long-poll of up to
 * POLL_WAIT_SECONDS if set), run it, report it, repeat, pausing
 * POLL_IDLE_SECONDS after a claim that found nothing. The short ask is for
 * hosting: on Vercel a long-poll keeps a function alive around the clock.
 *
 * isStopping is checked between iterations, so a running job is always
 * finished and reported before the loop ends. A long-poll in flight can
 * delay that by up to POLL_WAIT_SECONDS.
 */
export async function runPollLoop(opts: {
  worker: Worker;
  isStopping: () => boolean;
  pollIdleSeconds: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}): Promise<void> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = opts.now ?? Date.now;
  let lastHeartbeatAt = -Infinity;

  while (!opts.isStopping()) {
    if (now() - lastHeartbeatAt >= HEARTBEAT_INTERVAL_MS && (await opts.worker.heartbeat())) {
      lastHeartbeatAt = now();
    }
    const result = await opts.worker.claimAndRun();
    if (result === "error") await sleep(CLAIM_ERROR_BACKOFF_MS);
    else if (result === "empty") await sleep(opts.pollIdleSeconds * 1000);
  }
}
