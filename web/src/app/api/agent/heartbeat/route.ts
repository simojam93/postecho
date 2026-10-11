import { after } from "next/server";
import { and, eq, lt, notInArray } from "drizzle-orm";
import { db } from "@/db";
import { jobs } from "@/db/schema";
import { requireAgentToken } from "@/lib/agent-auth";
import { getSetting, setSetting } from "@/lib/settings";
import { maybeLearnStyle } from "@/lib/style-learning";

/** A claim this recent may not be in the agent's list yet (the heartbeat can cross the claim). */
const LOST_CLAIM_GRACE_MS = 60 * 1000;
const LOST_CLAIM_ERROR = "The agent stopped before finishing. Try again.";

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
 *
 * `running` (2026-10-11) lists the jobs the agent is running now. A job still
 * `claimed` that isn't in it (the agent restarted, or its result was lost) is
 * marked failed at once, so a post isn't blocked until the stale sweep. Claims
 * under a minute old are left alone, and an older agent that sends no list
 * changes nothing. One agent per PostEcho, as everywhere.
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
    const running = body && (body as { running?: unknown }).running;
    if (Array.isArray(running) && running.every((id) => typeof id === "string")) {
      await failLostClaims(running as string[]);
    }
    after(() => maybeLearnStyle(db).catch((e) => console.error("style learning:", e)));
    const model = await getSetting(db, "claudeModel");
    return Response.json({ ok: true, claudeModel: CLAUDE_MODELS.has(model) ? model : "sonnet" });
  } catch (e) {
    console.error(e);
    return Response.json({ error: "internal error" }, { status: 500 });
  }
}

async function failLostClaims(running: string[]): Promise<void> {
  const ids = running.filter((id) => /^[0-9a-f-]{36}$/i.test(id));
  await db.update(jobs)
    .set({ status: "failed", result: { error: LOST_CLAIM_ERROR }, finishedAt: new Date() })
    .where(and(
      eq(jobs.status, "claimed"),
      lt(jobs.claimedAt, new Date(Date.now() - LOST_CLAIM_GRACE_MS)),
      ...(ids.length ? [notInArray(jobs.id, ids)] : []),
    ));
}
