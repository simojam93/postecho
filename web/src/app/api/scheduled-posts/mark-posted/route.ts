import { z } from "zod";
import { db } from "@/db";
import { markPostedManually, PAST_TOLERANCE_MS, SCHEDULE_ERROR_HTTP_STATUS } from "@/lib/schedule";
import { requireSession } from "@/lib/session";

const Body = z.object({
  draftId: z.uuid(),
  platform: z.enum(["x", "linkedin"]).default("x"),
  // Write's Schedule (2026-09-24): the time the owner scheduled it for on
  // the platform itself. Absent for Post now: posted this minute.
  publishAt: z.iso.datetime({ offset: true }).optional(),
}).strict();

/**
 * POST /api/scheduled-posts/mark-posted  { draftId, platform?, publishAt? }
 *
 * With `publishAt` ahead (Write's Schedule, 2026-09-24): the owner scheduled
 * the post on X or LinkedIn itself; the row records that time and Plan shows
 * it as scheduled (lib/schedule.ts's isScheduledOnPlatform) — no timer, no
 * email. Without it, Write's Post now: the owner opened X's official intent (or LinkedIn's
 * composer prefill) in a new tab and pressed **Mark as posted**. Records a
 * `posted_manually` row for the draft's text on `platform` (default "x" —
 * the body P1's client sent) with publishAt = now, converting a queued/
 * emailed schedule of the same draft+platform, if any, instead of adding a
 * second row — see lib/schedule.ts's markPostedManually, which also drops
 * that schedule's QStash message — and marks the draft used. Both
 * platforms are human-in-the-loop (owner decision 2026-09-22). 201
 * `{ post }`; 400 `no_text`/`too_long`; 404 unknown draft.
 */
export async function POST(request: Request) {
  const denied = await requireSession();
  if (denied) return denied;

  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "bad request" }, { status: 400 });

  try {
    const publishAt = parsed.data.publishAt ? new Date(parsed.data.publishAt) : undefined;
    if (publishAt && publishAt.getTime() < Date.now() - PAST_TOLERANCE_MS) {
      return Response.json({ error: "pick the time you scheduled it for, in the future", code: "in_past" }, { status: 400 });
    }
    const result = await markPostedManually(db, { draftId: parsed.data.draftId, platform: parsed.data.platform, ...(publishAt ? { publishAt } : {}) });
    if (!result.ok) {
      return Response.json({ error: result.error, code: result.code }, { status: SCHEDULE_ERROR_HTTP_STATUS[result.code] });
    }
    return Response.json({ post: result.post }, { status: 201 });
  } catch (e) {
    console.error(e);
    return Response.json({ error: "internal error" }, { status: 500 });
  }
}
