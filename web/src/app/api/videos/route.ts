import { eq, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { ideas, jobs } from "@/db/schema";
import { enrich } from "@/lib/enrich";
import { requireSession } from "@/lib/session";

const Body = z.object({
  url: z.url(),
  instructions: z.string().max(1000).default(""),
  // Three, like every post's takes (lib/takes.ts's MAX_TAKES, 2026-09-24).
  count: z.number().int().min(1).max(25).default(3),
  originalLanguage: z.boolean().default(false),
  // Manual transcript fallback (M2 plan task A9): when a video's transcript
  // fetch fails, the Videos card shows a "paste the transcript" textarea
  // that re-POSTs here with this field set — the agent (handlers.ts) skips
  // fetching and runs this verbatim (through the same normalizeTranscript
  // cap as a fetched one) instead.
  transcript: z.string().max(200_000).optional(),
});

export async function POST(request: Request) {
  const denied = await requireSession();
  if (denied) return denied;

  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "bad request" }, { status: 400 });

  const e = await enrich(parsed.data.url);
  if (e.kind !== "youtube") return Response.json({ error: "not a youtube url" }, { status: 400 });

  try {
    const [inserted] = await db.insert(ideas).values({
      url: parsed.data.url, kind: "youtube", title: e.title, author: e.author, meta: e.meta,
    })
      // Resubmitting the same video is intentional — it should still enqueue
      // a fresh generate_from_video job below — but the idea row stays
      // deduped by url via ideas_url_unique (partial unique index, WHERE url
      // IS NOT NULL). The matching `where` here is required for Postgres to
      // use a partial index as the ON CONFLICT arbiter, or every insert (not
      // just duplicates) would fail to find one.
      .onConflictDoNothing({ target: ideas.url, where: sql`${ideas.url} is not null` })
      .returning();

    const existingIdea = !inserted;
    const idea = inserted ?? (await db.select().from(ideas).where(eq(ideas.url, parsed.data.url)).limit(1))[0];

    try {
      const [job] = await db.insert(jobs).values({
        kind: "generate_from_video",
        payload: {
          ideaId: idea.id, url: parsed.data.url, instructions: parsed.data.instructions,
          count: parsed.data.count, originalLanguage: parsed.data.originalLanguage,
          transcript: parsed.data.transcript,
        },
      }).returning();

      return Response.json(existingIdea ? { idea, job, existingIdea: true } : { idea, job }, { status: 201 });
    } catch (e) {
      console.error(e);
      // neon-http has no `.transaction()` (see src/db/index.ts), so this two-step
      // write can't roll back atomically: a job-insert failure would otherwise
      // leave an orphaned youtube idea that the job pipeline never picks up.
      // Best-effort clean it up instead of leaving it dangling — but only the
      // row this request actually created: a deduped (existingIdea) row
      // predates this request and must not be deleted out from under it.
      if (!existingIdea) {
        await db.delete(ideas).where(eq(ideas.id, idea.id)).catch(() => {});
      }
      return Response.json({ error: "failed to enqueue job" }, { status: 500 });
    }
  } catch (e) {
    console.error(e);
    return Response.json({ error: "internal error" }, { status: 500 });
  }
}
