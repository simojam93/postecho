import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { jobs } from "@/db/schema";
import { agentServes, UPDATE_AGENT_ERROR } from "@/lib/agent-kinds";
import { draftMediaSource } from "@/lib/draft-media";
import { jobCreated } from "@/lib/job-header";
import { MEDIA_KINDS, mediaOf } from "@/lib/media";
import { requireSession } from "@/lib/session";

const Body = z.object({ kind: z.enum(MEDIA_KINDS) }).strict();

const notFound = () => Response.json({ error: "not found" }, { status: 404 });

/** The draft's latest post_media job, or null. */
async function latestMediaJob(draftId: string) {
  const [job] = await db.select().from(jobs)
    .where(and(eq(jobs.kind, "post_media"), sql`${jobs.payload}->>'draftId' = ${draftId}`))
    .orderBy(desc(jobs.createdAt)).limit(1);
  return job ?? null;
}

/**
 * GET /api/drafts/:id/media (media from a repo, 2026-10-11)
 *
 * `{ kinds, media, job }`: the kinds the post's source allows (none for a post that isn't from a
 * repo), the draft's `meta.media`, and its latest post_media job (`{ id, status, result, createdAt,
 * payload: { kind } }`, or null) for Compose's steps.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const denied = await requireSession();
  if (denied) return denied;
  const { id } = await params;
  if (!z.uuid().safeParse(id).success) return notFound();

  try {
    const { draft, media } = await draftMediaSource(db, id);
    if (!draft) return notFound();
    const job = media ? await latestMediaJob(id) : null;
    return Response.json({
      kinds: media?.kinds ?? [],
      media: mediaOf(draft.meta),
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
 * POST /api/drafts/:id/media `{ kind: "images" | "card" | "screenshots" | "video" }`
 *
 * Asks the agent for one kind of media for a post from a repo: a `post_media` job with `{ draftId,
 * repoId, source, kind, postText, format }`. 400 for a post that isn't from a repo, or screenshots
 * and a video for a GitHub repository (they run its code: only the owner's own folders); 409 when
 * the agent's last heartbeat didn't list post_media, or a media job for this post is still running.
 * The agent refuses the folder-only kinds for GitHub on its own too.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const denied = await requireSession();
  if (denied) return denied;
  const { id } = await params;
  if (!z.uuid().safeParse(id).success) return notFound();
  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Pick images, a card, screenshots or a video." }, { status: 400 });
  const { kind } = parsed.data;

  try {
    const { draft, media } = await draftMediaSource(db, id);
    if (!draft) return notFound();
    if (!media) return Response.json({ error: "Media are made for posts from a repo." }, { status: 400 });
    if (!media.kinds.includes(kind)) {
      return Response.json({ error: "Screenshots and videos are made only from a folder on this computer." }, { status: 400 });
    }
    if (!(await agentServes("post_media"))) return Response.json({ error: UPDATE_AGENT_ERROR }, { status: 409 });
    const [running] = await db.select({ id: jobs.id }).from(jobs).where(and(
      eq(jobs.kind, "post_media"),
      inArray(jobs.status, ["queued", "claimed"]),
      sql`${jobs.payload}->>'draftId' = ${id}`,
    )).limit(1);
    if (running) return Response.json({ error: "PostEcho is already making media for this post." }, { status: 409 });

    const [job] = await db.insert(jobs).values({
      kind: "post_media",
      payload: { draftId: id, repoId: media.repoId, source: media.source, kind, postText: media.postText, format: media.format },
    }).returning();
    return jobCreated({ jobId: job.id }, job.id);
  } catch (e) {
    console.error(e);
    return Response.json({ error: "internal error" }, { status: 500 });
  }
}
