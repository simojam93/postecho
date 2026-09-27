import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { ideas } from "@/db/schema";
import { STYLE_INSPIRATION_MAX, STYLE_INSPIRATION_TEXT_MAX, type StyleInspirationItem } from "@/lib/library";
import { requireSession } from "@/lib/session";
import { getSetting, setSetting } from "@/lib/settings";

const Add = z.object({ ideaId: z.uuid() }).strict();

/** GET /api/style-inspiration — the owner's style inspiration list, newest first (lib/library.ts). */
export async function GET() {
  const denied = await requireSession();
  if (denied) return denied;
  try {
    return Response.json({ items: await getSetting(db, "styleInspiration") });
  } catch (e) {
    console.error(e);
    return Response.json({ error: "internal error" }, { status: 500 });
  }
}

/**
 * POST /api/style-inspiration { ideaId } — "Learn from its style" on a Find
 * Ideas card: the post (its text, author, link, kind and Jev's score when the
 * card has one) joins the list, newest first, once per idea, at most
 * STYLE_INSPIRATION_MAX (the oldest drop off).
 */
export async function POST(request: Request) {
  const denied = await requireSession();
  if (denied) return denied;
  const parsed = Add.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "bad request" }, { status: 400 });

  try {
    const [idea] = await db.select().from(ideas).where(eq(ideas.id, parsed.data.ideaId)).limit(1);
    if (!idea) return Response.json({ error: "not found" }, { status: 404 });
    const text = (idea.content ?? idea.title ?? "").trim();
    if (!text) return Response.json({ error: "this post has no text to learn from" }, { status: 400 });

    const items = await getSetting(db, "styleInspiration");
    const existing = items.find((i) => i.ideaId === idea.id);
    if (existing) return Response.json({ item: existing, items, existing: true });

    const aiStyle = idea.meta.aiStyle as { slopScore?: unknown } | undefined;
    const item: StyleInspirationItem = {
      id: crypto.randomUUID(),
      ideaId: idea.id,
      text: text.slice(0, STYLE_INSPIRATION_TEXT_MAX),
      author: idea.author,
      url: idea.url,
      kind: idea.kind,
      slopScore: typeof aiStyle?.slopScore === "number" ? aiStyle.slopScore : null,
      addedAt: new Date().toISOString(),
    };
    const next = [item, ...items].slice(0, STYLE_INSPIRATION_MAX);
    await setSetting(db, "styleInspiration", next);
    return Response.json({ item, items: next }, { status: 201 });
  } catch (e) {
    console.error(e);
    return Response.json({ error: "internal error" }, { status: 500 });
  }
}

/** DELETE /api/style-inspiration?id= (the item) or ?ideaId= (the card's toggle) — takes a post off the list. */
export async function DELETE(request: Request) {
  const denied = await requireSession();
  if (denied) return denied;
  const params = new URL(request.url).searchParams;
  const id = params.get("id");
  const ideaId = params.get("ideaId");
  if (!id && !ideaId) return Response.json({ error: "bad request" }, { status: 400 });
  try {
    const items = await getSetting(db, "styleInspiration");
    const next = items.filter((i) => (id ? i.id !== id : i.ideaId !== ideaId));
    await setSetting(db, "styleInspiration", next);
    return Response.json({ items: next, removed: items.length - next.length });
  } catch (e) {
    console.error(e);
    return Response.json({ error: "internal error" }, { status: 500 });
  }
}
