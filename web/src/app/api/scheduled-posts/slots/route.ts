import { z } from "zod";
import { db } from "@/db";
import { addDays, suggestSlots, wallClockOf, wallClockToUtc } from "@/lib/schedule";
import { requireSession } from "@/lib/session";

const Platform = z.enum(["x", "linkedin"]);
const Days = z.coerce.number().int().min(1).max(31);
const DEFAULT_DAYS = 7;

/**
 * GET /api/scheduled-posts/slots?platform=x|linkedin&days=7
 *
 * The next free default slots for a platform — Settings `defaultSlots` read
 * as Europe/Rome times, minus the past and minus slots already taken by a
 * non-canceled schedule (lib/schedule.ts's suggestSlots). `{ slots }` as
 * UTC ISO strings, soonest first; Write prefills its Schedule sheet with
 * the first and offers the next few as chips.
 *
 * Suggestions start TOMORROW (Europe/Rome), never today — owner direction,
 * 2026-09-22 ("facciamo da domani tutto"): a same-day slot is still
 * schedulable by typing it in the sheet, it just isn't proposed.
 */
function startOfTomorrowRome(now: Date = new Date()): Date {
  const today = wallClockOf(now);
  return wallClockToUtc(addDays({ year: today.year, month: today.month, day: today.day, hour: 0, minute: 0 }, 1));
}

export async function GET(request: Request) {
  const denied = await requireSession();
  if (denied) return denied;

  const params = new URL(request.url).searchParams;
  const platform = Platform.safeParse(params.get("platform"));
  if (!platform.success) return Response.json({ error: "invalid platform" }, { status: 400 });

  let days = DEFAULT_DAYS;
  const daysParam = params.get("days");
  if (daysParam !== null) {
    const parsed = Days.safeParse(daysParam);
    if (!parsed.success) return Response.json({ error: "invalid days" }, { status: 400 });
    days = parsed.data;
  }

  try {
    return Response.json({ slots: await suggestSlots(db, { platform: platform.data, days, from: startOfTomorrowRome() }) });
  } catch (e) {
    console.error(e);
    return Response.json({ error: "internal error" }, { status: 500 });
  }
}
