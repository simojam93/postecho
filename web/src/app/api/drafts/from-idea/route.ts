import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { drafts, ideas, jobs } from "@/db/schema";
import { deepRead, deepReadPatch, needsDeepRead } from "@/lib/deep-read";
import { isVideoPost } from "@/lib/video-post";
import { voiceOfIdea } from "@/lib/voice";
import { withXAuthor } from "@/lib/x-handles";
import { requireSession } from "@/lib/session";
import { jobCreated } from "@/lib/job-header";

// The deep read below makes one or two bounded third-party requests (6 s
// each) before the job is enqueued; well under this, but above the default.
export const maxDuration = 30;

const Body = z.object({
  ideaId: z.uuid(),
  instructions: z.string().max(500).default(""),
  count: z.number().int().min(1).max(5).default(3),
}).strict();

/**
 * POST /api/drafts/from-idea
 *
 * The "Use" action on a Find Ideas card: enqueues a `generate_from_idea` job
 * for the agent (mirrors POST /api/videos's `generate_from_video` job, but
 * seeded from an idea instead of a fresh YouTube url) and marks the idea
 * `used` so it drops out of the "new" queue. `seedText`/`seedUrl` are
 * derived here from the idea row, not taken from the request body: the
 * caller only chooses *which* idea and how many/what instructions, same
 * division of responsibility as the videos route (client sends the url,
 * the route enriches/derives the rest).
 *
 * Deep read first (owner, 2026-09-23: "se lo uso mi prende solo il titolo?"
 * — it did, for any HN/Lobsters story linking to an article, and the agent
 * never opens URLs): when lib/deep-read.ts's `needsDeepRead` says the card
 * is thin, the linked article's extract and the discussion's highlights are
 * fetched now and become the job's `seedText`, with the article as
 * `seedUrl`. A card the scout already read (lib/scout-run.ts summarizes
 * Hacker News and Lobsters cards right after the pick) carries the full text
 * in `meta.deepReadText`, which is used as is. Either way the idea ends up
 * with the same columns (lib/deep-read.ts's deepReadPatch): "title —
 * summary" as content, the full text and links in meta, `meta.deepReadAt`
 * so nothing is read twice. A read that gathers nothing — or throws —
 * leaves today's title-plus-link seed.
 */
/**
 * A ready post from Video posts (lib/video-post.ts; owner, 2026-09-27: "non
 * penso servano i tre takes se ne ho già scelto uno"): it becomes the post's
 * chosen version as it is, with Jev's score from the card, and Write opens
 * on the editor. Once: a second Use finds the post already in Write.
 */
async function keepVideoPost(idea: typeof ideas.$inferSelect): Promise<void> {
  const [inWrite] = await db.select({ id: drafts.id }).from(drafts)
    .where(and(eq(drafts.ideaId, idea.id), inArray(drafts.status, ["kept", "candidate"]))).limit(1);
  if (!inWrite) {
    const text = idea.content ?? "";
    const aiStyle = idea.meta.aiStyle as { slopScore?: unknown; verdict?: unknown; at?: unknown } | undefined;
    const scored = typeof aiStyle?.slopScore === "number" && typeof aiStyle.verdict === "string";
    const at = typeof aiStyle?.at === "string" ? aiStyle.at : new Date().toISOString();
    await db.insert(drafts).values({
      ideaId: idea.id,
      xText: text,
      status: "kept",
      meta: {
        overLimit: text.length > 280,
        voice: voiceOfIdea(idea),
        // The shape lib/slop.ts's runSlopCheck persists, so the editor's badge needs no check.
        ...(scored ? {
          slop: { platform: "x", slopScore: aiStyle.slopScore, verdict: aiStyle.verdict, at },
          slopByPlatform: { x: { slopScore: aiStyle.slopScore, verdict: aiStyle.verdict, at } },
        } : {}),
      },
    });
  }
  await db.update(ideas).set({ status: "used" }).where(eq(ideas.id, idea.id));
}

/**
 * A post from a repo (2026-10-10, materialize.ts's materializeRepoPosts): like a video's ready
 * post, it becomes the post's chosen version as it is, without a job, in its format's columns: an
 * X post in xText, a LinkedIn post in linkedinText, an X article in articleTitle and articleText.
 * Once: a second Use finds the post already in Write.
 */
async function keepRepoPost(idea: typeof ideas.$inferSelect): Promise<void> {
  const [inWrite] = await db.select({ id: drafts.id }).from(drafts)
    .where(and(eq(drafts.ideaId, idea.id), inArray(drafts.status, ["kept", "candidate"]))).limit(1);
  if (!inWrite) {
    const text = idea.content ?? "";
    const format = idea.meta.format;
    const title = typeof idea.meta.title === "string" ? idea.meta.title : idea.title ?? "";
    const columns = format === "article"
      ? { articleTitle: title, articleText: text }
      : format === "linkedin"
        ? { linkedinText: text }
        : { xText: text };
    await db.insert(drafts).values({
      ideaId: idea.id,
      ...columns,
      status: "kept",
      meta: { voice: voiceOfIdea(idea), ...(format === "x" ? { overLimit: text.length > 280 } : {}) },
    });
  }
  await db.update(ideas).set({ status: "used" }).where(eq(ideas.id, idea.id));
}

/**
 * The whole text the agent read for a Videos topic (the cards before the
 * ready posts): its video_ideas job keeps it (result.text, which api/jobs
 * never sends to the page). Null for a topic from before 2026-09-27, whose
 * meta.deepReadText still carries its passage.
 */
async function videoTextOf(idea: typeof ideas.$inferSelect): Promise<{ text: string; url: string } | null> {
  const jobId = idea.meta.jobId;
  const url = idea.meta.articleUrl;
  if (typeof jobId !== "string" || typeof url !== "string" || !z.uuid().safeParse(jobId).success) return null;
  const [job] = await db.select({ result: jobs.result }).from(jobs).where(eq(jobs.id, jobId)).limit(1);
  const text = job?.result?.text;
  return typeof text === "string" && text.trim() ? { text, url } : null;
}

export async function POST(request: Request) {
  const denied = await requireSession();
  if (denied) return denied;

  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "bad request" }, { status: 400 });

  try {
    const [idea] = await db.select().from(ideas).where(eq(ideas.id, parsed.data.ideaId)).limit(1);
    if (!idea) return Response.json({ error: "not found" }, { status: 404 });

    if (isVideoPost(idea) && idea.content?.trim()) {
      await keepVideoPost(idea);
      return Response.json({ read: [] }, { status: 201 });
    }

    if (idea.kind === "repo_post" && idea.content?.trim()) {
      await keepRepoPost(idea);
      return Response.json({ read: [] }, { status: 201 });
    }

    // A YouTube card writes from the video's transcript, as the card's old
    // "Generate posts" panel did (owner, 2026-09-24: "non capisco questo
    // generate posts… tanto con use poi vado nella parte di write") — not
    // from its title. Same job POST /api/videos enqueues, with the post's voice.
    const fromVideo = idea.kind === "video_idea" ? await videoTextOf(idea) : null;
    if (fromVideo) {
      // A topic from Videos (2026-09-27: "nel rewrite dei tasks si riprende sempre tutto
      // lo script e lo si ripensa per X e LinkedIn"): the takes are written from the whole
      // video the agent read, about this topic, as a reaction to it unless switched.
      const [job] = await db.insert(jobs).values({
        kind: "generate_from_video",
        payload: {
          ideaId: idea.id,
          url: fromVideo.url,
          transcript: fromVideo.text,
          topic: { title: idea.title ?? "", summary: idea.content ?? "" },
          instructions: parsed.data.instructions,
          count: parsed.data.count,
          originalLanguage: false,
          voice: voiceOfIdea(idea),
        },
      }).returning();
      await db.update(ideas).set({ status: "used" }).where(eq(ideas.id, idea.id));
      return jobCreated({ job, read: [] }, job.id);
    }

    if (idea.kind === "youtube" && idea.url) {
      const [job] = await db.insert(jobs).values({
        kind: "generate_from_video",
        payload: {
          ideaId: idea.id,
          url: idea.url,
          instructions: parsed.data.instructions,
          count: parsed.data.count,
          originalLanguage: false,
          voice: voiceOfIdea(idea),
        },
      }).returning();
      await db.update(ideas).set({ status: "used" }).where(eq(ideas.id, idea.id));
      return jobCreated({ job, read: [] }, job.id);
    }

    const stored = {
      text: typeof idea.meta.deepReadText === "string" ? idea.meta.deepReadText : null,
      articleUrl: typeof idea.meta.articleUrl === "string" ? idea.meta.articleUrl : null,
      discussionUrl: typeof idea.meta.discussionUrl === "string" ? idea.meta.discussionUrl : null,
      parts: Array.isArray(idea.meta.deepReadParts) ? idea.meta.deepReadParts : [],
    };
    const read = stored.text === null && needsDeepRead(idea)
      ? await deepRead(idea).catch((e: unknown) => {
          console.error("deep read failed:", e);
          return null;
        })
      : null;
    if (read?.notes.length) console.warn("deep read, partial:", read.notes.join("; "));

    // An X post names its author's @handle, so Claude's tag for them is exact (lib/x-handles.ts).
    const seedText = withXAuthor(stored.text ?? read?.text ?? idea.content ?? idea.title ?? idea.url ?? "", idea);
    const [job] = await db.insert(jobs).values({
      kind: "generate_from_idea",
      payload: {
        ideaId: idea.id,
        seedText,
        seedUrl: stored.articleUrl ?? read?.articleUrl ?? idea.url,
        discussionUrl: stored.discussionUrl ?? read?.discussionUrl ?? null,
        // The post's voice (lib/voice.ts): the one chosen in Write, else the
        // owner's own note is written as theirs and anything else as a
        // reaction. `ownText` stays for agents that predate `voice`.
        voice: voiceOfIdea(idea),
        ownText: voiceOfIdea(idea) === "mine",
        instructions: parsed.data.instructions,
        count: parsed.data.count,
      },
    }).returning();

    await db
      .update(ideas)
      .set(read ? { status: "used", ...deepReadPatch(idea, read) } : { status: "used" })
      .where(eq(ideas.id, idea.id));

    return jobCreated({ job, read: read?.parts ?? stored.parts }, job.id);
  } catch (e) {
    console.error(e);
    return Response.json({ error: "internal error" }, { status: 500 });
  }
}
