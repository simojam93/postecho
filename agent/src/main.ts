import { createClaudeRunner } from "./claude.js";
import { loadConfig } from "./config.js";
import { HandlerDeps, SERVED_KINDS } from "./handlers.js";
import { pickFolder } from "./pick-folder.js";
import { createPostEchoClient } from "./postecho.js";
import { resolveRepoOnThisComputer } from "./repo-source.js";
import { fetchTranscript } from "./transcript.js";
import { runAgentLoop } from "./run.js";
import { createWorker, errorMessage } from "./worker.js";

/**
 * Wires the agent together: the config, the PostEcho client, Claude Code,
 * the worker (worker.ts), which claims, runs and reports jobs, and the mode
 * (run.ts): asleep until the page wakes it, or polling with AGENT_WAKE_PORT=0.
 *
 * SIGINT/SIGTERM set a flag checked between jobs, so a job already running is
 * always finished and reported before the process exits; the wake server
 * closes first.
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
    resolveRepo: resolveRepoOnThisComputer,
    pickFolder: () => pickFolder(),
  };
  const worker = createWorker({ client, runner, deps, kinds: SERVED_KINDS, pollWaitSeconds: config.pollWaitSeconds });

  let stopping = false;
  let signalStop!: () => void;
  const stopped = new Promise<void>((resolve) => { signalStop = resolve; });
  const requestStop = (signal: string) => {
    if (stopping) return; // second Ctrl-C etc. — already stopping, nothing more to do here.
    console.log(`[agent] ${signal} received — finishing the current job (if any), then stopping...`);
    stopping = true;
    signalStop();
  };
  process.once("SIGINT", () => requestStop("SIGINT"));
  process.once("SIGTERM", () => requestStop("SIGTERM"));

  console.log(`[agent] starting — ${config.postechoUrl}, kinds: ${SERVED_KINDS.join(", ")}`);
  await runAgentLoop({
    worker,
    wakePort: config.wakePort,
    origin: new URL(config.postechoUrl).origin,
    awakeMs: config.awakeMinutes * 60_000,
    idleCheckMs: config.idleCheckMinutes * 60_000,
    pollIdleSeconds: config.pollIdleSeconds,
    isStopping: () => stopping,
    stopped,
  });
  console.log("[agent] stopped.");
}

runAgent().catch((e) => {
  console.error(`[agent] fatal: ${errorMessage(e)}`);
  process.exitCode = 1;
});
