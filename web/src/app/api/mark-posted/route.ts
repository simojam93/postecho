import { z } from "zod";
import { db } from "@/db";
import { verifyMarkPostedSig } from "@/lib/publishers";
import { markPostedById } from "@/lib/publishers/run";

/**
 * The "Mark as posted" link in the due-post email (lib/publishers/email.ts)
 * is signed with SESSION_SECRET (lib/publishers/index.ts's markPostedUrl /
 * verifyMarkPostedSig) so it works on the phone with no session — but a
 * GET must not have side effects: mail clients and link scanners (Gmail's
 * safe-browsing prefetch, Outlook SafeLinks) open links on the owner's
 * behalf, and a post would be marked posted before it was. So:
 *
 * - GET /api/mark-posted?id&sig only checks the signature and 302s to the
 *   /mark-posted confirmation page, carrying id+sig along; nothing changes.
 * - POST /api/mark-posted { id, sig } — sent by that page's confirm button —
 *   does the work: the row becomes `posted_manually` with `publishedAt` now
 *   and its pending QStash message is cancelled (markPostedById). Idempotent.
 *
 * A missing/forged signature AND an unknown id both answer 404, deliberately
 * the same: the endpoint confirms nothing about which ids exist. Both
 * methods are public in proxy.ts; the signature is their gate.
 */
function validate(id: string, sig: string): boolean {
  return z.uuid().safeParse(id).success && verifyMarkPostedSig(id, sig);
}

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const id = params.get("id") ?? "";
  const sig = params.get("sig") ?? "";
  if (!validate(id, sig)) return Response.json({ error: "not found" }, { status: 404 });
  const target = new URL("/mark-posted", request.url);
  target.searchParams.set("id", id);
  target.searchParams.set("sig", sig);
  return Response.redirect(target, 302);
}

const Body = z.object({ id: z.uuid(), sig: z.string().min(1) }).strict();

export async function POST(request: Request) {
  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success || !verifyMarkPostedSig(parsed.data.id, parsed.data.sig)) {
    return Response.json({ error: "not found" }, { status: 404 });
  }
  try {
    const post = await markPostedById(db, parsed.data.id);
    if (!post) return Response.json({ error: "not found" }, { status: 404 });
    return Response.json({ ok: true, post });
  } catch (e) {
    console.error(e);
    return Response.json({ error: "internal error" }, { status: 500 });
  }
}
