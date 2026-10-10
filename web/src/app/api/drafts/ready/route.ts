import { db } from "@/db";
import { listReadyPosts } from "@/lib/drafts";
import { requireSession } from "@/lib/session";

/**
 * GET /api/drafts/ready
 *
 * Schedule's Ready to schedule list (schedule in a row, 2026-10-10): the posts made Ready in Compose,
 * oldest ready first, each with the platforms still to schedule — lib/drafts.ts's listReadyPosts.
 * `{ posts }`. Its own route rather than a second `view=` on GET /api/drafts (see that route's View).
 */
export async function GET() {
  const denied = await requireSession();
  if (denied) return denied;

  try {
    return Response.json({ posts: await listReadyPosts(db) });
  } catch (e) {
    console.error(e);
    return Response.json({ error: "internal error" }, { status: 500 });
  }
}
