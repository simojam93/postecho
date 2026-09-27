import { eq, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { ideas, jobs } from "@/db/schema";
import { serviceEnv } from "@/lib/connections";
import { enrich } from "@/lib/enrich";
import { videoDescriptionFor } from "@/lib/sources/youtube";
import { requireSession } from "@/lib/session";

/** Post ideas per video: six shown, six behind Show more (owner, 2026-09-27: "at least 6 best and 6 more"). */
export const VIDEO_IDEAS_COUNT = 12;

const Body = z.object({
  url: z.url(),
  // Pasted by hand when the Mac couldn't fetch the transcript (the section's fallback).
  transcript: z.string().max(200_000).optional(),
});

/**
 * Videos: a pasted YouTube link becomes the video's card (kind youtube,
 * source manual, deduped by url) and a video_ideas job — the Mac agent reads
 * the whole transcript and writes VIDEO_IDEAS_COUNT post ideas, best first,
 * which materialize.ts saves as video_idea rows under the video. It replaces
 * the search the Videos box used to run on the title's words (owner,
 * 2026-09-27: "this is completely wrong, it should take all the script of the
 * video and create some post ideas that I can use").
 */
export async function POST(request: Request) {
  const denied = await requireSession();
  if (denied) return denied;

  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Paste a YouTube link." }, { status: 400 });
  const { url, transcript } = parsed.data;

  try {
    const e = await enrich(url);
    if (e.kind !== "youtube") return Response.json({ error: "Paste a YouTube link." }, { status: 400 });

    // When it was pasted last: the Videos chips go newest first, and the latest is the one selected.
    const pastedAt = new Date().toISOString();
    const [inserted] = await db.insert(ideas).values({ url, kind: "youtube", title: e.title, author: e.author, meta: { ...e.meta, pastedAt } })
      // ideas_url_unique is a partial index (WHERE url IS NOT NULL): the matching `where` lets Postgres use it here.
      .onConflictDoNothing({ target: ideas.url, where: sql`${ideas.url} is not null` })
      .returning();
    let video = inserted ?? (await db.select().from(ideas).where(eq(ideas.url, url)).limit(1))[0];
    // Pasted again, or found by a search before: it's a video of the Videos tab now.
    if (!inserted) {
      [video] = await db.update(ideas).set({ status: "new", source: "manual", meta: { ...video.meta, pastedAt } }).where(eq(ideas.id, video.id)).returning();
    }

    // The description goes along: the Mac falls back on it when YouTube has no transcript at all.
    const description = transcript ? null : await videoDescriptionFor(url, (await serviceEnv(db, process.env)).YOUTUBE_API_KEY, fetch);
    const [job] = await db.insert(jobs).values({
      kind: "video_ideas",
      payload: {
        ideaId: video.id, url, title: video.title, count: VIDEO_IDEAS_COUNT, originalLanguage: false,
        ...(transcript ? { transcript } : {}),
        ...(description ? { description } : {}),
      },
    }).returning();
    return Response.json({ idea: video, job }, { status: 201 });
  } catch (err) {
    console.error(err);
    return Response.json({ error: "internal error" }, { status: 500 });
  }
}
