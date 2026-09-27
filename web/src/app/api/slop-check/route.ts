import { z } from "zod";
import { db } from "@/db";
import { getSlopClient, runSlopCheck } from "@/lib/slop";
import { requireSession } from "@/lib/session";

const Body = z.object({
  text: z.string().min(1).max(5000),
  platform: z.enum(["x", "linkedin"]).optional(),
  draftId: z.uuid().optional(),
}).strict();

/**
 * POST /api/slop-check
 *
 * The Create tab's AI-slop check (M2 plan, spec §11 item 3, "Plus" note):
 * runs jev-judge's checkSlop directly from Vercel — session-gated, no
 * agent involved, works with the owner's Mac off. Optional feature: 503s
 * when `TYPESAFE_API_KEY` isn't configured rather than 500ing, since the
 * key is opt-in (see lib/slop.ts's getSlopClient). When `draftId` is given,
 * the result is also persisted onto that draft's `meta.slop`.
 */
export async function POST(request: Request) {
  const denied = await requireSession();
  if (denied) return denied;

  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "bad request" }, { status: 400 });

  const client = await getSlopClient(db);
  if (!client) {
    return Response.json({ error: "slop check disabled: TYPESAFE_API_KEY not set" }, { status: 503 });
  }

  try {
    const slop = await runSlopCheck(db, client, parsed.data);
    return Response.json({ slop });
  } catch (e) {
    console.error(e);
    return Response.json({ error: "internal error" }, { status: 500 });
  }
}
