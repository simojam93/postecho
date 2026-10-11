import { and, desc, eq, gt, inArray, or, sql } from "drizzle-orm";
import { db } from "@/db";
import { drafts, jobs } from "@/db/schema";
import { LONG_MEDIA_KINDS } from "@/lib/media";
import { requireSession } from "@/lib/session";

/** How far back an ended job still counts as just ended: the sidebar polls every few seconds, so a few minutes is plenty. */
export const RECENT_END_MS = 10 * 60_000;

/** How much of a post's text names it in a notice. */
const TITLE_CHARS = 48;

/** The post's name in a notice: an article's title, else the start of its text on one line. */
function titleOf(row: { articleTitle: string | null; xText: string | null; linkedinText: string | null }): string {
  const text = (row.articleTitle ?? row.xText ?? row.linkedinText ?? "").replace(/\s+/g, " ").trim();
  return text.length > TITLE_CHARS ? `${text.slice(0, TITLE_CHARS - 1).trimEnd()}…` : text;
}

/**
 * GET /api/jobs/active: what the sidebar shows while PostEcho works (owner,
 * 2026-09-27: "se stanno lavorando voglio che ci sia un charging che poi
 * diventa un tick verde quando ha finito, così se sono su un'altra tab posso
 * controllare"). The jobs queued or running, and those that ended in the last
 * few minutes with how they ended, so a job seen running can say it's done
 * (components/work-status.ts). Id, kind and status only, plus, for a post's
 * screenshots or video (2026-10-11: they run while the owner writes the next
 * posts), `media: { kind, ideaId, title }` for the notice that they're ready.
 */
export async function GET() {
  const denied = await requireSession();
  if (denied) return denied;
  try {
    const rows = await db
      .select({
        id: jobs.id, kind: jobs.kind, status: jobs.status, payload: jobs.payload,
        ideaId: drafts.ideaId, articleTitle: drafts.articleTitle, xText: drafts.xText, linkedinText: drafts.linkedinText,
      })
      .from(jobs)
      .leftJoin(drafts, and(sql`${jobs.kind} = 'post_media'`, eq(sql`${drafts.id}::text`, sql`${jobs.payload}->>'draftId'`)))
      .where(or(inArray(jobs.status, ["queued", "claimed"]), gt(jobs.finishedAt, new Date(Date.now() - RECENT_END_MS))))
      .orderBy(desc(jobs.createdAt))
      .limit(50);
    return Response.json({
      jobs: rows.map((row) => {
        const mediaKind = (row.payload as { kind?: unknown }).kind;
        const long = row.kind === "post_media" && LONG_MEDIA_KINDS.includes(mediaKind as never) && row.ideaId;
        return {
          id: row.id, kind: row.kind, status: row.status,
          ...(long ? { media: { kind: mediaKind, ideaId: row.ideaId, title: titleOf(row) } } : {}),
        };
      }),
    });
  } catch (e) {
    console.error(e);
    return Response.json({ error: "internal error" }, { status: 500 });
  }
}
