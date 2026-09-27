import { db } from "@/db";
import { requireAgentToken } from "@/lib/agent-auth";
import { referencesForAgent } from "@/lib/library";
import { getSetting } from "@/lib/settings";

/**
 * GET /api/agent/profile
 *
 * The tone/identity profile the agent injects into every generation/revision
 * prompt (systemPrompt(profile) — see docs/plans/
 * 2026-09-21-m2-agent-generation.md task B5). Bearer-gated like the other
 * agent protocol endpoints (see @/lib/agent-auth) — this is a private worker
 * surface, not a session-gated one.
 *
 * Deliberately a narrow, explicit allowlist rather than "every setting minus
 * a blocklist": notificationEmail (and anything else in SETTING_DEFAULTS not
 * listed below, e.g. leadTimeMinutes, defaultSlots, scout tuning) must never
 * reach the agent, and an allowlist means a future key added to
 * SETTING_DEFAULTS doesn't leak here by default.
 */
export async function GET(request: Request) {
  const denied = requireAgentToken(request);
  if (denied) return denied;

  try {
    const [
      identityName, identityHandle, toneExamplesX, toneExamplesLinkedin,
      toneForm, styleGuide, topics, imageSpecs, references,
    ] = await Promise.all([
      getSetting(db, "identityName"),
      getSetting(db, "identityHandle"),
      getSetting(db, "toneExamplesX"),
      getSetting(db, "toneExamplesLinkedin"),
      getSetting(db, "toneForm"),
      getSetting(db, "styleGuide"),
      getSetting(db, "topics"),
      getSetting(db, "imageSpecs"),
      getSetting(db, "references"),
    ]);
    return Response.json({
      identityName, identityHandle, toneExamplesX, toneExamplesLinkedin,
      toneForm, styleGuide, topics, imageSpecs,
      // The enabled reference material, within its budget (lib/library.ts).
      references: referencesForAgent(references),
    });
  } catch (e) {
    console.error(e);
    return Response.json({ error: "internal error" }, { status: 500 });
  }
}
