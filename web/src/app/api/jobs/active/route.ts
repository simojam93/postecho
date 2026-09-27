import { desc, gt, inArray, or } from "drizzle-orm";
import { db } from "@/db";
import { jobs } from "@/db/schema";
import { requireSession } from "@/lib/session";

/** How far back an ended job still counts as just ended: the sidebar polls every few seconds, so a few minutes is plenty. */
export const RECENT_END_MS = 10 * 60_000;

/**
 * GET /api/jobs/active: what the sidebar shows while PostEcho works (owner,
 * 2026-09-27: "se stanno lavorando voglio che ci sia un charging che poi
 * diventa un tick verde quando ha finito, così se sono su un'altra tab posso
 * controllare"). The jobs queued or running, and those that ended in the last
 * few minutes with how they ended, so a job seen running can say it's done
 * (components/work-status.ts). Id, kind and status only.
 */
export async function GET() {
  const denied = await requireSession();
  if (denied) return denied;
  try {
    const rows = await db
      .select({ id: jobs.id, kind: jobs.kind, status: jobs.status })
      .from(jobs)
      .where(or(inArray(jobs.status, ["queued", "claimed"]), gt(jobs.finishedAt, new Date(Date.now() - RECENT_END_MS))))
      .orderBy(desc(jobs.createdAt))
      .limit(50);
    return Response.json({ jobs: rows });
  } catch (e) {
    console.error(e);
    return Response.json({ error: "internal error" }, { status: 500 });
  }
}
