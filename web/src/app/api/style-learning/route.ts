import { z } from "zod";
import { db } from "@/db";
import { requireSession } from "@/lib/session";
import { getSetting, setSetting } from "@/lib/settings";
import { styleLearningStatus } from "@/lib/style-learning";

const Body = z.object({ action: z.enum(["apply", "dismiss"]) }).strict();

/**
 * GET /api/style-learning
 *
 * Settings › Voice's view of learning from the owner's choices
 * (lib/style-learning.ts): the style guide change waiting for them, or how
 * far PostEcho is from looking again.
 */
export async function GET() {
  const denied = await requireSession();
  if (denied) return denied;
  try {
    return Response.json(await styleLearningStatus(db));
  } catch (e) {
    console.error(e);
    return Response.json({ error: "internal error" }, { status: 500 });
  }
}

/**
 * POST /api/style-learning `{ action: "apply" | "dismiss" }`
 *
 * The owner's answer to the proposal ("Proposes, you approve"): apply makes
 * it the style guide, dismiss drops it. Either way it stops waiting. 409 when
 * there's nothing waiting.
 */
export async function POST(request: Request) {
  const denied = await requireSession();
  if (denied) return denied;
  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "bad request" }, { status: 400 });
  try {
    const proposal = await getSetting(db, "styleProposal");
    if (!proposal) return Response.json({ error: "there's no suggestion waiting" }, { status: 409 });
    if (parsed.data.action === "apply") await setSetting(db, "styleGuide", proposal.guide);
    await setSetting(db, "styleProposal", null);
    return Response.json(parsed.data.action === "apply" ? { ok: true, styleGuide: proposal.guide } : { ok: true });
  } catch (e) {
    console.error(e);
    return Response.json({ error: "internal error" }, { status: 500 });
  }
}
