import { and, eq, lt, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { jobKind, jobs } from "@/db/schema";
import { requireAgentToken } from "@/lib/agent-auth";

// The long-poll below can hold the connection open up to MAX_WAIT_SECONDS
// (25s); make sure the platform doesn't cut the invocation off before that.
export const maxDuration = 30;

// Derived from the `job_kind` pg enum (like GET /api/jobs's KindFilter) rather
// than a hand-maintained literal list: the agent claims every kind it serves
// in ONE `kinds=` list, so a single kind missing here — as generate_from_idea
// was after migration 0007 added it to the enum — makes every claim 400 and
// the agent never picks up a job of any kind.
const JobKind = z.enum(jobKind.enumValues);

const STALE_CLAIM_MS = 10 * 60 * 1000;
const MAX_WAIT_SECONDS = 25;
const POLL_INTERVAL_MS = 2000;

type ClaimedRow = { id: string; kind: string; payload: Record<string, unknown>; created_at: string };

/**
 * A job an agent claimed but never reported back on (crashed, lost network,
 * killed mid-run) would otherwise sit `claimed` forever. Anything still
 * `claimed` after 10 minutes is put back in the queue. This only touches
 * `status = 'claimed'` rows older than the cutoff — fresh claims and
 * anything already `done`/`failed` are left alone.
 */
async function requeueStaleClaims(): Promise<void> {
  await db
    .update(jobs)
    .set({ status: "queued", claimedAt: null })
    .where(and(eq(jobs.status, "claimed"), lt(jobs.claimedAt, new Date(Date.now() - STALE_CLAIM_MS))));
}

/**
 * Atomically claims the oldest queued job matching one of `kinds`.
 *
 * Why this has to be one statement: a SELECT to find the oldest queued job
 * followed by a separate UPDATE would let two concurrent claims (two agent
 * processes, or two long-poll ticks) both SELECT the same row before either
 * UPDATEs it, so both would believe they'd claimed it. Folding the SELECT
 * into the UPDATE's WHERE subquery makes Postgres pick-and-claim the row as
 * one atomic operation under the row lock the UPDATE already takes.
 * FOR UPDATE SKIP LOCKED then means a row some other concurrent claim
 * already has locked is skipped rather than blocked on, so this scales to
 * multiple agents polling at once instead of serializing them.
 *
 * The query builder can't express an UPDATE with a FOR UPDATE SKIP LOCKED
 * subquery, hence the raw `db.execute(sql\`...\`)`. Every kind value is
 * validated against the JobKind enum before it ever reaches this function
 * and is still passed through as a bound `sql` parameter (never string-
 * concatenated), so this is not a SQL-injection surface either way.
 *
 * Driver note (this app's `db` is neon-http in production and a PGlite
 * proxy in dev/tests — see @/db): both accept FOR UPDATE SKIP LOCKED, and
 * both resolve `db.execute(...)` to an object exposing the picked row(s) as
 * `.rows` (confirmed directly against the PGlite driver these tests run
 * against, and true of neon-http's `NeonHttpQueryResult` type by
 * construction) — so there's no `.rows`-vs-bare-array divergence to
 * normalize between them here.
 *
 * `claimed_at` is set from a JS-computed `Date`, not SQL `now()`. This
 * value is also handed back to the agent as `claimedAt` and doubles as a
 * claim-ownership token: the result endpoint (see
 * jobs/[id]/result/route.ts) requires the agent to echo it back and only
 * accepts a report whose row is still `claimed` with that exact
 * `claimed_at`, so a late report from a claim that's since been requeued
 * as stale (which nulls `claimed_at`) or re-claimed by someone else can
 * never attach itself to the wrong claim. That equality check is done via
 * the query builder's `eq(jobs.claimedAt, new Date(echoedIsoString))`,
 * which round-trips through a JS `Date` (millisecond precision) on the
 * agent's side. SQL `now()` has microsecond precision — a value written
 * with `now()`, echoed back through a JS `Date`, and compared again would
 * silently lose its sub-millisecond digits and never match, breaking every
 * result report. Binding the same millisecond-precision `Date` value for
 * both the write and the echo keeps the two sides exact.
 */
async function claimOne(kinds: string[]) {
  const claimedAt = new Date();
  const result = await db.execute<ClaimedRow>(sql`
    UPDATE jobs SET status = 'claimed', claimed_at = ${claimedAt}
    WHERE id = (
      SELECT id FROM jobs
      WHERE status = 'queued' AND kind IN (${sql.join(kinds.map((k) => sql`${k}`), sql`, `)})
      ORDER BY created_at ASC, id ASC
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    )
    RETURNING id, kind, payload, created_at
  `);

  const row = result.rows[0];
  if (!row) return null;
  return {
    id: row.id,
    kind: row.kind,
    payload: row.payload,
    createdAt: new Date(row.created_at).toISOString(),
    claimedAt: claimedAt.toISOString(),
  };
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
  });
}

/**
 * GET /api/agent/jobs?kinds=a,b&wait=N
 *
 * Long-polling claim endpoint: an agent asks for one job of the given
 * kind(s) and is willing to hold the connection open up to `wait` seconds
 * (clamped to [0, 25]) waiting for one to appear. wait=0 makes exactly one
 * claim attempt and returns immediately (204 if nothing's queued) — the
 * loop below always checks the deadline right after the first attempt, so
 * it never sleeps in that case. Holding a serverless invocation open for up
 * to 25s is intentional: that's the whole point of long-polling instead of
 * the agent hammering this endpoint every second.
 *
 * A caller that went away never gets a job claimed for it (live,
 * 2026-09-23): an agent restarted mid-long-poll left its request running
 * here, the request claimed the next job for a process that no longer
 * existed, and the job sat `claimed` until the 10-minute stale sweep. Next
 * aborts `request.signal` when the client's connection closes, so the loop
 * stops before each claim attempt (and wakes from its sleep) once it has.
 */
export async function GET(request: Request) {
  const denied = requireAgentToken(request);
  if (denied) return denied;

  const url = new URL(request.url);
  const kindsParam = url.searchParams.get("kinds");
  if (!kindsParam) return Response.json({ error: "bad request" }, { status: 400 });

  const kindsResult = z.array(JobKind).min(1).safeParse(kindsParam.split(",").map((k) => k.trim()));
  if (!kindsResult.success) return Response.json({ error: "bad request" }, { status: 400 });
  const kinds = kindsResult.data;

  const waitRaw = Number(url.searchParams.get("wait"));
  const waitSeconds = Number.isFinite(waitRaw) ? Math.min(Math.max(waitRaw, 0), MAX_WAIT_SECONDS) : 0;
  const deadline = Date.now() + waitSeconds * 1000;

  try {
    await requeueStaleClaims();

    for (;;) {
      if (request.signal.aborted) return new Response(null, { status: 499 });
      const job = await claimOne(kinds);
      if (job) return Response.json({ job });

      const remaining = deadline - Date.now();
      if (remaining <= 0) return new Response(null, { status: 204 });
      await sleep(Math.min(POLL_INTERVAL_MS, remaining), request.signal);
    }
  } catch (e) {
    console.error(e);
    return Response.json({ error: "internal error" }, { status: 500 });
  }
}
