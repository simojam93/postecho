export type PolledJob = {
  id: string;
  status: string;
  result: Record<string, unknown> | null;
  [key: string]: unknown;
};

export type PollJobOptions = {
  /** Default 3000ms — matches every "Claude is …" wait in the Create tab and Settings (M2 plan tasks A7/A8/A9). */
  intervalMs?: number;
  /** Defaults to "done" or "failed" — override for a different terminal-state notion. */
  isDone?: (job: PolledJob) => boolean;
  /** Called with every polled row, terminal or not — e.g. a Humanize's live round (M3.6). */
  onPoll?: (job: PolledJob) => void;
  /** Stops polling (the returned promise rejects with an AbortError) — e.g. when the page unmounts. */
  signal?: AbortSignal;
};

const DEFAULT_INTERVAL_MS = 3000;

function defaultIsDone(job: PolledJob): boolean {
  return job.status === "done" || job.status === "failed";
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
  });
}

function abortError(): Error {
  const error = new Error("polling aborted");
  error.name = "AbortError";
  return error;
}

/**
 * Polls `GET /api/jobs?id=<jobId>` every `intervalMs` (default 3s) until the
 * job reaches a terminal status — the shared wait behind every "Claude is
 * writing/rewriting…" state in the Create tab (Refine, Image prompt) and
 * Settings' Analyze my posts, so each caller isn't hand-rolling its own
 * setTimeout loop. Resolves with the job as soon as `isDone` is true; throws
 * if a poll request itself fails (network/5xx), since that's a caller-visible
 * failure distinct from the job merely still being in flight.
 */
export async function pollJob(jobId: string, options: PollJobOptions = {}): Promise<PolledJob> {
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  const isDone = options.isDone ?? defaultIsDone;

  for (;;) {
    if (options.signal?.aborted) throw abortError();
    const url = `/api/jobs?id=${jobId}`;
    const res = await (options.signal ? fetch(url, { signal: options.signal }) : fetch(url));
    if (!res.ok) throw new Error(`failed to poll job ${jobId} (${res.status})`);
    const body = await res.json();
    const job = body.jobs?.[0] as PolledJob | undefined;
    if (job) options.onPoll?.(job);
    if (job && isDone(job)) return job;
    await sleep(intervalMs, options.signal);
  }
}
