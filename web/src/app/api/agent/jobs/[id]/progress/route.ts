import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { jobs } from "@/db/schema";
import { requireAgentToken } from "@/lib/agent-auth";

const Body = z.object({
  claimedAt: z.string(),
  progress: z.record(z.string(), z.unknown()),
}).strict();

// A humanize progress report is a few hundred bytes; anything far bigger is a bug, not progress.
const MAX_PROGRESS_CHARS = 8000;

/**
 * POST /api/agent/jobs/:id/progress
 *
 * Live progress for a claimed job (M3.6: which Claude <-> Jev round a
 * Humanize is on), stored as the job's `result` — `{ progress }` — while it
 * is still `claimed`, so the page polling GET /api/jobs?id= can show it; the
 * final report (POST …/result) replaces it. Same ownership rule as the
 * result route: only the claim with this exact `claimedAt` may write, so a
 * late report from a claim the stale sweep already requeued matches nothing
 * (404) instead of overwriting a newer claim's progress.
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
  if (JSON.stringify(parsed.data.progress).length > MAX_PROGRESS_CHARS) {
    return Response.json({ error: "progress too large" }, { status: 413 });
  }

  const claimedAt = new Date(parsed.data.claimedAt);
  if (Number.isNaN(claimedAt.getTime())) return Response.json({ error: "bad request" }, { status: 400 });

  try {
    const [job] = await db
      .update(jobs)
      .set({ result: { progress: parsed.data.progress } })
      .where(and(eq(jobs.id, id), eq(jobs.status, "claimed"), eq(jobs.claimedAt, claimedAt)))
      .returning({ id: jobs.id });
    if (!job) return Response.json({ error: "not found or not claimed" }, { status: 404 });
    return Response.json({ ok: true });
  } catch (e) {
    console.error(e);
    return Response.json({ error: "internal error" }, { status: 500 });
  }
}
