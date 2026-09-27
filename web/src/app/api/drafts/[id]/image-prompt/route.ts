import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { drafts, jobs } from "@/db/schema";
import { requireSession } from "@/lib/session";
import { getSetting } from "@/lib/settings";

/**
 * POST /api/drafts/:id/image-prompt
 *
 * The Create tab's "Image prompt" button: enqueues an `image_prompt` job
 * carrying the draft's current text plus the owner's saved image specs
 * (Settings → Image specs), so the agent's prompt (agent Task B5's
 * imagePrompt()) can follow the owner's style/format/avoid-list. No request
 * body — everything it needs comes from the draft row and settings.
 * materialize.ts (task A3) writes the result back onto this same draft's
 * `imagePrompt` column.
 */
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const denied = await requireSession();
  if (denied) return denied;

  const { id } = await params;
  if (!z.uuid().safeParse(id).success) return Response.json({ error: "not found" }, { status: 404 });

  try {
    const [draft] = await db.select().from(drafts).where(eq(drafts.id, id)).limit(1);
    if (!draft) return Response.json({ error: "not found" }, { status: 404 });

    const imageSpecs = await getSetting(db, "imageSpecs");

    const [job] = await db.insert(jobs).values({
      kind: "image_prompt",
      payload: { draftId: draft.id, xText: draft.xText, linkedinText: draft.linkedinText, imageSpecs },
    }).returning();

    return Response.json({ job }, { status: 201 });
  } catch (e) {
    console.error(e);
    return Response.json({ error: "internal error" }, { status: 500 });
  }
}
