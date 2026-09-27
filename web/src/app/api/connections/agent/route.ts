import { requireSession } from "@/lib/session";

/**
 * GET /api/connections/agent — the two lines the Mac agent's `.env` needs
 * (2026-09-26: every connection explained step by step): this site's
 * address and the agent token. For the signed-in owner only, who already
 * holds everything the token opens; shown on request, never with the settings.
 */
export async function GET(request: Request) {
  const denied = await requireSession();
  if (denied) return denied;
  const url = process.env.PUBLIC_BASE_URL?.trim().replace(/\/+$/, "") || new URL(request.url).origin;
  const token = process.env.AGENT_TOKEN?.trim() || null;
  return Response.json({ url, token });
}
