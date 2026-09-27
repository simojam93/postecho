import { and, eq, sql } from "drizzle-orm";
import { ideas } from "@/db/schema";
import { enrich, type Enriched } from "@/lib/enrich";
import type { db as Db } from "@/db";

export type SaveIdeaInput = {
  url?: string;
  text?: string;
  source?: "manual" | "scout";
  meta?: Record<string, unknown>;
  /**
   * Pre-fetched enrichment, for a caller that already needed it before
   * deciding to save (e.g. POST /api/search checks the enriched `kind`
   * against Videos mode before persisting anything). When omitted, this
   * fetches it itself — same one-call-per-request shape as
   * app/api/videos/route.ts.
   */
  enriched?: Enriched;
};

/**
 * Shared url/text idea-saving logic, used by both `POST /api/ideas` (the
 * original capture path) and `POST /api/search` (search-first Find Ideas):
 * a `text` input is stored as a `note` idea; a `url` input is enriched
 * (oEmbed/OG) and stored, deduped by url.
 */
export async function saveIdeaFromInput(db: typeof Db, input: SaveIdeaInput) {
  if (input.text !== undefined) {
    const trimmedText = input.text.trim();
    // Note dedupe (M1.5 search-results UX round): a POST /api/search free-text
    // seed that matches an existing note's content, trimmed and case-insensitive,
    // reuses that note instead of creating a near-duplicate — same
    // existing:true contract as the url-dedupe path below. Scoped to kind
    // "note" only, so an x_post/article that happens to share text isn't
    // treated as a duplicate of a note (or vice versa).
    const [existingNote] = await db
      .select()
      .from(ideas)
      .where(and(eq(ideas.kind, "note"), sql`lower(trim(${ideas.content})) = ${trimmedText.toLowerCase()}`))
      .limit(1);
    if (existingNote) return { idea: existingNote, existing: true as const };

    const [idea] = await db.insert(ideas).values({ kind: "note", content: trimmedText }).returning();
    return { idea, existing: false as const };
  }

  if (!input.url) {
    throw new Error("saveIdeaFromInput requires either url or text");
  }
  const url = input.url;

  const enriched = input.enriched ?? await enrich(url);
  const [idea] = await db.insert(ideas).values({
    url, kind: enriched.kind, title: enriched.title, content: enriched.content,
    author: enriched.author,
    // The caller's meta wins on key collisions — it's spread last, and
    // that's intended: source/meta provenance is validated by the caller
    // (only a bearer-token capture or the scout worker may set them), not
    // here. In practice it never actually collides today: enrich() doesn't
    // produce score/topic keys (see lib/enrich.ts's Enriched shape/tests).
    meta: { ...enriched.meta, ...input.meta },
    source: input.source ?? "manual",
  })
    // ideas_url_unique (partial unique index, WHERE url IS NOT NULL) is the
    // arbiter — the matching `where` here is required for Postgres to use a
    // partial index for conflict inference, or every insert (not just
    // duplicates) would fail with "no unique or exclusion constraint
    // matching the ON CONFLICT specification".
    .onConflictDoNothing({ target: ideas.url, where: sql`${ideas.url} is not null` })
    .returning();

  if (!idea) {
    const [existing] = await db.select().from(ideas).where(eq(ideas.url, url)).limit(1);
    // A seed saved while its page couldn't be read (no title/content) gets
    // completed the next time the same url is searched and the read works
    // (live, 2026-09-23: an article seed stayed titleless after the
    // enrichment fallbacks landed). Only nulls are filled — nothing the
    // owner already has is overwritten.
    const backfill: Partial<typeof ideas.$inferInsert> = {};
    if (existing.title === null && enriched.title) backfill.title = enriched.title;
    if (existing.content === null && enriched.content) backfill.content = enriched.content;
    if (existing.author === null && enriched.author) backfill.author = enriched.author;
    if (Object.keys(backfill).length > 0) {
      const [refreshed] = await db.update(ideas).set(backfill).where(eq(ideas.id, existing.id)).returning();
      return { idea: refreshed, existing: true as const };
    }
    return { idea: existing, existing: true as const };
  }
  return { idea, existing: false as const };
}
