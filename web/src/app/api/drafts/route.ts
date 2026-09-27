import { z } from "zod";
import { db } from "@/db";
import { discardIdeaDrafts, listDrafts, listPostsInProgress, type DraftStatusFilter } from "@/lib/drafts";
import { requireSession } from "@/lib/session";

// Hardcoded literal list rather than derived from draftStatus.enumValues —
// matches this codebase's existing convention for a *status*-like filter
// (see the status enum in api/ideas/[id]/route.ts and agent/jobs/route.ts's
// JobKind), as opposed to a *kind* filter (which IS derived — see
// api/ideas/route.ts's KindFilter).
const StatusFilter = z.enum(["candidate", "kept", "used", "discarded"]);
const Limit = z.coerce.number().int().min(1).max(100);
const DEFAULT_LIMIT = 50;
// The only alternative "view" of the collection so far — Write's posts-in-
// progress strip (M2.5 plan, task W2). A second value here would be the cue
// to move it to its own route instead.
const View = z.enum(["in-progress"]);

/**
 * GET /api/drafts?ideaId=&status=&limit=
 *
 * Lists drafts for the Write page — see lib/drafts.ts's listDrafts for the
 * idea-summary/latest-job-status joins.
 *
 * GET /api/drafts?view=in-progress
 *
 * Instead returns `{ posts }` — one entry per idea with kept/candidate
 * drafts, most recently touched first (lib/drafts.ts's listPostsInProgress),
 * for the strip at the top of Write. The other filters don't apply to this
 * view and are ignored.
 */
export async function GET(request: Request) {
  const denied = await requireSession();
  if (denied) return denied;

  const params = new URL(request.url).searchParams;

  const viewParam = params.get("view");
  if (viewParam !== null) {
    if (!View.safeParse(viewParam).success) return Response.json({ error: "invalid view" }, { status: 400 });
    try {
      return Response.json({ posts: await listPostsInProgress(db) });
    } catch (e) {
      console.error(e);
      return Response.json({ error: "internal error" }, { status: 500 });
    }
  }

  const ideaIdParam = params.get("ideaId");
  if (ideaIdParam !== null && !z.uuid().safeParse(ideaIdParam).success) {
    return Response.json({ error: "invalid ideaId" }, { status: 400 });
  }

  const statusParam = params.get("status");
  let status: DraftStatusFilter | undefined;
  if (statusParam !== null) {
    const parsedStatus = StatusFilter.safeParse(statusParam);
    if (!parsedStatus.success) return Response.json({ error: "invalid status" }, { status: 400 });
    status = parsedStatus.data;
  }

  const limitParam = params.get("limit");
  let limit = DEFAULT_LIMIT;
  if (limitParam !== null) {
    const parsedLimit = Limit.safeParse(limitParam);
    if (!parsedLimit.success) return Response.json({ error: "invalid limit" }, { status: 400 });
    limit = parsedLimit.data;
  }

  try {
    const items = await listDrafts(db, { ideaId: ideaIdParam ?? undefined, status, limit });
    return Response.json({ drafts: items });
  } catch (e) {
    console.error(e);
    return Response.json({ error: "internal error" }, { status: 500 });
  }
}

/**
 * DELETE /api/drafts?ideaId=<uuid>
 *
 * Removes a post in progress from Write (owner direction, 2026-09-22): the
 * idea's kept/candidate drafts are discarded — lib/drafts.ts's
 * discardIdeaDrafts — so it leaves the strip and the takes row. Nothing is
 * deleted: used drafts and the idea itself (still on Liked) are untouched.
 * Returns `{ ideaId, discarded }`; a well-formed ideaId with nothing in
 * progress behind it is a no-op 200 with `discarded: 0`, same as
 * DELETE /api/searches for an unknown topic.
 */
export async function DELETE(request: Request) {
  const denied = await requireSession();
  if (denied) return denied;

  const parsed = z.uuid().safeParse(new URL(request.url).searchParams.get("ideaId"));
  if (!parsed.success) return Response.json({ error: "invalid ideaId" }, { status: 400 });

  try {
    const discarded = await discardIdeaDrafts(db, parsed.data);
    return Response.json({ ideaId: parsed.data, discarded });
  } catch (e) {
    console.error(e);
    return Response.json({ error: "internal error" }, { status: 500 });
  }
}
