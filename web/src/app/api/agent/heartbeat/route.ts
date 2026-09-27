import { after } from "next/server";
import { db } from "@/db";
import { requireAgentToken } from "@/lib/agent-auth";
import { getSetting, setSetting } from "@/lib/settings";
import { maybeLearnStyle } from "@/lib/style-learning";

/** The models Settings › AI tools offers (aliases `claude --model` knows); anything else reads as the default. */
const CLAUDE_MODELS = new Set(["sonnet", "opus", "haiku"]);

/**
 * POST /api/agent/heartbeat
 *
 * Records that the agent is alive so the UI can show staleness (see the
 * agentLastHeartbeatAt setting in @/lib/settings). The request body isn't
 * inspected beyond auth. The answer carries the Claude model the owner
 * picked in Settings › AI tools (2026-09-26), which the agent uses from its
 * next job on: `{ ok, claudeModel }`. After answering, it's also when
 * PostEcho may look at the owner's choices to suggest a style guide change
 * (lib/style-learning.ts's maybeLearnStyle: at most daily, then weekly): the
 * Mac that writes the suggestion is on.
 */
export async function POST(request: Request) {
  const denied = requireAgentToken(request);
  if (denied) return denied;
  try {
    await setSetting(db, "agentLastHeartbeatAt", new Date().toISOString());
    after(() => maybeLearnStyle(db).catch((e) => console.error("style learning:", e)));
    const model = await getSetting(db, "claudeModel");
    return Response.json({ ok: true, claudeModel: CLAUDE_MODELS.has(model) ? model : "sonnet" });
  } catch (e) {
    console.error(e);
    return Response.json({ error: "internal error" }, { status: 500 });
  }
}
