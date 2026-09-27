import { after } from "next/server";
import { z } from "zod";
import { db } from "@/db";
import { backfillIdeaKind } from "@/lib/idea-kind";
import { cancelSchedule, rateSchedule, SCHEDULE_ERROR_HTTP_STATUS, updateSchedule } from "@/lib/schedule";
import { requireSession } from "@/lib/session";

const PatchBody = z.object({
  publishAt: z.iso.datetime({ offset: true }).optional(),
  text: z.string().max(4000).optional(),
}).strict().refine((b) => b.publishAt !== undefined || b.text !== undefined, { message: "nothing to change" });
// Plan's "How did it do?" (2026-09-26): a vote, or null to take it back — alone, never with an edit.
const RateBody = z.object({ outcome: z.enum(["good", "bad"]).nullable() }).strict();

/**
 * PATCH /api/scheduled-posts/:id  { publishAt?, text? }
 *
 * Plan's Edit (owner, 2026-09-24: "edit the scheduled posts, for example
 * changing the timing") — lib/schedule.ts's updateSchedule: a queued,
 * emailed or failed post gets a new time and/or text and is queued for it,
 * its timer moved. `{ post }`; 400 for a bad body, a time in the past or a
 * bad text; 404 for an unknown or malformed id; 409 when the post is done,
 * canceled or changed meanwhile, or another schedule of it is queued.
 * `{ outcome: "good" | "bad" | null }` instead is Plan's vote on a post that is out (rateSchedule): 409 when it isn't out.
 */
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const denied = await requireSession();
  if (denied) return denied;

  const { id } = await params;
  if (!z.uuid().safeParse(id).success) return Response.json({ error: "not found" }, { status: 404 });
  const body = await request.json().catch(() => null);
  if (body !== null && typeof body === "object" && "outcome" in body) return rate(id, body);
  const parsed = PatchBody.safeParse(body);
  if (!parsed.success) return Response.json({ error: "bad request" }, { status: 400 });

  try {
    const result = await updateSchedule(db, id, {
      publishAt: parsed.data.publishAt ? new Date(parsed.data.publishAt) : undefined,
      text: parsed.data.text,
    });
    if (!result) return Response.json({ error: "not found" }, { status: 404 });
    if (!result.ok) return Response.json({ error: result.error, code: result.code }, { status: SCHEDULE_ERROR_HTTP_STATUS[result.code] });
    return Response.json({ post: result.post });
  } catch (e) {
    console.error(e);
    return Response.json({ error: "internal error" }, { status: 500 });
  }
}

/** The vote: saved, then — after the response — the idea behind it learns its kind if it has none (lib/idea-kind.ts). */
async function rate(id: string, body: unknown): Promise<Response> {
  const parsed = RateBody.safeParse(body);
  if (!parsed.success) return Response.json({ error: "bad request" }, { status: 400 });
  try {
    const result = await rateSchedule(db, id, parsed.data.outcome);
    if (!result) return Response.json({ error: "not found" }, { status: 404 });
    if (!result.ok) return Response.json({ error: result.error, code: result.code }, { status: SCHEDULE_ERROR_HTTP_STATUS[result.code] });
    if (parsed.data.outcome !== null) {
      const draftId = result.post.draftId;
      after(() => backfillIdeaKind(db, draftId));
    }
    return Response.json({ post: result.post });
  } catch (e) {
    console.error(e);
    return Response.json({ error: "internal error" }, { status: 500 });
  }
}

/**
 * DELETE /api/scheduled-posts/:id
 *
 * Cancels a schedule — lib/schedule.ts's cancelSchedule: queued/emailed/
 * failed → canceled; a row already canceled (or already published/posted,
 * which can't be undone here) comes back as it is, so the call is
 * idempotent. `{ post }`; 404 for an unknown or malformed id.
 */
export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const denied = await requireSession();
  if (denied) return denied;

  const { id } = await params;
  if (!z.uuid().safeParse(id).success) return Response.json({ error: "not found" }, { status: 404 });

  try {
    const post = await cancelSchedule(db, id);
    if (!post) return Response.json({ error: "not found" }, { status: 404 });
    // cancelSchedule has already canceled the row's QStash message when it
    // had one (P2) — and the publish webhook tolerates a late delivery
    // anyway (a non-queued row is a 200 no-op), so that is belt and braces.
    return Response.json({ post });
  } catch (e) {
    console.error(e);
    return Response.json({ error: "internal error" }, { status: 500 });
  }
}
