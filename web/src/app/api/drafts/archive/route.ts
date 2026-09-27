import { db } from "@/db";
import { listArchivedPosts } from "@/lib/drafts";
import { requireSession } from "@/lib/session";

/**
 * GET /api/drafts/archive
 *
 * Write's Archive (owner, 2026-09-27: "una volta che scheduli un post in
 * write, quelli vanno in un archivio… così si parte sul pulito"): the posts
 * scheduled or posted, latest first, each with its text and where and when
 * (lib/drafts.ts's listArchivedPosts). Write's strip no longer lists them.
 */
export async function GET() {
  const denied = await requireSession();
  if (denied) return denied;
  try {
    return Response.json({ posts: await listArchivedPosts(db) });
  } catch (e) {
    console.error(e);
    return Response.json({ error: "internal error" }, { status: 500 });
  }
}
