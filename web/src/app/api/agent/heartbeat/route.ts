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
 * agentLastHeartbeatAt setting in @/lib/settings). The body's `kinds`, the
 * job kinds the agent serves, are kept as agentKinds (lib/agent-kinds.ts,
 * 2026-10-10). The answer carries the Claude model the owner
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
    // The job kinds this agent serves (lib/agent-kinds.ts): anything but a list of strings is ignored.
    const body = await request.json().catch(() => null) as { kinds?: unknown } | null;
    const kinds = body?.kinds;
    if (Array.isArray(kinds) && kinds.every((k) => typeof k === "string")) {
      await setSetting(db, "agentKinds", kinds.slice(0, 100));
    }
    after(() => maybeLearnStyle(db).catch((e) => console.error("style learning:", e)));
    const model = await getSetting(db, "claudeModel");
    return Response.json({ ok: true, claudeModel: CLAUDE_MODELS.has(model) ? model : "sonnet" });
  } catch (e) {
    console.error(e);
    return Response.json({ error: "internal error" }, { status: 500 });
  }
}
