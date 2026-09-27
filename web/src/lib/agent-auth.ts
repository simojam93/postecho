import { safeEqual } from "@/lib/session";

/**
 * Shared bearer-token guard for the agent protocol endpoints (claim/result/
 * heartbeat). Unlike the user-facing routes (see requireSession in
 * @/lib/session), the agent isn't a logged-in browser session — it's a
 * single trusted worker process authenticating with a static token from
 * AGENT_TOKEN. An unset AGENT_TOKEN always denies, so a misconfigured
 * deployment fails closed instead of accepting an empty bearer token.
 */
export function requireAgentToken(request: Request): Response | null {
  const bearer = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  const expected = process.env.AGENT_TOKEN ?? "";
  if (!expected || !bearer || !safeEqual(bearer, expected)) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  return null;
}
