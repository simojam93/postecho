import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { ideas } from "@/db/schema";
import { requireSession } from "@/lib/session";

/**
 * POST /api/ideas/clear
 *
 * "Clear all" on Trends (M2.5 W1 — owner direction, 2026-09-22: "trends e
 * videos fanno la parte operativa e devono essere rapidamente ripulibili,
 * liked rimangono quelli di valore"): archives every scouted result still
 * awaiting review — `source = "scout"`, `status = "new"`, whatever its kind
 * — in one statement and reports how many. That is exactly the subset
 * Trends renders (see (authed)/page.tsx's `isTrendsResult`), so Trends is
 * empty afterwards while everything the owner acted on survives: kept/used
 * stay in Liked, dismissed stays dismissed (both feed lib/taste.ts —
 * archiving `new` rows is neutral for taste), and manual seeds/notes AND
 * pasted videos (all `source = "manual"` — Videos shows only those, see
 * page.tsx's `isVideo`) are never touched. Scouted youtube results used to
 * be excluded here (`kind ≠ youtube`, when Videos showed them); since M3.5
 * U1 (owner direction, 2026-09-23: "YT come source lo voglio comunque vedere
 * nella pagina trends") they are Trends results like any other source, so
 * they go with the rest. Per-search clearing is DELETE /api/searches (which
 * also drops the chip); this is the whole-shelf version.
 */
export async function POST() {
  const denied = await requireSession();
  if (denied) return denied;

  try {
    const archived = await db
      .update(ideas)
      .set({ status: "archived" })
      .where(and(eq(ideas.source, "scout"), eq(ideas.status, "new")))
      .returning({ id: ideas.id });
    return Response.json({ archived: archived.length });
  } catch (e) {
    console.error(e);
    return Response.json({ error: "internal error" }, { status: 500 });
  }
}
