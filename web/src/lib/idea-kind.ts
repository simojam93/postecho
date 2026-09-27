import { eq } from "drizzle-orm";
import { classifyPosts, type JevClient } from "jev-judge";
import { jevClient } from "@/lib/connections";
import { drafts, ideas } from "@/db/schema";
import type { db as Db } from "@/db";
import { jevKinds } from "@/lib/find-kinds";
import { getSetting } from "@/lib/settings";

/** What Jev reads of the idea: its title and text, as the search saw them, bounded. */
const MAX_TEXT_CHARS = 2000;

/**
 * The kind of the idea behind a post the owner just rated, when the idea was found before
 * Find Ideas told kinds apart (2026-09-26): asked of Jev once and stored as
 * meta.postKind/kindFit, so Settings can count the vote by kind. Best effort — no Jev key, no
 * idea, a YouTube idea, one that already has a kind, or a failed call leave it as it is.
 */
export async function backfillIdeaKind(db: typeof Db, draftId: string, jev?: JevClient): Promise<void> {
  try {
    const [row] = await db
      .select({ id: ideas.id, kind: ideas.kind, title: ideas.title, content: ideas.content, meta: ideas.meta })
      .from(drafts)
      .innerJoin(ideas, eq(ideas.id, drafts.ideaId))
      .where(eq(drafts.id, draftId))
      .limit(1);
    if (!row || row.kind === "youtube" || typeof row.meta?.postKind === "string") return;
    const text = [row.title, row.content].filter(Boolean).join("\n\n").slice(0, MAX_TEXT_CHARS);
    if (!text) return;
    const client = jev ?? await jevClient(db);
    if (!client) return;
    const kinds = jevKinds(await getSetting(db as never, "findOrder"));
    const [judged] = await classifyPosts(client, { posts: [{ id: row.id, text }], kinds });
    if (!judged?.kind) return;
    await db.update(ideas)
      .set({ meta: { ...row.meta, postKind: judged.kind, kindFit: judged.kindFit } })
      .where(eq(ideas.id, row.id));
  } catch (e) {
    console.warn("[idea-kind] couldn't read the kind of the rated idea", e);
  }
}
