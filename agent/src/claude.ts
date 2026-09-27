import { spawn as nodeSpawn } from "node:child_process";

/**
 * The narrow slice of Node's ChildProcess this module actually touches.
 * child_process.spawn's real type is a large overload set (options-only
 * calls, stdio tuple variants, etc.) that a simple test fake can never
 * structurally satisfy; depending on this instead — and casting the real
 * `spawn` to it once, right where it's used as the default — keeps the
 * injection point trivial to fake without losing type safety in the rest
 * of this module.
 */
export type ChildProcessLike = {
  stdout: NodeJS.ReadableStream | null;
  stderr: NodeJS.ReadableStream | null;
  stdin: NodeJS.WritableStream | null;
  on(event: "error", listener: (err: Error) => void): unknown;
  on(event: "close", listener: (code: number | null) => void): unknown;
  kill(signal?: NodeJS.Signals | number): boolean;
};

export type SpawnFn = (command: string, args: string[], options: { stdio: ["pipe", "pipe", "pipe"] }) => ChildProcessLike;

/**
 * `claude -p --output-format json`'s top-level envelope.
 *
 * Exact shape observed live from this checkout (2026-09-22), running:
 *
 *   unset CLAUDECODE && echo hi | claude -p --output-format json \
 *     --no-session-persistence --allowedTools "" --model sonnet
 *
 * (CLAUDECODE has to be unset because Claude Code refuses to launch a
 * nested session otherwise — irrelevant to the real daemon, which never
 * runs from inside another Claude Code session in the first place.) This
 * confirms two things the plan asked to verify: (a) `-p` reads the prompt
 * from stdin when no positional prompt argument is given at all — the
 * process ran a real (billable-shaped) API turn rather than erroring for a
 * missing prompt — and (b) the exact top-level JSON printed to stdout:
 *
 * {
 *   "type": "result",
 *   "subtype": "success",
 *   "is_error": true,
 *   "duration_ms": 191681,
 *   "duration_api_ms": 0,
 *   "num_turns": 1,
 *   "result": "Failed to authenticate. API Error: 401 {\"type\":\"error\",\"error\":{\"type\":\"authentication_error\",\"message\":\"OAuth access token has expired. Re-authenticate to continue.\"},\"request_id\":null}",
 *   "stop_reason": "stop_sequence",
 *   "session_id": "ce6a5cd3-24c5-4edf-8009-743380009697",
 *   "total_cost_usd": 0,
 *   "usage": { "input_tokens": 0, "cache_creation_input_tokens": 0, "cache_read_input_tokens": 0, "output_tokens": 0, "server_tool_use": { "web_search_requests": 0, "web_fetch_requests": 0 }, "service_tier": "standard", "cache_creation": { "ephemeral_1h_input_tokens": 0, "ephemeral_5m_input_tokens": 0 }, "inference_geo": "", "iterations": [], "speed": "standard" },
 *   "modelUsage": {},
 *   "permission_denials": [],
 *   "fast_mode_state": "off",
 *   "uuid": "39086997-2c9f-4173-aa68-c8dc5b6cdad1"
 * }
 *
 * Reproduced identically (same fields, same message) on a second attempt
 * with ANTHROPIC_BASE_URL also unset, ruling out this dev sandbox's own
 * routing as the cause — this checkout's Claude Code login has a genuinely
 * expired OAuth access token and needs an interactive `claude` re-auth (or
 * `claude setup-token` for a long-lived headless token) before any live run
 * — including `npm run doctor` — will get past this. That's an account/
 * environment state, not a code defect; see the task report.
 *
 * No `--json-schema` was passed for this check (this exact command is what
 * the plan asked to verify, and it has no schema flag), and the call errored
 * before any model turn produced output, so no `structured_output` field
 * was observed either way. Per the plan, runClaudeJson still prefers
 * `structured_output` when the CLI includes it and otherwise parses the
 * `result` string as JSON — `result` is confirmed to always be a plain
 * string (an error message here; the plan documents it as the model's
 * JSON-as-text reply on the success path).
 */
export type ClaudeEnvelope = {
  type: string;
  subtype: string;
  is_error: boolean;
  duration_ms: number;
  duration_api_ms: number;
  num_turns: number;
  result: string;
  stop_reason?: string | null;
  session_id?: string;
  total_cost_usd?: number;
  usage?: Record<string, unknown>;
  modelUsage?: Record<string, unknown>;
  permission_denials?: unknown[];
  fast_mode_state?: string;
  uuid?: string;
  /** Present (per the plan) when the CLI itself validated the reply against --json-schema; preferred over parsing `result`. */
  structured_output?: unknown;
};

/**
 * The `claude -p` child was killed for running past its time (CLAUDE_TIMEOUT_MS,
 * longer for Opus and for long reads, never past the job's deadline), or the
 * job had no time left to start it. Never retried: a slow run is not a parse
 * problem. Its message is what the page shows, in PostEcho's words.
 */
export class ClaudeTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClaudeTimeoutError";
  }
}

/** The CLI itself reported `is_error: true` (auth failure, refusal, etc.). Never retried — repeating the same call won't fix an account/API-level error. */
export class ClaudeRunError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClaudeRunError";
  }
}

/** The envelope (or its `result` string, or the caller's schema) didn't parse. Eligible for exactly one retry with a sharper system-prompt reminder. */
export class ClaudeParseError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, cause !== undefined ? { cause } : undefined);
    this.name = "ClaudeParseError";
  }
}

export type ClaudeRunnerDeps = {
  claudeBin: string;
  model: string;
  timeoutMs: number;
  /** Injected for testing; defaults to node:child_process's spawn. */
  spawnImpl?: SpawnFn;
};

export type RunClaudeJsonOptions<T> = {
  prompt: string;
  system: string;
  schema: object;
  parse: (value: unknown) => T;
  /** A long read, a whole video's transcript: twice the time. */
  long?: boolean;
  /** When the whole job must be over (epoch ms): every call ends by then, and one with under MIN_CALL_MS left isn't started. */
  deadline?: number;
};

/**
 * Opus takes about twice Sonnet's time for the same answer (live 2026-09-27:
 * a whole-transcript video_ideas ran past 3 minutes on Opus), so it gets
 * twice the time per call.
 */
const SLOW_MODELS = new Set(["opus"]);
/** A call with less than this left before the job's deadline isn't worth starting. */
const MIN_CALL_MS = 30_000;

/** What the page says when a run takes too long, in PostEcho's words (the owner: "è sempre postecho che fa tutto"). */
function tooLongMessage(ms: number): string {
  const took = ms >= 60_000 ? `${Math.round(ms / 60_000)} min` : `${Math.round(ms / 1000)} s`;
  return `PostEcho stopped after ${took} without an answer. Try again, or pick a faster model in Settings › AI tools.`;
}

const RETRY_REMINDER =
  "\n\nReturn ONLY valid JSON matching the schema. No prose, no markdown code fences, no explanation.";

function buildArgs(model: string, schema: object, system: string): string[] {
  return [
    "-p",
    "--output-format",
    "json",
    "--json-schema",
    JSON.stringify(schema),
    "--model",
    model,
    "--no-session-persistence",
    "--system-prompt",
    system,
    "--allowedTools",
    "",
  ];
}

/**
 * Runs one `claude -p` child process to completion. The prompt goes to
 * stdin — never argv — to sidestep OS command-line length limits (a video
 * transcript alone can run up to 60k chars; see transcript.ts).
 */
function spawnClaude(
  spawnImpl: SpawnFn,
  claudeBin: string,
  args: string[],
  prompt: string,
  timeoutMs: number,
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    const child = spawnImpl(claudeBin, args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      reject(new ClaudeTimeoutError(tooLongMessage(timeoutMs)));
    }, timeoutMs);

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });

    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });

    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ stdout, stderr, code });
    });

    child.stdin?.write(prompt);
    child.stdin?.end();
  });
}

export function createClaudeRunner(deps: ClaudeRunnerDeps) {
  const spawnImpl = deps.spawnImpl ?? (nodeSpawn as unknown as SpawnFn);
  // The owner picks it in Settings › AI tools (2026-09-26); the heartbeat's answer brings it.
  let model = deps.model;

  /** This call's time: CLAUDE_TIMEOUT_MS, doubled for a slow model and again for a long read, never past the job's deadline. */
  function timeoutFor(opts: { long?: boolean; deadline?: number }): number {
    const perCall = deps.timeoutMs * (SLOW_MODELS.has(model) ? 2 : 1) * (opts.long ? 2 : 1);
    if (opts.deadline === undefined) return perCall;
    const left = opts.deadline - Date.now();
    if (left < MIN_CALL_MS) throw new ClaudeTimeoutError("PostEcho ran out of time for this one. Try again.");
    return Math.min(perCall, left);
  }

  async function attemptOnce<T>(opts: RunClaudeJsonOptions<T>, system: string): Promise<T> {
    const timeoutMs = timeoutFor(opts);
    const startedAt = Date.now();
    const { stdout, stderr, code } = await spawnClaude(
      spawnImpl,
      deps.claudeBin,
      buildArgs(model, opts.schema, system),
      opts.prompt,
      timeoutMs,
    );
    const elapsedMs = Date.now() - startedAt;

    let envelope: ClaudeEnvelope;
    try {
      envelope = JSON.parse(stdout) as ClaudeEnvelope;
    } catch (cause) {
      // Never log stdout/stderr/prompt contents — sizes and durations only.
      console.error("[claude] stdout was not a JSON envelope", {
        elapsedMs,
        exitCode: code,
        stdoutChars: stdout.length,
        stderrChars: stderr.length,
      });
      throw new ClaudeParseError("claude -p did not print a JSON envelope", cause);
    }

    if (envelope.is_error) {
      throw new ClaudeRunError(envelope.result || `claude -p reported an error (exit ${code})`);
    }

    let raw: unknown;
    if (envelope.structured_output !== undefined) {
      raw = envelope.structured_output;
    } else {
      try {
        raw = JSON.parse(envelope.result);
      } catch (cause) {
        throw new ClaudeParseError("claude's `result` was not valid JSON", cause);
      }
    }

    return opts.parse(raw);
  }

  return {
    /** The model the next runs use: an alias Claude Code knows (sonnet, opus, haiku). */
    get model() {
      return model;
    },
    setModel(next: string) {
      model = next;
    },

    /**
     * Runs `prompt`/`system` through `claude -p --json-schema`, validates
     * the reply with `parse`, and returns the parsed value. Kills the
     * child and throws ClaudeTimeoutError past its time (see timeoutFor;
     * no retry). Throws ClaudeRunError immediately when the CLI itself
     * reports `is_error` (no retry — it's not a parse problem). Any other
     * failure — the envelope, the `result` string, or `parse()` (typically
     * a zod schema) rejecting the reply — gets exactly one retry with a
     * "return ONLY valid JSON" reminder appended to the system prompt.
     */
    async runClaudeJson<T>(opts: RunClaudeJsonOptions<T>): Promise<T> {
      const startedAt = Date.now();
      try {
        const value = await attemptOnce(opts, opts.system);
        console.log(`[claude] reply in ${Math.round((Date.now() - startedAt) / 1000)}s`);
        return value;
      } catch (firstError) {
        if (firstError instanceof ClaudeTimeoutError || firstError instanceof ClaudeRunError) {
          throw firstError;
        }
        // Logged, so a slow job says why (live 2026-09-24: a generation took
        // 148 s where a replay of the same prompt took 43 s).
        const reason = firstError instanceof Error ? firstError.message.slice(0, 200) : String(firstError);
        console.warn(`[claude] reply didn't validate after ${Math.round((Date.now() - startedAt) / 1000)}s, retrying once: ${reason}`);
        const value = await attemptOnce(opts, opts.system + RETRY_REMINDER);
        console.log(`[claude] retry reply in ${Math.round((Date.now() - startedAt) / 1000)}s total`);
        return value;
      }
    },
  };
}

export type ClaudeRunner = ReturnType<typeof createClaudeRunner>;
