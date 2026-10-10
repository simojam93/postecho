import { createClaudeRunner } from "./claude.js";
import { loadConfig } from "./config.js";
import { HandlerDeps, SERVED_KINDS } from "./handlers.js";
import { pickFolder } from "./pick-folder.js";
import { createPostEchoClient } from "./postecho.js";
import { resolveRepoOnThisComputer } from "./repo-source.js";
import { fetchTranscript } from "./transcript.js";
import { createWorker, errorMessage, runPollLoop } from "./worker.js";

/**
 * Wires the agent together: the config, the PostEcho client, Claude Code and
 * the worker (worker.ts), which claims, runs and reports jobs.
 *
 * SIGINT/SIGTERM set a flag checked between jobs, so a job already running is
 * always finished and reported before the process exits.
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
  const requestStop = (signal: string) => {
    if (stopping) return; // second Ctrl-C etc. — already stopping, nothing more to do here.
    console.log(`[agent] ${signal} received — finishing the current job (if any), then stopping...`);
    stopping = true;
  };
  process.once("SIGINT", () => requestStop("SIGINT"));
  process.once("SIGTERM", () => requestStop("SIGTERM"));

  console.log(`[agent] starting — ${config.postechoUrl}, kinds: ${SERVED_KINDS.join(", ")}`);
  await runPollLoop({ worker, isStopping: () => stopping, pollIdleSeconds: config.pollIdleSeconds });
  console.log("[agent] stopped.");
}

runAgent().catch((e) => {
  console.error(`[agent] fatal: ${errorMessage(e)}`);
  process.exitCode = 1;
});
