import { z } from "zod";
import { db } from "@/db";
import { createSchedule, listSchedules, listToRate, SCHEDULE_ERROR_HTTP_STATUS, type ScheduleStatus } from "@/lib/schedule";
import { requireSession } from "@/lib/session";

// Hardcoded literal list, as this codebase does for status-like filters (see
// api/drafts/route.ts's StatusFilter) — note the single-l "canceled", the
// value the enum was created with (see scheduleStatus in db/schema.ts).
const StatusFilter = z.enum(["queued", "emailed", "published", "posted_manually", "failed", "canceled"]);
// Anything Date can parse — a UTC ISO string from the client, or an offset one.
const Instant = z.coerce.date();

const Body = z.object({
  draftId: z.uuid(),
  platform: z.enum(["x", "linkedin"]),
  publishAt: Instant,
}).strict();

/**
 * GET /api/scheduled-posts?from&to&status
 *
 * The queue for the Plan tab (P5), soonest first, each row joined with its
 * draft's current texts and idea title — lib/schedule.ts's listSchedules.
 * `from` is inclusive, `to` exclusive (half-open, so month grids tile
 * cleanly); `status` narrows to one status.
 */
export async function GET(request: Request) {
  const denied = await requireSession();
  if (denied) return denied;

  const params = new URL(request.url).searchParams;

  // Plan's To rate pill (2026-09-26): posts out for more than a day with no vote yet, from any month.
  if (params.get("toRate") === "1") {
    try {
      return Response.json({ posts: await listToRate(db) });
    } catch (e) {
      console.error(e);
      return Response.json({ error: "internal error" }, { status: 500 });
    }
  }

  let from: Date | undefined;
  let to: Date | undefined;
  let status: ScheduleStatus | undefined;
  for (const key of ["from", "to"] as const) {
    const raw = params.get(key);
    if (raw === null) continue;
    const parsed = Instant.safeParse(raw);
    if (!parsed.success) return Response.json({ error: `invalid ${key}` }, { status: 400 });
    if (key === "from") from = parsed.data; else to = parsed.data;
  }
  const statusParam = params.get("status");
  if (statusParam !== null) {
    const parsed = StatusFilter.safeParse(statusParam);
    if (!parsed.success) return Response.json({ error: "invalid status" }, { status: 400 });
    status = parsed.data;
  }

  try {
    return Response.json({ posts: await listSchedules(db, { from, to, status }) });
  } catch (e) {
    console.error(e);
    return Response.json({ error: "internal error" }, { status: 500 });
  }
}

/**
 * POST /api/scheduled-posts  { draftId, platform, publishAt }
 *
 * Write's Schedule → Confirm, one call per checked platform: queues the
 * draft's text for that platform at `publishAt` (UTC) and marks the draft
 * used — lib/schedule.ts's createSchedule. 201 `{ post }`; 400 with a `code`
 * (`no_text`, `too_long`, `in_past`) for a post that can't be scheduled;
 * 404 for an unknown draft; 409 `conflict` when that draft+platform is
 * already queued.
 */
export async function POST(request: Request) {
  const denied = await requireSession();
  if (denied) return denied;

  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "bad request" }, { status: 400 });

  try {
    const result = await createSchedule(db, parsed.data);
    if (!result.ok) {
      return Response.json({ error: result.error, code: result.code }, { status: SCHEDULE_ERROR_HTTP_STATUS[result.code] });
    }
    // The timer is createSchedule's business (P2): with QSTASH_TOKEN set the
    // returned row carries the QStash message id as `externalId`; without it
    // the timer is off and the post waits for POST /api/scheduled-posts/[id]/run.
    return Response.json({ post: result.post }, { status: 201 });
  } catch (e) {
    console.error(e);
    return Response.json({ error: "internal error" }, { status: 500 });
  }
}
