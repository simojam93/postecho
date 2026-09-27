import { db } from "@/db";
import { requireSession } from "@/lib/session";
import { isHintId, loadSetupStatus, markHintSeen, markOnboarded, resetHints } from "@/lib/setup";

/**
 * GET /api/setup — what the welcome's "What's connected" step and Settings ›
 * AI tools show (lib/setup.ts): booleans and env var names, never a value.
 */
export async function GET() {
  const denied = await requireSession();
  if (denied) return denied;
  try {
    return Response.json({ status: await loadSetupStatus(db) });
  } catch (e) {
    console.error(e);
    return Response.json({ error: "internal error" }, { status: 500 });
  }
}

/** POST /api/setup — the welcome was finished or closed: `{ onboardedAt }`, the first time it happened. */
/**
 * No body: the welcome is done. `{ hint }`: a tab's first-visit hint was
 * closed. `{ resetHints: true }`: the welcome is shown again, and so are the
 * hints (2026-09-27).
 */
export async function POST(request?: Request) {
  const denied = await requireSession();
  if (denied) return denied;
  try {
    const body = request ? await request.json().catch(() => null) : null;
    if (isHintId(body?.hint)) return Response.json({ seenHints: await markHintSeen(db, body.hint) });
    if (body?.resetHints === true) {
      await resetHints(db);
      return Response.json({ seenHints: [] });
    }
    return Response.json({ onboardedAt: await markOnboarded(db) });
  } catch (e) {
    console.error(e);
    return Response.json({ error: "internal error" }, { status: 500 });
  }
}
