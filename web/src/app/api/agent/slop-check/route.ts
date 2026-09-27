import { z } from "zod";
import { db } from "@/db";
import { requireAgentToken } from "@/lib/agent-auth";
import { getSlopClient, runSlopCheck } from "@/lib/slop";

const Body = z.object({
  // A humanized rewrite may run a little past the tab's 5000-character input.
  text: z.string().trim().min(1).max(6000),
  platform: z.enum(["x", "linkedin"]).optional(),
}).strict();

/**
 * POST /api/agent/slop-check
 *
 * Jev's AI-style check for the Mac agent's humanize loop (M3.6 — owner,
 * 2026-09-23: "aggiungi il loop anche qui tra jev e claude quando clicco
 * humanize"). Claude runs on the Mac and the TypeSafe key stays on the
 * server, so the agent asks for each rewrite's score over its bearer token.
 * Same check and the same 503-when-unset contract as the session route
 * POST /api/slop-check; nothing is persisted here (the agent returns the
 * score with its result, and materialize.ts stores it where it belongs).
 */
export async function POST(request: Request) {
  const denied = requireAgentToken(request);
  if (denied) return denied;

  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "bad request" }, { status: 400 });

  const client = await getSlopClient(db);
  if (!client) {
    return Response.json({ error: "slop check disabled: TYPESAFE_API_KEY not set" }, { status: 503 });
  }

  try {
    const slop = await runSlopCheck(db, client, { text: parsed.data.text, platform: parsed.data.platform });
    return Response.json({ slop });
  } catch (e) {
    console.error(e);
    return Response.json({ error: "internal error" }, { status: 500 });
  }
}
