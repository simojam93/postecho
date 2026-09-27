import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { jobs } from "@/db/schema";
import { requireAgentToken } from "@/lib/agent-auth";
import { materialize } from "@/lib/materialize";

const Body = z.union([
  z.object({ ok: z.literal(true), result: z.record(z.string(), z.unknown()), claimedAt: z.string() }).strict(),
  z.object({ ok: z.literal(false), error: z.string(), claimedAt: z.string() }).strict(),
]);

/**
 * POST /api/agent/jobs/:id/result
 *
 * Reports the outcome of a previously-claimed job. The update is a single
 * conditional statement — `WHERE id = ... AND status = 'claimed' AND
 * claimed_at = ...` — so it both finds and finishes the job atomically:
 * there's no separate read to check status first (which would race against
 * a stale-claim requeue or a duplicate report), and neon-http has no
 * `.transaction()` to wrap one in anyway (see @/db). A job that isn't
 * currently `claimed` — already finished, or never claimed — simply
 * matches zero rows and reports 404.
 *
 * `claimedAt` is a required ownership echo, not just a timestamp: the
 * agent must send back exactly the `claimedAt` string it got from the
 * claim response (see claimOne in ../../route.ts), and the WHERE clause
 * only matches a row that is still `claimed` with that exact `claimed_at`.
 * Without this, a result posted after the 10-minute stale-claim sweep has
 * requeued the job (nulling `claimed_at`) and someone else has re-claimed
 * it would either match nothing (silently lost) or — worse — match the
 * NEW claim's row too, since both are `status = 'claimed'`, corrupting a
 * result the late reporter never actually produced. Requiring the exact
 * `claimed_at` back closes that: once a row is requeued or re-claimed, its
 * `claimed_at` no longer equals the stale echo, so the late report always
 * 404s instead of attaching to the wrong claim.
 *
 * An `{ ok: true }` report is not just recorded — it's materialized (see
 * @/lib/materialize) into drafts/settings BEFORE the job is flipped to
 * `done`: the same `claimCondition` WHERE clause first SELECTs the claimed
 * row (still required to be `claimed` with the exact echoed `claimed_at`,
 * for the reasons above) so materialize() has the job's `kind`/`payload` to
 * work with, then — still no `db.transaction()` on neon-http, see @/db —
 * a second statement flips it to `done`/`failed`. A crash between the two
 * leaves the job `claimed`; whenever it's next reported (the agent retries,
 * or the 10-minute stale sweep requeues it and a worker re-runs it), that
 * report's materialize() call is a safe no-op for anything already written,
 * because every kind that inserts a draft checks for one already tagged
 * with this `jobId` first. An invalid result shape (materialize() returns
 * `{ ok: false }`) marks the job `failed` with that error instead of `done`
 * — an agent bug, not a retry case — and responds 400.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const denied = requireAgentToken(request);
  if (denied) return denied;

  const { id } = await params;
  if (!z.uuid().safeParse(id).success) return Response.json({ error: "not found" }, { status: 404 });

  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "bad request" }, { status: 400 });

  const claimedAt = new Date(parsed.data.claimedAt);
  if (Number.isNaN(claimedAt.getTime())) return Response.json({ error: "bad request" }, { status: 400 });

  const claimCondition = and(eq(jobs.id, id), eq(jobs.status, "claimed"), eq(jobs.claimedAt, claimedAt));

  try {
    if (!parsed.data.ok) {
      const [job] = await db
        .update(jobs)
        .set({ status: "failed", result: { error: parsed.data.error }, finishedAt: new Date() })
        .where(claimCondition)
        .returning();
      if (!job) return Response.json({ error: "not found or not claimed" }, { status: 404 });
      return Response.json({ job });
    }

    const [claimedJob] = await db.select().from(jobs).where(claimCondition).limit(1);
    if (!claimedJob) return Response.json({ error: "not found or not claimed" }, { status: 404 });

    const outcome = await materialize(db, claimedJob, parsed.data.result);
    if (!outcome.ok) {
      await db
        .update(jobs)
        .set({ status: "failed", result: { error: outcome.error }, finishedAt: new Date() })
        .where(claimCondition);
      return Response.json({ error: outcome.error }, { status: 400 });
    }

    const [job] = await db
      .update(jobs)
      .set({ status: "done", result: parsed.data.result, finishedAt: new Date() })
      .where(claimCondition)
      .returning();
    if (!job) return Response.json({ error: "not found or not claimed" }, { status: 404 });
    return Response.json({ job });
  } catch (e) {
    console.error(e);
    return Response.json({ error: "internal error" }, { status: 500 });
  }
}
