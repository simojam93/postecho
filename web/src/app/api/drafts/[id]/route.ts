import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { drafts } from "@/db/schema";
import { requireSession } from "@/lib/session";

const Body = z.object({
  xText: z.string().max(400).optional(),
  linkedinText: z.string().max(4000).optional(),
  // An X article (posts from a repo, 2026-10-10): its title and body, the agent's limits.
  articleTitle: z.string().max(100).optional(),
  articleText: z.string().max(12000).optional(),
  status: z.enum(["candidate", "kept", "used", "discarded"]).optional(),
  favorite: z.boolean().optional(),
}).strict().refine((b) => Object.keys(b).length > 0, { message: "at least one field is required" });

/**
 * PATCH /api/drafts/:id
 *
 * Edits a draft in place — text edits (autosave on blur; an article's title
 * and body too), status changes
 * (Keep/Discard/mark used), and the ♥ favorite toggle, all in one endpoint
 * since the Create tab editor (M2 plan Task A8) fires all of these from the
 * same screen. At least one field is required: an empty `{}` body would
 * otherwise reach `db.update(...).set({})`, an empty SET clause.
 */
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const denied = await requireSession();
  if (denied) return denied;

  const { id } = await params;
  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "bad request" }, { status: 400 });

  if (!z.uuid().safeParse(id).success) return Response.json({ error: "not found" }, { status: 404 });

  try {
    const [draft] = await db.update(drafts).set(parsed.data).where(eq(drafts.id, id)).returning();
    if (!draft) return Response.json({ error: "not found" }, { status: 404 });
    return Response.json({ draft });
  } catch (e) {
    console.error(e);
    return Response.json({ error: "internal error" }, { status: 500 });
  }
}
