import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { jobs } from "@/db/schema";
import { agentServes, UPDATE_AGENT_ERROR } from "@/lib/agent-kinds";
import { draftMediaSource } from "@/lib/draft-media";
import { jobCreated } from "@/lib/job-header";
import { MEDIA_KINDS, mediaOf, type MediaKind } from "@/lib/media";
import { requireSession } from "@/lib/session";

const Body = z.object({ kind: z.enum(MEDIA_KINDS) }).strict();

const notFound = () => Response.json({ error: "not found" }, { status: 404 });

/** Why the post can't have that kind. */
function refusal(kind: MediaKind, fromRepo: boolean): string {
  if (kind === "source_image") return "This post's source has no image.";
  if (!fromRepo) return "This kind of media comes from a post's repo.";
  return "Screenshots and videos are made only from a folder on this computer.";
}

/** The draft's latest post_media job, or null. */
async function latestMediaJob(draftId: string) {
  const [job] = await db.select().from(jobs)
    .where(and(eq(jobs.kind, "post_media"), sql`${jobs.payload}->>'draftId' = ${draftId}`))
    .orderBy(desc(jobs.createdAt)).limit(1);
  return job ?? null;
}

/**
 * GET /api/drafts/:id/media (media from a repo, 2026-10-11; every post since)
 *
 * `{ kinds, media, job }`: the kinds the post's source allows (a card at least), the draft's
 * `meta.media`, and its latest post_media job (`{ id, status, result, createdAt, payload: { kind } }`,
 * or null) for Compose's steps.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const denied = await requireSession();
  if (denied) return denied;
  const { id } = await params;
  if (!z.uuid().safeParse(id).success) return notFound();

  try {
    const media = await draftMediaSource(db, id);
    if (!media) return notFound();
    const job = await latestMediaJob(id);
    return Response.json({
      kinds: media.kinds,
      media: mediaOf(media.draft.meta),
      job: job && {
        id: job.id, status: job.status, result: job.result, createdAt: job.createdAt,
        payload: { kind: (job.payload as { kind?: unknown }).kind ?? null },
      },
    });
  } catch (e) {
    console.error(e);
    return Response.json({ error: "internal error" }, { status: 500 });
  }
}

/**
 * POST /api/drafts/:id/media `{ kind: "images" | "card" | "screenshots" | "video" | "source_image" }`
 *
 * Asks the agent for one kind of media for a post: a `post_media` job with `{ draftId, kind, postText,
 * format }`, plus `repoId` and `source` for a post from a repo, `sourceName` (the card's footer and the
 * image's credit) for any other, and `imageUrl` for the source's image. 400 for a kind the post's
 * source can't give: images, screenshots and a video without a repo, screenshots and a video for a
 * GitHub repository (they run its code: only the owner's own folders), the source's image without one.
 * 409 when the agent's last heartbeat didn't list post_media, or a media job for this post is still
 * running. The agent refuses the folder-only kinds for GitHub on its own too.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const denied = await requireSession();
  if (denied) return denied;
  const { id } = await params;
  if (!z.uuid().safeParse(id).success) return notFound();
  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Pick a kind of media from the menu." }, { status: 400 });
  const { kind } = parsed.data;

  try {
    const media = await draftMediaSource(db, id);
    if (!media) return notFound();
    if (!media.kinds.includes(kind)) return Response.json({ error: refusal(kind, media.repo !== null) }, { status: 400 });
    if (!(await agentServes("post_media"))) return Response.json({ error: UPDATE_AGENT_ERROR }, { status: 409 });
    const [running] = await db.select({ id: jobs.id }).from(jobs).where(and(
      eq(jobs.kind, "post_media"),
      inArray(jobs.status, ["queued", "claimed"]),
      sql`${jobs.payload}->>'draftId' = ${id}`,
    )).limit(1);
    if (running) return Response.json({ error: "PostEcho is already making media for this post." }, { status: 409 });

    const [job] = await db.insert(jobs).values({
      kind: "post_media",
      payload: {
        draftId: id,
        ...(media.repo ? { repoId: media.repo.id, source: media.repo.source } : {}),
        kind,
        postText: media.postText,
        format: media.format,
        ...(media.sourceName ? { sourceName: media.sourceName } : {}),
        ...(kind === "source_image" ? { imageUrl: media.imageUrl } : {}),
      },
    }).returning();
    return jobCreated({ jobId: job.id }, job.id);
  } catch (e) {
    console.error(e);
    return Response.json({ error: "internal error" }, { status: 500 });
  }
}
