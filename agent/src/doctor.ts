import { execFileSync } from "node:child_process";
import { z } from "zod";
import { ClaudeTimeoutError, createClaudeRunner } from "./claude.js";
import { loadConfig } from "./config.js";
import { SERVED_KINDS } from "./handlers.js";
import { createPostEchoClient } from "./postecho.js";

const DOCTOR_SCHEMA = {
  type: "object",
  properties: { ok: { type: "boolean" } },
  required: ["ok"],
  additionalProperties: false,
};

const DoctorResultSchema = z.object({ ok: z.boolean() });

/**
 * A healthy login answers this trivial prompt in a few seconds. Observed
 * live (2026-09-22, CLI 2.1.66) with an expired stored OAuth token: `claude
 * -p` kept silently retrying the auth failure for 4+ minutes, so waiting for
 * it to name the cause buys nothing. Doctor therefore caps its wait well
 * below the job runner's CLAUDE_TIMEOUT_MS and explains the likely cause on
 * timeout instead of making the owner stare at a spinner.
 */
const DOCTOR_MAX_TIMEOUT_MS = 90_000;

const RELOGIN_HINT =
  "The Claude Code CLI login on this Mac needs re-authenticating: run `claude` interactively once (then `/login`), " +
  "or run `claude setup-token` and put the token in agent/.env as CLAUDE_CODE_OAUTH_TOKEN (recommended for the " +
  "launchd daemon — it doesn't depend on the interactive session's refresh cycle). Then re-run `npm run doctor`.";

function claudeVersion(claudeBin: string): string {
  try {
    return execFileSync(claudeBin, ["--version"], { encoding: "utf8" }).trim();
  } catch (e) {
    return `(could not read version: ${e instanceof Error ? e.message : String(e)})`;
  }
}

/**
 * Sanity-checks the headless Claude Code path end to end — the thing this
 * whole agent depends on — without needing postecho-web running (that part
 * is a best-effort bonus check below, per the plan: "doctor must not need
 * the server for the claude check").
 */
async function main() {
  const config = loadConfig();

  console.log(`claude binary: ${config.claudeBin}`);
  console.log(`claude version: ${claudeVersion(config.claudeBin)}`);

  const timeoutMs = Math.min(config.claudeTimeoutMs, DOCTOR_MAX_TIMEOUT_MS);
  const runner = createClaudeRunner({
    claudeBin: config.claudeBin,
    model: config.claudeModel,
    timeoutMs,
  });

  console.log(
    `running a trivial {ok:boolean} schema prompt via claude -p --model ${config.claudeModel} ` +
      `(a healthy login answers in a few seconds; giving it up to ${Math.round(timeoutMs / 1000)}s)...`,
  );
  const startedAt = Date.now();
  try {
    const result = await runner.runClaudeJson({
      prompt: "Reply with ok set to true.",
      system: "You are a non-interactive health check. Reply only with JSON matching the schema — no prose, no markdown.",
      schema: DOCTOR_SCHEMA,
      parse: (x) => DoctorResultSchema.parse(x),
    });
    const elapsedMs = Date.now() - startedAt;
    console.log(`claude -p OK: ${JSON.stringify(result)} (elapsed ${elapsedMs}ms)`);
  } catch (e) {
    const elapsedMs = Date.now() - startedAt;
    console.error(`claude -p FAILED after ${elapsedMs}ms: ${e instanceof Error ? e.message : String(e)}`);
    if (e instanceof ClaudeTimeoutError) {
      console.error(
        "A trivial prompt normally completes in a few seconds. A timeout here almost always means the CLI's stored " +
          "login has expired: it silently retries the auth failure for minutes before giving up. " + RELOGIN_HINT,
      );
    } else {
      console.error("If this mentions authentication/OAuth: " + RELOGIN_HINT);
    }
    process.exitCode = 1;
    return; // The heartbeat check below is secondary; skip it if the actual point of doctor failed.
  }

  console.log(`pinging heartbeat at ${config.postechoUrl} (best-effort — postecho-web doesn't need to be up)...`);
  try {
    const client = createPostEchoClient({ baseUrl: config.postechoUrl, token: config.agentToken });
    await client.heartbeat(SERVED_KINDS);
    console.log("heartbeat OK — postecho-web is reachable.");
  } catch (e) {
    console.warn(
      `heartbeat check skipped (non-fatal): ${e instanceof Error ? e.message : String(e)} ` +
        "— this is expected if postecho-web isn't running right now.",
    );
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exitCode = 1;
});
