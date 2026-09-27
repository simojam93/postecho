import { and, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { drafts, ideas } from "@/db/schema";
import { getSetting, setSetting } from "@/lib/settings";
import { keptTakes } from "@/lib/takes";
import { VIDEO_POST_FORMAT } from "@/lib/video-post";
import { rankVideoPosts } from "@/lib/video-posts";
import type { db as Db } from "@/db";

/**
 * The subset of a `jobs` row materialize() needs: enough to know what kind
 * of result this is and which idea/draft it's about (via `payload`), without
 * requiring callers to pass the full drizzle-inferred row type. The result
 * route (see jobs/[id]/result/route.ts) passes the row it just SELECTed;
 * tests pass a plain literal.
 */
export type MaterializeJob = {
  id: string;
  kind: string;
  payload: Record<string, unknown>;
};

export type MaterializeOutcome = { ok: true } | { ok: false; error: string };

const INVALID_SHAPE_ERROR = "invalid result for kind";

/**
 * One candidate/revised post. `xText`/`linkedinText` are both optional at
 * the zod level (an agent may only produce one platform's text), but at
 * least one must be present — a draft with neither is meaningless. Caps
 * mirror the drafts columns' intended limits (X's hard 280-char post limit,
 * with slack to 400 so an over-limit draft can still be saved and flagged
 * via meta.overLimit rather than rejected outright; LinkedIn's long-form
 * ceiling at 4000).
 */
/** Jev's verdict on a text (jev-judge's checkSlop, as the agent reports it). */
const JevVerdict = z.object({ slopScore: z.number().min(0).max(100), verdict: z.string().max(40) });

const DraftItem = z.object({
  xText: z.string().max(400).optional(),
  linkedinText: z.string().max(4000).optional(),
  // Jev's verdict on the take (agent/src/handlers.ts's pickBestTakes, which
  // keeps the most human of a few more than asked): stored like any check,
  // so the card's badge needs none and the best three can be picked at once.
  slop: JevVerdict.extend({ platform: z.enum(["x", "linkedin"]) }).strict().optional(),
}).refine((d) => Boolean(d.xText || d.linkedinText), {
  message: "each draft needs xText or linkedinText",
});

const DraftsResult = z.object({
  drafts: z.array(DraftItem).min(1).max(25),
}).strict();

/** The rounds of the agent's Claude <-> Jev humanize loop (agent/src/handlers.ts's humanizeLoop). */
const HumanizeRounds = z.array(z.object({
  round: z.number().int().min(1).max(10),
  slopScore: z.number().min(0).max(100).nullable(),
  verdict: z.string().max(40).nullable(),
}).strict()).max(10);

const ReviseResult = z.object({
  xText: z.string().max(400).optional(),
  linkedinText: z.string().max(4000).optional(),
  // Write's Humanize (M3.6, a revise_draft in humanize mode): the loop's
  // rounds, and Jev's verdict on the text it returned — stored on the
  // revision as meta.humanize / meta.slop, so its badge needs no second check.
  humanize: z.object({ rounds: HumanizeRounds }).strict().optional(),
  slop: JevVerdict.extend({ platform: z.enum(["x", "linkedin"]) }).strict().optional(),
  // Edit with Claude (M3.7): Jev's verdict per platform the reply changed,
  // and a two-platform Humanize's rounds per platform.
  slopByPlatform: z.object({ x: JevVerdict.strict().optional(), linkedin: JevVerdict.strict().optional() }).strict().optional(),
  rounds: z.object({ x: HumanizeRounds.optional(), linkedin: HumanizeRounds.optional() }).strict().optional(),
}).strict().refine((d) => Boolean(d.xText || d.linkedinText), {
  message: "revision needs xText or linkedinText",
});

const ImagePromptResult = z.object({ imagePrompt: z.string().max(2000) }).strict();

const StyleGuideResult = z.object({ styleGuide: z.string().max(20000) }).strict();

/** learn_style: Claude's update to the style guide (jev-judge's GUIDE_UPDATE_SCHEMA), one line per change with its reason. */
const StyleUpdateResult = z.object({
  guide: z.string().min(1).max(20000),
  changes: z.array(z.object({ summary: z.string().min(1).max(200), reason: z.string().min(1).max(300) }).strict()).max(10),
}).strict();

/** The lessons a learn_style job carried (jev-judge's StyleLesson), shown with the proposal as its evidence. */
const JobLessons = z.array(z.object({
  trait: z.string().max(40),
  value: z.string().max(40),
  direction: z.enum(["more", "less"]),
  lift: z.number(),
  text: z.string().max(300),
})).max(10).catch([]);

/**
 * "Have drafts for this jobId already been materialized?" — the idempotency
 * check shared by every kind that inserts a draft (generate_from_video,
 * generate_from_idea, revise_draft). See the `jobId` column comment in
 * db/schema.ts: a retried/duplicate result POST (e.g. after a crash between
 * materialize and the job being flipped to `done` — see the result route's
 * ordering note) must not double-insert drafts.
 */
async function draftsAlreadyMaterialized(db: typeof Db, jobId: string): Promise<boolean> {
  const rows = await db.select({ id: drafts.id }).from(drafts).where(eq(drafts.jobId, jobId)).limit(1);
  return rows.length > 0;
}

/**
 * Resolves `payload.ideaId` to a real idea id, or `null` — tolerating both a
 * missing ideaId (not every generation job has a seed idea) and a stale/
 * unknown one (the idea was deleted, or the id is otherwise bogus) without
 * ever attempting an insert that would violate drafts.ideaId's foreign key.
 */
async function resolveIdeaId(db: typeof Db, payload: Record<string, unknown>): Promise<string | null> {
  const candidate = payload.ideaId;
  if (typeof candidate !== "string") return null;
  const [idea] = await db.select({ id: ideas.id }).from(ideas).where(eq(ideas.id, candidate)).limit(1);
  return idea ? idea.id : null;
}

async function materializeGeneratedDrafts(
  db: typeof Db,
  job: MaterializeJob,
  result: unknown,
): Promise<MaterializeOutcome> {
  const parsed = DraftsResult.safeParse(result);
  if (!parsed.success) return { ok: false, error: INVALID_SHAPE_ERROR };

  if (await draftsAlreadyMaterialized(db, job.id)) return { ok: true };

  const ideaId = await resolveIdeaId(db, job.payload);
  const at = new Date().toISOString();

  await db.insert(drafts).values(
    parsed.data.drafts.map((d) => ({
      ideaId,
      xText: d.xText ?? null,
      linkedinText: d.linkedinText ?? null,
      status: "candidate" as const,
      jobId: job.id,
      meta: {
        // Only X has a hard length limit; a linkedin-only draft (no xText)
        // has nothing to be over-limit about.
        overLimit: (d.xText?.length ?? 0) > 280,
        // Both texts were written together: LinkedIn is in step with this X
        // (Write's "Update LinkedIn from X" lights up once X moves on).
        ...(d.xText && d.linkedinText ? { xAtLinkedin: d.xText } : {}),
        ...(voiceOf(job.payload) ? { voice: voiceOf(job.payload) } : {}),
        // The shape lib/slop.ts's runSlopCheck persists.
        ...(d.slop ? {
          slop: { ...d.slop, at },
          slopByPlatform: { [d.slop.platform]: { slopScore: d.slop.slopScore, verdict: d.slop.verdict, at } },
        } : {}),
      },
    })),
  );
  if (ideaId) await keepBestTakes(db, ideaId);
  return { ok: true };
}

/**
 * At most three takes per post, the most human (lib/takes.ts): once new takes
 * land, every candidate/kept version of the takes that didn't make it is
 * discarded, in one UPDATE. The chosen take (the newest kept draft, the rule
 * lib/drafts.ts and the Write page use) always stays; used drafts (scheduled
 * or published) are never touched.
 */
async function keepBestTakes(db: typeof Db, ideaId: string): Promise<void> {
  const rows = await db.select().from(drafts).where(eq(drafts.ideaId, ideaId));
  const chosen = rows
    .filter((d) => d.status === "kept")
    .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime() || b.createdAt.getTime() - a.createdAt.getTime() || b.id.localeCompare(a.id))[0];
  const { drop } = keptTakes(rows, chosen?.id ?? null);
  const ids = drop.flatMap((line) => line.drafts.map((d) => d.id));
  // Marked, so learning from the owner's choices (lib/style-learning.ts) tells PostEcho's drop from theirs.
  if (ids.length > 0) {
    await db.update(drafts).set({ status: "discarded", meta: sql`${drafts.meta} || '{"trimmed": true}'::jsonb` }).where(inArray(drafts.id, ids));
  }
}

/** A parent version's persisted score for one platform: its own entry, else its single meta.slop when that was for this platform. */
function parentScore(meta: Record<string, unknown>, platform: "x" | "linkedin"): { slopScore: number; verdict: string; at: string } | null {
  const own = (meta.slopByPlatform as Record<string, { slopScore?: unknown; verdict?: unknown; at?: unknown } | undefined> | undefined)?.[platform];
  const single = meta.slop as { platform?: unknown; slopScore?: unknown; verdict?: unknown; at?: unknown } | undefined;
  const source = own ?? (single?.platform === platform ? single : undefined);
  if (!source || typeof source.slopScore !== "number" || typeof source.verdict !== "string") return null;
  return { slopScore: source.slopScore, verdict: source.verdict, at: typeof source.at === "string" ? source.at : new Date().toISOString() };
}

/** The post's voice a generation or edit job was run with (Write's voice switch, M3.7), when it names one. */
function voiceOf(payload: Record<string, unknown>): "mine" | "reaction" | null {
  const voice = payload.voice;
  return voice === "mine" || voice === "reaction" ? voice : null;
}

async function materializeRevision(
  db: typeof Db,
  job: MaterializeJob,
  result: unknown,
): Promise<MaterializeOutcome> {
  const parsed = ReviseResult.safeParse(result);
  if (!parsed.success) return { ok: false, error: INVALID_SHAPE_ERROR };

  if (await draftsAlreadyMaterialized(db, job.id)) return { ok: true };

  const draftId = job.payload.draftId;
  if (typeof draftId !== "string") return { ok: false, error: INVALID_SHAPE_ERROR };

  const [parent] = await db.select().from(drafts).where(eq(drafts.id, draftId)).limit(1);
  if (!parent) return { ok: false, error: "parent draft not found" };

  // A revision returns only the platform(s) it changed; the other one is
  // carried over from the version it revises, here, so a Refine or an edit
  // never loses a platform (it used to be patched on by the page, which only
  // happened while the page stayed open).
  const xText = parsed.data.xText ?? parent.xText;
  const linkedinText = parsed.data.linkedinText ?? parent.linkedinText;

  // Jev's verdicts, per platform, in the shape lib/slop.ts's runSlopCheck
  // persists; meta.slop keeps one of them (X first) for the readers that
  // take a single score (the takes row).
  const at = new Date().toISOString();
  const byPlatform: Record<string, { slopScore: number; verdict: string; at: string }> = {};
  if (parsed.data.slop) {
    const { platform, ...verdict } = parsed.data.slop;
    byPlatform[platform] = { ...verdict, at };
  }
  for (const [platform, verdict] of Object.entries(parsed.data.slopByPlatform ?? {})) {
    if (verdict) byPlatform[platform] = { ...verdict, at };
  }
  // The platform a revision didn't touch keeps its score: the text is the
  // same (owner, 2026-09-24: Humanize one platform, "magari uno dei due è già
  // a posto" — the other one's badge shouldn't vanish).
  for (const platform of ["x", "linkedin"] as const) {
    const changed = (platform === "x" ? parsed.data.xText : parsed.data.linkedinText) !== undefined;
    if (changed || byPlatform[platform]) continue;
    const carried = parentScore(parent.meta, platform);
    if (carried) byPlatform[platform] = carried;
  }
  const meta: Record<string, unknown> = {};
  if (Object.keys(byPlatform).length > 0) {
    const primary = byPlatform.x ? "x" : "linkedin";
    meta.slopByPlatform = byPlatform;
    meta.slop = { platform: primary, ...byPlatform[primary] };
  }
  if (parsed.data.humanize) meta.humanize = parsed.data.humanize;
  if (parsed.data.rounds) meta.rounds = parsed.data.rounds;

  // Edit with Claude (M3.7): what the owner asked for — the thread shows it
  // above the version it produced — and how.
  const label = typeof job.payload.label === "string" && job.payload.label.trim() ? job.payload.label : job.payload.instruction;
  if (typeof label === "string" && typeof job.payload.mode === "string") meta.instruction = label;
  if (typeof job.payload.mode === "string") meta.mode = job.payload.mode;
  const voice = voiceOf(job.payload) ?? (parent.meta.voice === "mine" || parent.meta.voice === "reaction" ? parent.meta.voice : null);
  if (voice) meta.voice = voice;
  // LinkedIn is in step with the X it was (re)written against.
  if (parsed.data.linkedinText !== undefined && xText) meta.xAtLinkedin = xText;
  else if (typeof parent.meta.xAtLinkedin === "string") meta.xAtLinkedin = parent.meta.xAtLinkedin;

  await db.insert(drafts).values({
    parentId: parent.id,
    ideaId: parent.ideaId,
    xText,
    linkedinText,
    status: "kept",
    jobId: job.id,
    meta,
  });
  return { ok: true };
}

async function materializeImagePrompt(
  db: typeof Db,
  job: MaterializeJob,
  result: unknown,
): Promise<MaterializeOutcome> {
  const parsed = ImagePromptResult.safeParse(result);
  if (!parsed.success) return { ok: false, error: INVALID_SHAPE_ERROR };

  const draftId = job.payload.draftId;
  if (typeof draftId !== "string") return { ok: false, error: INVALID_SHAPE_ERROR };

  // A no-op if the draft is gone by the time the result lands — tolerated
  // the same way an unknown ideaId is above, rather than failing the job.
  await db.update(drafts).set({ imagePrompt: parsed.data.imagePrompt }).where(eq(drafts.id, draftId));
  return { ok: true };
}

async function materializeStyleGuide(db: typeof Db, result: unknown): Promise<MaterializeOutcome> {
  const parsed = StyleGuideResult.safeParse(result);
  if (!parsed.success) return { ok: false, error: INVALID_SHAPE_ERROR };

  await setSetting(db as never, "styleGuide", parsed.data.styleGuide);
  // Settings compares it with the style inspiration list ("N added since the last analysis").
  await setSetting(db as never, "styleGuideAnalyzedAt", new Date().toISOString());
  return { ok: true };
}

/**
 * learn_style (lib/style-learning.ts): Claude's change to the style guide
 * waits as a proposal in Settings › Voice, with its reasons and the lessons
 * behind it; the guide itself changes only when the owner applies it. No
 * change is an answer too: then there's nothing to propose.
 */
async function materializeStyleProposal(db: typeof Db, job: MaterializeJob, result: unknown): Promise<MaterializeOutcome> {
  const parsed = StyleUpdateResult.safeParse(result);
  if (!parsed.success) return { ok: false, error: INVALID_SHAPE_ERROR };
  const guide = parsed.data.guide.trim();
  const current = await getSetting(db as never, "styleGuide");
  if (parsed.data.changes.length === 0 || guide === current.trim()) return { ok: true };
  const basedOn = job.payload.basedOn;
  await setSetting(db as never, "styleProposal", {
    guide,
    changes: parsed.data.changes,
    lessons: JobLessons.parse(job.payload.lessons),
    basedOn: typeof basedOn === "number" && Number.isInteger(basedOn) && basedOn > 0 ? basedOn : 0,
    createdAt: new Date().toISOString(),
  });
  return { ok: true };
}

/** A video's ready X posts (agent/src/handlers.ts's handleVideoIdeas), each with Jev's verdict when it checked. */
const VideoIdeasResult = z.object({
  posts: z.array(z.object({
    xText: z.string().trim().min(1).max(400),
    slop: JevVerdict.extend({ platform: z.enum(["x", "linkedin"]) }).strict().optional(),
  })).min(1).max(25),
  // "description" when YouTube had no transcript and the agent read the description instead.
  source: z.enum(["transcript", "description"]).optional(),
  // What the agent read (the whole transcript, else the description): it stays on the job for Use.
  text: z.string().max(80_000).optional(),
});

/**
 * video_ideas (2026-09-27, owner: "post X pronti all'attacco senza titolo,
 * 6+6 vanno bene"): the posts become video_idea rows under their video, in
 * Claude's order (meta.order), marked meta.format "post" (lib/video-post.ts)
 * with Jev's verdict as meta.aiStyle, then ranked with Jev's ✦. Use makes
 * one the post's version as it is (POST /api/drafts/from-idea). The text the
 * agent read stays on the job (result.text, never sent to the browser:
 * api/jobs). A second batch for the same video (asked again) archives the
 * posts still unreviewed; Liked ones stay. Once per job.
 */
async function materializeVideoIdeas(db: typeof Db, job: MaterializeJob, result: unknown): Promise<MaterializeOutcome> {
  const parsed = VideoIdeasResult.safeParse(result);
  if (!parsed.success) return { ok: false, error: INVALID_SHAPE_ERROR };
  const videoId = typeof job.payload.ideaId === "string" ? job.payload.ideaId : null;
  const [video] = videoId ? await db.select().from(ideas).where(eq(ideas.id, videoId)).limit(1) : [];
  // The video was removed meanwhile: nothing to hang the ideas on.
  if (!video) return { ok: true };
  const [already] = await db.select({ id: ideas.id }).from(ideas).where(sql`${ideas.meta}->>'jobId' = ${job.id}`).limit(1);
  if (already) return { ok: true };

  await db.update(ideas).set({ status: "archived" }).where(and(
    eq(ideas.kind, "video_idea"),
    eq(ideas.status, "new"),
    sql`${ideas.meta}->>'videoId' = ${video.id}`,
  ));
  const at = new Date().toISOString();
  const inserted = await db.insert(ideas).values(parsed.data.posts.map((post, order) => ({
    kind: "video_idea" as const,
    source: "manual" as const,
    title: null,
    content: post.xText,
    author: video.author,
    meta: {
      jobId: job.id,
      videoId: video.id,
      videoTitle: video.title,
      order,
      format: VIDEO_POST_FORMAT,
      sourceName: "youtube",
      fromDescription: parsed.data.source === "description",
      articleUrl: video.url,
      // The card's human score, the shape lib/scout-run.ts's rateCards stores.
      ...(post.slop ? { aiStyle: { slopScore: post.slop.slopScore, verdict: post.slop.verdict, at } } : {}),
    },
  }))).returning({ id: ideas.id });
  // Scored like Trends' results, so the best posts show first with their ✦ (lib/video-posts.ts).
  await rankVideoPosts(db, inserted.map((row) => row.id), video.title ?? video.url ?? "");
  return { ok: true };
}

/**
 * Turns an agent's job result into durable state — drafts and settings —
 * before the result route flips the job to `done` (see jobs/[id]/result/
 * route.ts). Each kind validates `result`'s shape itself (via zod) rather
 * than trusting the agent; a shape mismatch is treated as an agent bug, not
 * a transient failure — see the result route's handling of `{ ok: false }`
 * outcomes here (marks the job `failed`, 400 to the caller).
 *
 * `scout` and any kind materialize.ts doesn't recognize (future kinds this
 * version of the web app doesn't know how to materialize yet) are a no-op
 * success: there is nothing to write, and an unrecognized kind is not
 * itself an error at this layer.
 */
export async function materialize(
  db: typeof Db,
  job: MaterializeJob,
  result: unknown,
): Promise<MaterializeOutcome> {
  switch (job.kind) {
    case "generate_from_video":
    case "generate_from_idea":
      return materializeGeneratedDrafts(db, job, result);
    case "revise_draft":
      return materializeRevision(db, job, result);
    case "image_prompt":
      return materializeImagePrompt(db, job, result);
    case "analyze_style":
      return materializeStyleGuide(db, result);
    case "video_ideas":
      return materializeVideoIdeas(db, job, result);
    case "learn_style":
      return materializeStyleProposal(db, job, result);
    default:
      return { ok: true };
  }
}
