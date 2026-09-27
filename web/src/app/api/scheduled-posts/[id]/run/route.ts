import { POST as publish } from "@/app/api/publish/[id]/route";

/**
 * POST /api/scheduled-posts/:id/run
 *
 * Runs a scheduled post's publish step by hand — dev without QStash, or
 * Plan's Resend/Retry: the very same handler the timer calls (POST
 * /api/publish/[id]), reached through its session path, which also takes
 * an `emailed` or `failed` row (a resend) where the timer path acts on
 * `queued` only. Kept as its own route so the client and the plan agree on
 * the path. 401 without a session, 404 for a malformed or unknown id, 200
 * with `{ post, … }` and the outcome otherwise — see lib/publishers/run.ts.
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  return publish(request, context);
}
