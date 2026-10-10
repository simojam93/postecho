import { db } from "@/db";
import { jobs } from "@/db/schema";
import { agentServes, UPDATE_AGENT_ERROR } from "@/lib/agent-kinds";
import { requireSession } from "@/lib/session";

/**
 * POST /api/repos/pick (posts from a repo, 2026-10-10)
 *
 * Choose a folder: a `pick_folder` job opens the folder picker on the owner's computer. Answers
 * `{ jobId }`; the page waits for the job and reads `{ path }` or `{ cancelled: true }` from its
 * result (GET /api/jobs), or its error when the computer has no picker. 409 with the update
 * message when the agent's last heartbeat didn't list pick_folder (lib/agent-kinds.ts).
 */
export async function POST() {
  const denied = await requireSession();
  if (denied) return denied;
  try {
    if (!(await agentServes("pick_folder"))) return Response.json({ error: UPDATE_AGENT_ERROR }, { status: 409 });
    const [job] = await db.insert(jobs).values({ kind: "pick_folder", payload: {} }).returning();
    return Response.json({ jobId: job.id }, { status: 201 });
  } catch (err) {
    console.error(err);
    return Response.json({ error: "internal error" }, { status: 500 });
  }
}
