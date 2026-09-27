import { and, desc, eq, inArray, notInArray, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { ideas } from "@/db/schema";
import { requireSession } from "@/lib/session";

const LIMIT = 20;

/**
 * The "recent searches" strip's data source (M1.5 final design — scout jobs
 * are retired, so this reads directly off scouted ideas instead of a jobs
 * table): one row per distinct `meta.topic` among `source: "scout"` ideas,
 * with how many were saved for it and when the most recent one landed.
 *
 * Only ideas still visible in Trends count: dismissed and archived ones are
 * excluded, so a topic whose results the owner has all dismissed (or that
 * the rank cutoff has since archived) drops out of the filter chips instead
 * of lingering as a tag with nothing behind it (owner direction, 2026-09-22:
 * "togli tutti i tag legati all'audio nei filtri").
 */
export async function GET() {
  const denied = await requireSession();
  if (denied) return denied;

  // Reused as the exact same SQL text in select/where/groupBy/orderBy so
  // Postgres treats every occurrence as the same grouping expression.
  const topic = sql`${ideas.meta}->>'topic'`;

  try {
    const rows = await db
      .select({
        query: topic.mapWith(String),
        count: sql<number>`count(*)::int`,
        lastAt: sql<string>`max(${ideas.createdAt})`,
      })
      .from(ideas)
      .where(and(
        eq(ideas.source, "scout"),
        notInArray(ideas.status, ["dismissed", "archived"]),
        sql`${topic} is not null`,
      ))
      .groupBy(topic)
      .orderBy(desc(sql`max(${ideas.createdAt})`))
      .limit(LIMIT);

    // What the owner typed for each chip (2026-09-24: "mi taglia sempre delle
    // parole" — the chip shows the words searched, the tooltip what was
    // written): the newest seed searched with that query whose own text isn't
    // just the query again (a chip's ↻ re-searches with the query as text).
    const queries = rows.map((r) => r.query);
    const searchQuery = sql`${ideas.meta}->>'searchQuery'`;
    const seeds = queries.length === 0 ? [] : await db
      .select({ q: searchQuery.mapWith(String), content: ideas.content, title: ideas.title, url: ideas.url })
      .from(ideas)
      .where(and(eq(ideas.source, "manual"), inArray(searchQuery, queries)))
      .orderBy(desc(ideas.createdAt));
    const seedByQuery = new Map<string, string>();
    for (const s of seeds) {
      const text = (s.content ?? s.title ?? s.url ?? "").trim();
      if (!text || seedByQuery.has(s.q) || text.toLowerCase() === s.q.toLowerCase()) continue;
      seedByQuery.set(s.q, text.length > 300 ? `${text.slice(0, 299)}…` : text);
    }

    return Response.json({ searches: rows.map((r) => ({ ...r, seed: seedByQuery.get(r.query) ?? null })) });
  } catch (e) {
    console.error(e);
    return Response.json({ error: "internal error" }, { status: 500 });
  }
}


const DeleteQuery = z.string().trim().min(1).max(200);

/**
 * DELETE /api/searches?query=<topic>
 *
 * Removes a recent-search chip and its unreviewed results (owner direction,
 * 2026-09-22: "gli argomenti voglio poterli anche cancellare se sono
 * vecchi"). Scouted ideas for that `meta.topic` still `new` are archived
 * (neutral for taste — see lib/taste.ts, which only reads used/kept vs
 * dismissed); ideas the owner already acted on (kept, used, dismissed) are
 * left in their status but lose the `topic` tag, so the chip disappears
 * without touching curated results or the taste history.
 */
export async function DELETE(request: Request) {
  const denied = await requireSession();
  if (denied) return denied;

  const parsed = DeleteQuery.safeParse(new URL(request.url).searchParams.get("query") ?? "");
  if (!parsed.success) return Response.json({ error: "bad request" }, { status: 400 });
  const query = parsed.data;
  const topicMatches = and(eq(ideas.source, "scout"), sql`${ideas.meta}->>'topic' = ${query}`);

  try {
    const archived = await db
      .update(ideas)
      .set({ status: "archived" })
      .where(and(topicMatches, eq(ideas.status, "new")))
      .returning({ id: ideas.id });

    const untagged = await db
      .update(ideas)
      .set({ meta: sql`${ideas.meta} - 'topic'` })
      .where(and(topicMatches, inArray(ideas.status, ["kept", "used", "dismissed"])))
      .returning({ id: ideas.id });

    return Response.json({ query, archived: archived.length, untagged: untagged.length });
  } catch (e) {
    console.error(e);
    return Response.json({ error: "internal error" }, { status: 500 });
  }
}
