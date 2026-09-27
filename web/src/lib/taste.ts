import { and, desc, eq, inArray, isNotNull, ne } from "drizzle-orm";
import { drafts, ideas, scheduledPosts } from "@/db/schema";
import type { db as Db } from "@/db";
import type { TasteExamples } from "jev-judge";
import { FIND_KIND_IDS, isFindKindId, type FindKindId } from "@/lib/find-kinds";

const MAX_EXAMPLES = 15;
const MAX_CHARS = 400;
/** Votes read per search: far more than the owner casts, enough never to cut a recent one. */
const MAX_RATED_ROWS = 200;

type Example = { id: string; content: string };

async function recentContent(db: typeof Db, statuses: Array<"used" | "dismissed" | "kept">, limit: number): Promise<Example[]> {
  const rows = await db
    .select({ id: ideas.id, content: ideas.content })
    .from(ideas)
    .where(and(inArray(ideas.status, statuses), isNotNull(ideas.content), ne(ideas.kind, "youtube")))
    .orderBy(desc(ideas.createdAt))
    .limit(limit);
  return rows.map((r) => ({ id: r.id, content: r.content! }));
}

/** An idea behind posts the owner voted on in Plan. */
export type RatedIdea = { id: string; content: string; postKind: unknown; outcome: "good" | "bad" };

/**
 * The ideas behind the owner's rated posts (Plan's 👍/👎, owner 2026-09-26), newest vote first:
 * good when any of its posts did well — the idea worked; the problem was elsewhere — and bad
 * when every rated one didn't land. YouTube ideas and ideas without text are left out, as in
 * the rest of taste.
 */
export async function loadRatedIdeas(db: typeof Db): Promise<RatedIdea[]> {
  const rows = await db
    .select({ id: ideas.id, content: ideas.content, meta: ideas.meta, outcome: scheduledPosts.outcome })
    .from(scheduledPosts)
    .innerJoin(drafts, eq(drafts.id, scheduledPosts.draftId))
    .innerJoin(ideas, eq(ideas.id, drafts.ideaId))
    .where(and(isNotNull(scheduledPosts.outcome), isNotNull(scheduledPosts.ratedAt), isNotNull(ideas.content), ne(ideas.kind, "youtube")))
    .orderBy(desc(scheduledPosts.ratedAt))
    .limit(MAX_RATED_ROWS);
  const byId = new Map<string, RatedIdea>();
  for (const row of rows) {
    const seen = byId.get(row.id);
    if (!seen) byId.set(row.id, { id: row.id, content: row.content!, postKind: row.meta?.postKind, outcome: row.outcome! });
    else if (row.outcome === "good") seen.outcome = "good";
  }
  return [...byId.values()];
}

/**
 * Builds jev-judge's `TasteExamples` from the owner's own behavior, each list capped at 15
 * ideas of 400 characters (the caps `judgePosts` applies too, explicit here):
 *
 * - `kept`: the ideas behind posts that did well (Plan's 👍, 2026-09-26) first — real results
 *   beat a first impression — then the most recent ideas marked `used` (Use) or `kept` (♥),
 *   interleaved by recency.
 * - `skipped`: the ideas behind posts that didn't land (👎) first, then the most recent
 *   `dismissed` ones.
 *
 * A rated idea appears once, on its vote's side. `youtube` ideas are left out of both lists:
 * a video title isn't a taste signal about the kind of *post* the owner wants scouted.
 */
export async function loadTasteExamples(db: typeof Db): Promise<TasteExamples> {
  const rated = await loadRatedIdeas(db);
  const ratedIds = new Set(rated.map((r) => r.id));
  const limit = MAX_EXAMPLES + ratedIds.size;
  const [kept, skipped] = await Promise.all([
    recentContent(db, ["used", "kept"], limit),
    recentContent(db, ["dismissed"], limit),
  ]);
  const unrated = (list: Example[]) => list.filter((e) => !ratedIds.has(e.id));
  const texts = (list: Example[]) => list.slice(0, MAX_EXAMPLES).map((e) => e.content.slice(0, MAX_CHARS));
  return {
    kept: texts([...rated.filter((r) => r.outcome === "good"), ...unrated(kept)]),
    skipped: texts([...rated.filter((r) => r.outcome === "bad"), ...unrated(skipped)]),
  };
}

export type KindCounts = Record<FindKindId, { good: number; bad: number }>;

/** 👍/👎 per kind of post, over rated ideas whose kind is one of the five — Settings shows them beside the order. */
export function kindCountsOf(rated: RatedIdea[]): KindCounts {
  const counts = Object.fromEntries(FIND_KIND_IDS.map((id) => [id, { good: 0, bad: 0 }])) as KindCounts;
  for (const idea of rated) {
    if (isFindKindId(idea.postKind)) counts[idea.postKind][idea.outcome]++;
  }
  return counts;
}
