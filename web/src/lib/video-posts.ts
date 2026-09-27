import { eq, inArray } from "drizzle-orm";
import { judgePosts } from "jev-judge";
import type { db as Db } from "@/db";
import { ideas } from "@/db/schema";
import { jevKinds } from "@/lib/find-kinds";
import { getSetting } from "@/lib/settings";
import { getSlopClient } from "@/lib/slop";
import { loadTasteExamples } from "@/lib/taste";

/** Below this, the owner's kept/skipped history says too little to weigh (lib/scout-run.ts's own minimum). */
const MIN_TASTE_EXAMPLES = 3;

/**
 * A video's posts, ranked the way Trends' results are (owner, 2026-09-27:
 * "in un secondo ne leggi 6 o 12 e capisci quali sono migliori"): Jev scores
 * each against the kinds of post the owner puts first (Settings › Sources)
 * and what they keep and dismiss, and the card shows it as ✦, best first.
 * Every post comes from the same video, so relevance is judged against its
 * title and the rank is mostly quality and fit. Best effort: without Jev, or
 * when it fails, the posts keep the order Claude gave them.
 */
export async function rankVideoPosts(db: typeof Db, ids: string[], videoTitle: string): Promise<void> {
  if (ids.length === 0) return;
  const client = await getSlopClient(db);
  if (!client) return;
  try {
    const rows = await db.select().from(ideas).where(inArray(ideas.id, ids));
    const [findOrder, taste] = await Promise.all([getSetting(db as never, "findOrder"), loadTasteExamples(db)]);
    const hasTaste = taste.kept.length + taste.skipped.length >= MIN_TASTE_EXAMPLES;
    const judgments = await judgePosts(client, {
      topic: videoTitle,
      posts: rows.map((row) => ({ id: row.id, text: [row.title, row.content].filter(Boolean).join(". ") })),
      ...(hasTaste ? { taste } : {}),
      kinds: jevKinds(findOrder),
    });
    const byId = new Map(rows.map((row) => [row.id, row]));
    for (const judgment of judgments) {
      const row = byId.get(judgment.id);
      if (!row) continue;
      const meta = {
        ...row.meta,
        rank: judgment.rank,
        quality: judgment.quality,
        tasteFit: judgment.tasteFit,
        postKind: judgment.kind ?? null,
        kindFit: judgment.kindFit ?? null,
      };
      await db.update(ideas).set({ meta }).where(eq(ideas.id, row.id));
    }
  } catch (e) {
    console.error("ranking a video's topics:", e);
  }
}
