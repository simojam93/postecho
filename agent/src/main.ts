import { createClaudeRunner } from "./claude.js";
import { loadConfig } from "./config.js";
import { HandlerDeps, runHandler, SERVED_KINDS } from "./handlers.js";
import { createPostEchoClient, type Job } from "./postecho.js";
import { fetchTranscript } from "./transcript.js";

const HEARTBEAT_INTERVAL_MS = 60_000;
const CLAIM_ERROR_BACKOFF_MS = 2_000;
/**
 * Every job is over within this, however many Claude calls it makes: the web
 * puts a job still claimed after 10 minutes back in the queue
 * (web/src/app/api/agent/jobs/route.ts's STALE_CLAIM_MS), and a result posted
 * after that would be lost while the job ran twice.
 */
const JOB_BUDGET_MS = 9 * 60_000;
/** The jobs that read a whole video's transcript: their Claude calls get twice the time. */
const LONG_READS = new Set(["video_ideas", "generate_from_video"]);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * The poll loop: heartbeat every 60s -> claim one job (a quick ask by
 * default; a long-poll of up to POLL_WAIT_SECONDS if set) -> run its handler
 * -> postResult -> repeat, pausing POLL_IDLE_SECONDS after a claim that found
 * nothing. The short ask is for hosting: on Vercel a long-poll keeps a
 * function alive around the clock, and Fluid compute bills that time. Single
 * concurrency by construction (a plain sequential loop, never Promise.all
 * across jobs) — the point is one job on the owner's Mac at a time, not
 * throughput.
 *
 * SIGINT/SIGTERM set a flag checked between iterations, so a job already
 * running — or one claimed by a poll that was in flight when the signal
 * arrived — is always finished and reported before the process exits. Since
 * claimJob can itself be blocked in a long-poll for up to
 * POLL_WAIT_SECONDS (default 25s) when a signal arrives, shutdown can take
 * up to that long in the worst case — deliberately simple over instant:
 * no in-flight-request cancellation, no corrupted partial state either.
 */
export async function runAgent(): Promise<void> {
  const config = loadConfig();
  const client = createPostEchoClient({ baseUrl: config.postechoUrl, token: config.agentToken });
  const runner = createClaudeRunner({
    claudeBin: config.claudeBin,
    model: config.claudeModel,
    timeoutMs: config.claudeTimeoutMs,
  });

  const deps: HandlerDeps = {
    getProfile: () => client.getProfile(),
    runClaudeJson: (opts) => runner.runClaudeJson(opts),
    fetchTranscript,
    checkSlop: (text, platform) => client.slopCheck(text, platform),
  };

  let stopping = false;
  const requestStop = (signal: string) => {
    if (stopping) return; // second Ctrl-C etc. — already stopping, nothing more to do here.
    console.log(`[agent] ${signal} received — finishing the current job (if any), then stopping...`);
    stopping = true;
  };
  process.once("SIGINT", () => requestStop("SIGINT"));
  process.once("SIGTERM", () => requestStop("SIGTERM"));

  console.log(`[agent] starting — ${config.postechoUrl}, kinds: ${SERVED_KINDS.join(", ")}`);

  let lastHeartbeatAt = 0;

  while (!stopping) {
    if (Date.now() - lastHeartbeatAt >= HEARTBEAT_INTERVAL_MS) {
      try {
        const answer = await client.heartbeat(SERVED_KINDS);
        lastHeartbeatAt = Date.now();
        if (answer.claudeModel && answer.claudeModel !== runner.model) {
          runner.setModel(answer.claudeModel);
          console.log(`[agent] writing with Claude ${answer.claudeModel} from now on (Settings › AI tools)`);
        }
      } catch (e) {
        console.error(`[agent] heartbeat failed: ${errorMessage(e)}`);
      }
    }

    let job: Job | null;
    try {
      job = await client.claimJob(SERVED_KINDS, config.pollWaitSeconds);
    } catch (e) {
      console.error(`[agent] claimJob failed: ${errorMessage(e)}`);
      await sleep(CLAIM_ERROR_BACKOFF_MS);
      continue;
    }

    // A job that came back from a claim that was already in flight when the
    // stop signal arrived is still OURS (the server marked it claimed): run
    // and report it rather than abandoning it in `claimed` until the
    // 10-minute stale sweep. The while condition stops the loop right after.
    if (!job) {
      await sleep(config.pollIdleSeconds * 1000);
      continue;
    }

    console.log(`[agent] claimed job ${job.id} (${job.kind})`);
    const startedAt = Date.now();
    // Progress is per job: it posts to this job's id with this claim's ownership echo.
    const claimed = job;
    const deadline = startedAt + JOB_BUDGET_MS;
    const long = LONG_READS.has(job.kind);
    const outcome = await runHandler(job, {
      ...deps,
      runClaudeJson: (opts) => runner.runClaudeJson({ ...opts, long, deadline }),
      reportProgress: (progress) => client.reportProgress(claimed.id, claimed.claimedAt, progress),
    });
    const elapsedMs = Date.now() - startedAt;
    console.log(
      `[agent] job ${job.id} ${outcome.ok ? "done" : "failed"} in ${elapsedMs}ms` +
        (outcome.ok ? "" : `: ${outcome.error}`),
    );

    try {
      await client.postResult(job.id, job.claimedAt, outcome);
    } catch (e) {
      console.error(`[agent] postResult failed for job ${job.id}: ${errorMessage(e)}`);
    }
  }

  console.log("[agent] stopped.");
}

runAgent().catch((e) => {
  console.error(`[agent] fatal: ${errorMessage(e)}`);
  process.exitCode = 1;
});
