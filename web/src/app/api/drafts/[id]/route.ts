import { eq, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { drafts } from "@/db/schema";
import { mediaOf } from "@/lib/media";
import { requireSession } from "@/lib/session";

const Body = z.object({
  xText: z.string().max(400).optional(),
  linkedinText: z.string().max(4000).optional(),
  // An X article (posts from a repo, 2026-10-10): its title and body, the agent's limits.
  articleTitle: z.string().max(100).optional(),
  articleText: z.string().max(12000).optional(),
  status: z.enum(["candidate", "kept", "used", "discarded"]).optional(),
  favorite: z.boolean().optional(),
  // Compose's Ready (true) and Back to Compose (false), schedule in a row (2026-10-10): sets or clears readyAt.
  ready: z.boolean().optional(),
  // Keep and Remove on a post's media (media from a repo, 2026-10-11): the list the page wants.
  media: z.array(z.object({ file: z.string().max(200), kept: z.boolean() }).strict()).max(50).optional(),
}).strict().refine((b) => Object.keys(b).length > 0, { message: "at least one field is required" });

/**
 * PATCH /api/drafts/:id
 *
 * Edits a draft in place — text edits (autosave on blur; an article's title
 * and body too), Ready / Back to Compose (`ready`; 409 for an article), status changes
 * (Keep/Discard/mark used), the ♥ favorite toggle, and Keep/Remove on the post's
 * media (`media: [{ file, kept }]`, the list the page wants), all in one endpoint
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

  const { ready, media, ...rest } = parsed.data;
  const fields: typeof rest & { meta?: SQL } = rest;
  try {
    if (ready || media) {
      const [current] = await db.select({ articleText: drafts.articleText, meta: drafts.meta }).from(drafts).where(eq(drafts.id, id)).limit(1);
      if (!current) return Response.json({ error: "not found" }, { status: 404 });
      // An article isn't scheduled in a row: X has no scheduler an app can open for it.
      if (ready && current.articleText !== null) return Response.json({ error: "an article can't be scheduled from Schedule" }, { status: 409 });
      if (media) {
        // The draft's items the page still lists, in the draft's order, kept as it says; a name it never had is ignored.
        // Only meta.media is written, so a slop check landing meanwhile stays.
        const wanted = new Map(media.map((item) => [item.file, item.kept]));
        const next = mediaOf(current.meta).filter((item) => wanted.has(item.file)).map((item) => ({ ...item, kept: wanted.get(item.file)! }));
        fields.meta = sql`jsonb_set(${drafts.meta}, '{media}', ${JSON.stringify(next)}::jsonb)`;
      }
    }
    const changes = ready === undefined ? fields : { ...fields, readyAt: ready ? new Date() : null };
    const [draft] = await db.update(drafts).set(changes).where(eq(drafts.id, id)).returning();
    if (!draft) return Response.json({ error: "not found" }, { status: 404 });
    return Response.json({ draft });
  } catch (e) {
    console.error(e);
    return Response.json({ error: "internal error" }, { status: 500 });
  }
}
