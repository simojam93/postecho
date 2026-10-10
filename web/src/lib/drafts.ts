import { and, asc, desc, eq, inArray, isNotNull, isNull, ne } from "drizzle-orm";
import { drafts, ideas, jobs, scheduledPosts } from "@/db/schema";
import { MAX_TAKES } from "@/lib/takes";
import type { db as Db } from "@/db";

const DEFAULT_LIMIT = 50;

// The only two job kinds whose payload carries an `ideaId` (see
// materialize.ts and the videos/from-idea routes) — revise_draft and
// image_prompt key their payload by `draftId` instead, so restricting to
// these two is both correct and keeps latestGenerationJobStatusByIdea's
// query small.
const GENERATION_JOB_KINDS = ["generate_from_video", "generate_from_idea"] as const;

// A draft still "in progress" on the Write page (M2.5 plan, task W2): a take
// Claude proposed (`candidate`) or the one the owner picked (`kept`).
// `discarded` is hidden and `used` is published (M3) — neither counts.
const IN_PROGRESS_STATUSES = ["kept", "candidate"] as const;

export type DraftStatusFilter = "candidate" | "kept" | "used" | "discarded";

export type DraftListFilters = {
  ideaId?: string;
  status?: DraftStatusFilter;
  limit?: number;
};

export type IdeaSummary = { id: string; title: string | null; url: string | null; kind: string };

export type DraftListItem = typeof drafts.$inferSelect & {
  /** The idea this draft was generated from, or null for one with no ideaId. */
  idea: IdeaSummary | null;
  /**
   * The most recent generate_from_video/generate_from_idea job's status for
   * this draft's idea — lets the Create tab show a "Claude is writing…"
   * state for a video/idea whose candidates haven't landed yet. Null when
   * the draft has no ideaId, or no such job exists for its idea.
   */
  latestJobStatus: string | null;
};

/**
 * One post the owner is working on in Write (M2.5 plan, task W2): an idea
 * with at least one kept/candidate draft, summarized for the in-progress
 * strip. Drafts with no ideaId (none exist today) collapse into a single
 * entry with `ideaId: null` and `idea: null`.
 */
export type PostInProgress = {
  ideaId: string | null;
  idea: IdeaSummary | null;
  /**
   * The `kept` draft — the take the owner picked. Normally there is at most
   * one per idea; two only exist mid-pick (the Write page keeps the new take
   * BEFORE demoting the previous one, see components/write), in which case
   * the most recently updated — i.e. most recently picked — one wins. Null
   * while only candidates exist.
   */
  chosenDraftId: string | null;
  /** How many takes the idea has — the cards in Write's takes row: one per take line (lib/takes.ts), at most MAX_TAKES. */
  takeCount: number;
  /** Same as DraftListItem.latestJobStatus, for the strip's "generating" dot. */
  latestJobStatus: string | null;
};

/**
 * Batched (not N+1) lookup of the latest generation job's status per idea
 * id: one query for every generate_from_video/generate_from_idea job,
 * ordered newest first, reduced in JS to "first (= newest) status seen per
 * ideaId" — same payload-field-extraction style as GET /api/jobs's seedKind
 * join, rather than a jsonb `->>'ideaId'` SQL expression (see task A6's
 * jobs-route filter for that alternative), since this needs the same
 * extraction logic per-row anyway, not just an equality filter.
 */
async function latestGenerationJobStatusByIdea(db: typeof Db): Promise<Map<string, string>> {
  const rows = await db
    .select({ payload: jobs.payload, status: jobs.status })
    .from(jobs)
    .where(inArray(jobs.kind, GENERATION_JOB_KINDS))
    .orderBy(desc(jobs.createdAt));

  const byIdea = new Map<string, string>();
  for (const row of rows) {
    const ideaId = (row.payload as { ideaId?: unknown }).ideaId;
    if (typeof ideaId === "string" && !byIdea.has(ideaId)) byIdea.set(ideaId, row.status);
  }
  return byIdea;
}

/** One `IN (...)` query for the idea summaries a listing joins onto its drafts. */
async function ideaSummariesById(db: typeof Db, ideaIds: string[]): Promise<Map<string, IdeaSummary>> {
  const byId = new Map<string, IdeaSummary>();
  if (ideaIds.length === 0) return byId;
  const rows = await db
    .select({ id: ideas.id, title: ideas.title, url: ideas.url, kind: ideas.kind })
    .from(ideas)
    .where(inArray(ideas.id, ideaIds));
  for (const row of rows) byId.set(row.id, row);
  return byId;
}

/**
 * Lists drafts for the Create tab (GET /api/drafts): newest first, each
 * joined with a summary of its source idea and the latest generation job's
 * status for that idea (see DraftListItem above).
 */
export async function listDrafts(db: typeof Db, filters: DraftListFilters): Promise<DraftListItem[]> {
  const conditions = [];
  if (filters.ideaId) conditions.push(eq(drafts.ideaId, filters.ideaId));
  if (filters.status) conditions.push(eq(drafts.status, filters.status));

  const rows = await db
    .select()
    .from(drafts)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(drafts.createdAt))
    .limit(filters.limit ?? DEFAULT_LIMIT);

  const ideaIds = [...new Set(rows.map((d) => d.ideaId).filter((id): id is string => id !== null))];

  const ideaById = await ideaSummariesById(db, ideaIds);
  const latestJobStatusByIdea = ideaIds.length > 0
    ? await latestGenerationJobStatusByIdea(db)
    : new Map<string, string>();

  return rows.map((d) => ({
    ...d,
    idea: d.ideaId ? ideaById.get(d.ideaId) ?? null : null,
    latestJobStatus: d.ideaId ? latestJobStatusByIdea.get(d.ideaId) ?? null : null,
  }));
}

/**
 * The posts in progress for Write's strip (GET /api/drafts?view=in-progress):
 * one entry per idea with at least one kept/candidate draft and none
 * scheduled or posted — a post that went out, or is set to, is in Write's
 * Archive instead (owner, 2026-09-27: "così si parte sul pulito"). Most recently
 * touched first — ordered by the newest `updatedAt` among those drafts, so
 * the post the owner last edited, picked a take for, or generated takes for
 * comes first (a fresh generation's drafts are created AND updated "now"; a
 * pick or an autosave bumps updatedAt via the column's $onUpdate). Not
 * limited: the number of posts in progress is small by construction (the
 * owner works one post at a time and discards or publishes the rest).
 */
export async function listPostsInProgress(db: typeof Db): Promise<PostInProgress[]> {
  const [all, used] = await Promise.all([
    db
      .select({ id: drafts.id, ideaId: drafts.ideaId, status: drafts.status, parentId: drafts.parentId, readyAt: drafts.readyAt })
      .from(drafts)
      .where(inArray(drafts.status, IN_PROGRESS_STATUSES))
      .orderBy(desc(drafts.updatedAt), desc(drafts.createdAt)),
    db.select({ ideaId: drafts.ideaId }).from(drafts).where(eq(drafts.status, "used")),
  ]);
  // A post made Ready waits in Schedule's list (schedule in a row, 2026-10-10), not here: its idea leaves
  // the strip with every take, as a used one does.
  const elsewhere = new Set([
    ...used.map((row) => row.ideaId),
    ...all.filter((row) => row.readyAt !== null).map((row) => row.ideaId),
  ].filter((id): id is string => id !== null));
  const rows = all.filter((row) => row.readyAt === null && (row.ideaId === null || !elsewhere.has(row.ideaId)));
  // A draft starts a take unless it's a version of another in-progress draft
  // (lib/takes.ts's lines, as near as these rows tell).
  const inProgressIds = new Set(rows.map((row) => row.id));

  // Rows arrive most recently touched first, so each group's first row fixes
  // the group's position (Map preserves insertion order) and the first
  // `kept` row seen in a group is its most recently picked take.
  const groups = new Map<string | null, PostInProgress>();
  for (const row of rows) {
    let post = groups.get(row.ideaId);
    if (!post) {
      post = { ideaId: row.ideaId, idea: null, chosenDraftId: null, takeCount: 0, latestJobStatus: null };
      groups.set(row.ideaId, post);
    }
    if (!row.parentId || !inProgressIds.has(row.parentId)) post.takeCount = Math.min(MAX_TAKES, post.takeCount + 1);
    if (row.status === "kept" && post.chosenDraftId === null) post.chosenDraftId = row.id;
  }

  const ideaIds = [...groups.keys()].filter((id): id is string => id !== null);
  const ideaById = await ideaSummariesById(db, ideaIds);
  const latestJobStatusByIdea = ideaIds.length > 0
    ? await latestGenerationJobStatusByIdea(db)
    : new Map<string, string>();

  for (const post of groups.values()) {
    if (post.ideaId === null) continue;
    post.idea = ideaById.get(post.ideaId) ?? null;
    post.latestJobStatus = latestJobStatusByIdea.get(post.ideaId) ?? null;
  }
  return [...groups.values()];
}

/** A post in Schedule's Ready to schedule list (schedule in a row, 2026-10-10). */
export type ReadyPost = {
  draftId: string;
  ideaId: string | null;
  xText: string | null;
  linkedinText: string | null;
  /** The platforms it has text for and isn't scheduled or posted on yet, X first. */
  platforms: Array<"x" | "linkedin">;
  readyAt: Date;
};

/**
 * The posts made Ready in Compose and not yet scheduled everywhere, oldest ready first (GET
 * /api/drafts/ready). Each carries only the platforms left: a post scheduled on X and skipped on
 * LinkedIn stays with LinkedIn. Articles never: X has no scheduler an app can open for them.
 */
export async function listReadyPosts(db: typeof Db): Promise<ReadyPost[]> {
  const ready = await db.select().from(drafts)
    .where(and(isNotNull(drafts.readyAt), ne(drafts.status, "discarded"), isNull(drafts.articleText)))
    .orderBy(asc(drafts.readyAt), asc(drafts.createdAt));
  if (ready.length === 0) return [];
  const recorded = await db
    .select({ draftId: scheduledPosts.draftId, platform: scheduledPosts.platform })
    .from(scheduledPosts)
    .where(and(inArray(scheduledPosts.draftId, ready.map((d) => d.id)), ne(scheduledPosts.status, "canceled")));
  return ready
    .map((d) => ({
      draftId: d.id,
      ideaId: d.ideaId,
      xText: d.xText,
      linkedinText: d.linkedinText,
      platforms: (["x", "linkedin"] as const).filter((platform) =>
        Boolean((platform === "x" ? d.xText : d.linkedinText)?.trim())
        && !recorded.some((row) => row.draftId === d.id && row.platform === platform)),
      readyAt: d.readyAt as Date,
    }))
    .filter((post) => post.platforms.length > 0);
}

/** A post scheduled or posted: Write's Archive (owner, 2026-09-27: "una volta che scheduli un post in write, quelli vanno in un archivio"). */
export type ArchivedPost = {
  draftId: string;
  ideaId: string | null;
  idea: IdeaSummary | null;
  xText: string | null;
  linkedinText: string | null;
  /** Each platform it's scheduled or posted on, soonest first; canceled ones left out. */
  schedules: Array<{ platform: "x" | "linkedin"; publishAt: Date; status: string }>;
  updatedAt: Date;
};

/**
 * The posts that went out or are set to (their take is `used`), latest first
 * (GET /api/drafts/archive). Only those still on a platform: a take whose
 * every schedule was canceled has nothing scheduled or posted, so it's out
 * (owner, 2026-09-27: "togli questa dall'archivio").
 */
export async function listArchivedPosts(db: typeof Db, limit = DEFAULT_LIMIT): Promise<ArchivedPost[]> {
  const live = db.select({ draftId: scheduledPosts.draftId }).from(scheduledPosts).where(ne(scheduledPosts.status, "canceled"));
  const used = await db.select().from(drafts)
    .where(and(eq(drafts.status, "used"), inArray(drafts.id, live)))
    .orderBy(desc(drafts.updatedAt)).limit(limit);
  if (used.length === 0) return [];
  const [schedules, ideaById] = await Promise.all([
    db
      .select({ draftId: scheduledPosts.draftId, platform: scheduledPosts.platform, publishAt: scheduledPosts.publishAt, status: scheduledPosts.status })
      .from(scheduledPosts)
      .where(and(inArray(scheduledPosts.draftId, used.map((d) => d.id)), ne(scheduledPosts.status, "canceled"))),
    ideaSummariesById(db, [...new Set(used.map((d) => d.ideaId).filter((id): id is string => id !== null))]),
  ]);
  return used.map((d) => ({
    draftId: d.id,
    ideaId: d.ideaId,
    idea: d.ideaId ? ideaById.get(d.ideaId) ?? null : null,
    xText: d.xText,
    linkedinText: d.linkedinText,
    schedules: schedules
      .filter((row) => row.draftId === d.id)
      .map(({ platform, publishAt, status }) => ({ platform, publishAt, status }))
      .sort((a, b) => a.publishAt.getTime() - b.publishAt.getTime()),
    updatedAt: d.updatedAt,
  }));
}

/**
 * Removes a post from Write (owner direction, 2026-09-22: "devo poter
 * cancellare i post qui sopra" — DELETE /api/drafts?ideaId=): every
 * kept/candidate draft of the idea becomes `discarded` in one UPDATE — the
 * same status the editor's Discard take uses — so the post drops out of
 * listPostsInProgress and the takes row without deleting anything. `used`
 * drafts (published, M3) and already-discarded ones are left alone, and so
 * is the idea row: it stays on the Liked shelf. Returns how many drafts were
 * discarded — 0 for an idea with nothing in progress or an unknown one.
 */
export async function discardIdeaDrafts(db: typeof Db, ideaId: string): Promise<number> {
  const discarded = await db
    .update(drafts)
    .set({ status: "discarded" })
    .where(and(eq(drafts.ideaId, ideaId), inArray(drafts.status, IN_PROGRESS_STATUSES)))
    .returning({ id: drafts.id });
  return discarded.length;
}
