import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  ClaudeRunError,
  ClaudeTimeoutError,
  createClaudeRunner,
} from "./claude.js";

type FakeChildOptions = {
  stdoutChunks?: string[];
  stderrChunks?: string[];
  exitCode?: number | null;
  neverCloses?: boolean;
  emitSpawnError?: Error;
};

function fakeChild(opts: FakeChildOptions = {}) {
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  const written: string[] = [];
  let ended = false;

  const proc = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    stdin: { write: (chunk: string) => boolean; end: () => void; written: string[] };
    kill: (signal?: string) => void;
  };
  proc.stdout = stdout;
  proc.stderr = stderr;
  proc.stdin = {
    write: (chunk: string) => {
      written.push(chunk);
      return true;
    },
    end: () => {
      ended = true;
    },
    written,
  };
  proc.kill = vi.fn();

  queueMicrotask(() => {
    for (const chunk of opts.stdoutChunks ?? []) stdout.emit("data", Buffer.from(chunk));
    for (const chunk of opts.stderrChunks ?? []) stderr.emit("data", Buffer.from(chunk));
    if (opts.neverCloses) return;
    if (opts.emitSpawnError) {
      proc.emit("error", opts.emitSpawnError);
      return;
    }
    proc.emit("close", opts.exitCode ?? 0);
  });

  return Object.assign(proc, { __ended: () => ended });
}

function successEnvelope(result: unknown, extra: Record<string, unknown> = {}) {
  return JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    duration_ms: 12,
    duration_api_ms: 8,
    num_turns: 1,
    result: typeof result === "string" ? result : JSON.stringify(result),
    stop_reason: "stop_sequence",
    session_id: "session-1",
    total_cost_usd: 0.001,
    ...extra,
  });
}

describe("createClaudeRunner", () => {
  it("writes with the model the owner picks, from the next run on (2026-09-26)", async () => {
    const models: string[] = [];
    const spawnImpl = vi.fn((_bin: string, args: readonly string[]) => {
      models.push(args[args.indexOf("--model") + 1] ?? "");
      return fakeChild({ stdoutChunks: [successEnvelope({ ok: true })] }) as never;
    });
    const runner = createClaudeRunner({ claudeBin: "claude", model: "sonnet", timeoutMs: 5000, spawnImpl });
    const opts = { prompt: "p", system: "s", schema: { type: "object" }, parse: (x: unknown) => x };
    await runner.runClaudeJson(opts);
    runner.setModel("opus");
    expect(runner.model).toBe("opus");
    await runner.runClaudeJson(opts);
    expect(models).toEqual(["sonnet", "opus"]);
  });

  it("spawns claude -p with the documented flags and writes the prompt to stdin, never argv", async () => {
    let capturedBin = "";
    let capturedArgs: string[] = [];
    let child: ReturnType<typeof fakeChild>;
    const spawnImpl = vi.fn((bin: string, args: readonly string[]) => {
      capturedBin = bin;
      capturedArgs = [...args];
      child = fakeChild({ stdoutChunks: [successEnvelope({ ok: true })] });
      return child as never;
    });

    const runner = createClaudeRunner({ claudeBin: "claude", model: "sonnet", timeoutMs: 5000, spawnImpl });
    const schema = { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] };
    const value = await runner.runClaudeJson({
      prompt: "the secret prompt text",
      system: "the system prompt text",
      schema,
      parse: (x) => z.object({ ok: z.boolean() }).parse(x),
    });

    expect(value).toEqual({ ok: true });
    expect(capturedBin).toBe("claude");
    expect(capturedArgs).toEqual([
      "-p",
      "--output-format",
      "json",
      "--json-schema",
      JSON.stringify(schema),
      "--model",
      "sonnet",
      "--no-session-persistence",
      "--system-prompt",
      "the system prompt text",
      "--allowedTools",
      "",
    ]);
    expect(capturedArgs.join(" ")).not.toContain("the secret prompt text");
    expect(child!.stdin.written.join("")).toBe("the secret prompt text");
  });

  it("prefers structured_output over parsing the result string when both are present", async () => {
    const spawnImpl = vi.fn(() =>
      fakeChild({
        stdoutChunks: [
          successEnvelope("this raw text should be ignored", { structured_output: { ok: true } }),
        ],
      }) as never,
    );
    const runner = createClaudeRunner({ claudeBin: "claude", model: "sonnet", timeoutMs: 5000, spawnImpl });
    const value = await runner.runClaudeJson({
      prompt: "p",
      system: "s",
      schema: { type: "object" },
      parse: (x) => z.object({ ok: z.boolean() }).parse(x),
    });
    expect(value).toEqual({ ok: true });
    expect(spawnImpl).toHaveBeenCalledTimes(1);
  });

  it("falls back to parsing the result string as JSON when there is no structured_output", async () => {
    const spawnImpl = vi.fn(() => fakeChild({ stdoutChunks: [successEnvelope({ ok: true })] }) as never);
    const runner = createClaudeRunner({ claudeBin: "claude", model: "sonnet", timeoutMs: 5000, spawnImpl });
    const value = await runner.runClaudeJson({
      prompt: "p",
      system: "s",
      schema: { type: "object" },
      parse: (x) => z.object({ ok: z.boolean() }).parse(x),
    });
    expect(value).toEqual({ ok: true });
  });

  it("throws a ClaudeRunError immediately (no retry) when the envelope reports is_error", async () => {
    const spawnImpl = vi.fn(() =>
      fakeChild({
        stdoutChunks: [
          JSON.stringify({
            type: "result",
            subtype: "error_during_execution",
            is_error: true,
            duration_ms: 5,
            duration_api_ms: 0,
            num_turns: 1,
            result: "Failed to authenticate. API Error: 401",
          }),
        ],
      }) as never,
    );
    const runner = createClaudeRunner({ claudeBin: "claude", model: "sonnet", timeoutMs: 5000, spawnImpl });
    await expect(
      runner.runClaudeJson({ prompt: "p", system: "s", schema: {}, parse: (x) => x }),
    ).rejects.toThrow(ClaudeRunError);
    expect(spawnImpl).toHaveBeenCalledTimes(1);
  });

  it("retries once with a reminder appended to the system prompt when the result isn't valid JSON, then succeeds", async () => {
    const systemsSeen: string[] = [];
    const spawnImpl = vi.fn((_bin: string, args: readonly string[]) => {
      const idx = args.indexOf("--system-prompt");
      systemsSeen.push(String(args[idx + 1]));
      const isFirstAttempt = systemsSeen.length === 1;
      return fakeChild({
        stdoutChunks: [successEnvelope(isFirstAttempt ? "not valid json at all" : { ok: true })],
      }) as never;
    });

    const runner = createClaudeRunner({ claudeBin: "claude", model: "sonnet", timeoutMs: 5000, spawnImpl });
    const value = await runner.runClaudeJson({
      prompt: "p",
      system: "base system",
      schema: { type: "object" },
      parse: (x) => z.object({ ok: z.boolean() }).parse(x),
    });

    expect(value).toEqual({ ok: true });
    expect(spawnImpl).toHaveBeenCalledTimes(2);
    expect(systemsSeen[0]).toBe("base system");
    expect(systemsSeen[1]!.startsWith("base system")).toBe(true);
    expect(systemsSeen[1]).not.toBe(systemsSeen[0]);
  });

  it("retries once on a schema-validation failure and throws if the retry also fails", async () => {
    const spawnImpl = vi.fn(() => fakeChild({ stdoutChunks: [successEnvelope({ ok: "not-a-boolean" })] }) as never);
    const runner = createClaudeRunner({ claudeBin: "claude", model: "sonnet", timeoutMs: 5000, spawnImpl });
    await expect(
      runner.runClaudeJson({
        prompt: "p",
        system: "s",
        schema: {},
        parse: (x) => z.object({ ok: z.boolean() }).parse(x),
      }),
    ).rejects.toThrow();
    expect(spawnImpl).toHaveBeenCalledTimes(2);
  });

  it("kills the process and rejects with ClaudeTimeoutError when it runs past CLAUDE_TIMEOUT_MS", async () => {
    vi.useFakeTimers();
    try {
      const child = fakeChild({ neverCloses: true });
      const spawnImpl = vi.fn(() => child as never);
      const runner = createClaudeRunner({ claudeBin: "claude", model: "sonnet", timeoutMs: 1000, spawnImpl });

      const promise = runner.runClaudeJson({ prompt: "p", system: "s", schema: {}, parse: (x) => x });
      const assertion = expect(promise).rejects.toThrow(ClaudeTimeoutError);
      await vi.advanceTimersByTimeAsync(1000);
      await assertion;
      expect(child.kill).toHaveBeenCalledWith("SIGKILL");
    } finally {
      vi.useRealTimers();
    }
  });

  it("says it in PostEcho's words, not the CLI's", async () => {
    vi.useFakeTimers();
    try {
      const spawnImpl = vi.fn(() => fakeChild({ neverCloses: true }) as never);
      const runner = createClaudeRunner({ claudeBin: "claude", model: "sonnet", timeoutMs: 180_000, spawnImpl });
      const assertion = expect(runner.runClaudeJson({ prompt: "p", system: "s", schema: {}, parse: (x) => x }))
        .rejects.toThrow("PostEcho stopped after 3 min without an answer. Try again, or pick a faster model in Settings › AI tools.");
      await vi.advanceTimersByTimeAsync(180_000);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it("gives Opus twice the time, and a long read twice again (live 2026-09-27: a video_ideas ran past 3 min on Opus)", async () => {
    vi.useFakeTimers();
    try {
      const child = fakeChild({ neverCloses: true });
      const spawnImpl = vi.fn(() => child as never);
      const runner = createClaudeRunner({ claudeBin: "claude", model: "sonnet", timeoutMs: 1000, spawnImpl });
      runner.setModel("opus");
      let settled = false;
      const promise = runner.runClaudeJson({ prompt: "p", system: "s", schema: {}, parse: (x) => x, long: true });
      promise.catch(() => { settled = true; });
      await vi.advanceTimersByTimeAsync(3999);
      expect(settled).toBe(false);
      expect(child.kill).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      await expect(promise).rejects.toThrow(ClaudeTimeoutError);
      expect(child.kill).toHaveBeenCalledWith("SIGKILL");
    } finally {
      vi.useRealTimers();
    }
  });

  it("never runs past the job's deadline, and doesn't start a call with under 30 s left", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-09-27T10:00:00Z"));
      const child = fakeChild({ neverCloses: true });
      const spawnImpl = vi.fn(() => child as never);
      const runner = createClaudeRunner({ claudeBin: "claude", model: "opus", timeoutMs: 180_000, spawnImpl });
      const deadline = Date.now() + 40_000;
      const promise = runner.runClaudeJson({ prompt: "p", system: "s", schema: {}, parse: (x) => x, deadline });
      const assertion = expect(promise).rejects.toThrow("PostEcho stopped after 40 s");
      await vi.advanceTimersByTimeAsync(40_000);
      await assertion;

      await expect(runner.runClaudeJson({ prompt: "p", system: "s", schema: {}, parse: (x) => x, deadline: Date.now() + 29_000 }))
        .rejects.toThrow("PostEcho ran out of time for this one. Try again.");
      expect(spawnImpl).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not retry after a timeout", async () => {
    vi.useFakeTimers();
    try {
      const spawnImpl = vi.fn(() => fakeChild({ neverCloses: true }) as never);
      const runner = createClaudeRunner({ claudeBin: "claude", model: "sonnet", timeoutMs: 500, spawnImpl });
      const promise = runner.runClaudeJson({ prompt: "p", system: "s", schema: {}, parse: (x) => x });
      const assertion = expect(promise).rejects.toThrow(ClaudeTimeoutError);
      await vi.advanceTimersByTimeAsync(500);
      await assertion;
      expect(spawnImpl).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
