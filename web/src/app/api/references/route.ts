import { z } from "zod";
import { db } from "@/db";
import { REFERENCE_NAME_MAX, REFERENCE_TEXT_MAX, REFERENCES_MAX, type ReferenceItem } from "@/lib/library";
import { requireSession } from "@/lib/session";
import { getSetting, setSetting } from "@/lib/settings";

const Add = z.object({
  name: z.string().trim().min(1).max(REFERENCE_NAME_MAX),
  text: z.string().trim().min(1).max(REFERENCE_TEXT_MAX),
}).strict();
const Update = z.object({
  id: z.string().min(1),
  name: z.string().trim().min(1).max(REFERENCE_NAME_MAX).optional(),
  enabled: z.boolean().optional(),
}).strict();

/** GET /api/references — the owner's reference material (lib/library.ts). */
export async function GET() {
  const denied = await requireSession();
  if (denied) return denied;
  try {
    return Response.json({ items: await getSetting(db, "references") });
  } catch (e) {
    console.error(e);
    return Response.json({ error: "internal error" }, { status: 500 });
  }
}

/** POST /api/references { name, text } — a new item (pasted text, or the text the page read from a .txt, .md, .pdf or .docx file), enabled. */
export async function POST(request: Request) {
  const denied = await requireSession();
  if (denied) return denied;
  const parsed = Add.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: `a name, and text up to ${REFERENCE_TEXT_MAX} characters` }, { status: 400 });
  try {
    const items = await getSetting(db, "references");
    if (items.length >= REFERENCES_MAX) return Response.json({ error: `at most ${REFERENCES_MAX} items — remove one first` }, { status: 400 });
    const item: ReferenceItem = { id: crypto.randomUUID(), ...parsed.data, enabled: true, addedAt: new Date().toISOString() };
    const next = [...items, item];
    await setSetting(db, "references", next);
    return Response.json({ item, items: next }, { status: 201 });
  } catch (e) {
    console.error(e);
    return Response.json({ error: "internal error" }, { status: 500 });
  }
}

/** PATCH /api/references { id, name?, enabled? } — rename or switch an item. */
export async function PATCH(request: Request) {
  const denied = await requireSession();
  if (denied) return denied;
  const parsed = Update.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "bad request" }, { status: 400 });
  try {
    const items = await getSetting(db, "references");
    if (!items.some((i) => i.id === parsed.data.id)) return Response.json({ error: "not found" }, { status: 404 });
    const { id, ...patch } = parsed.data;
    const next = items.map((i) => (i.id === id ? { ...i, ...patch } : i));
    await setSetting(db, "references", next);
    return Response.json({ items: next });
  } catch (e) {
    console.error(e);
    return Response.json({ error: "internal error" }, { status: 500 });
  }
}

/** DELETE /api/references?id= */
export async function DELETE(request: Request) {
  const denied = await requireSession();
  if (denied) return denied;
  const id = new URL(request.url).searchParams.get("id");
  if (!id) return Response.json({ error: "bad request" }, { status: 400 });
  try {
    const items = await getSetting(db, "references");
    const next = items.filter((i) => i.id !== id);
    await setSetting(db, "references", next);
    return Response.json({ items: next, removed: items.length - next.length });
  } catch (e) {
    console.error(e);
    return Response.json({ error: "internal error" }, { status: 500 });
  }
}
