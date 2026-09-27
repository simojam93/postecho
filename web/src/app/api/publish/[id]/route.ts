import { z } from "zod";
import { db } from "@/db";
import { publishWebhookUrl } from "@/lib/publishers";
import { publishDue, publishOutcomeResponse, type PublishMode } from "@/lib/publishers/run";
import { verifyQstashSignature } from "@/lib/qstash";
import { requireSession } from "@/lib/session";

const unauthorized = () => Response.json({ error: "unauthorized" }, { status: 401 });
const notFound = () => Response.json({ error: "not found" }, { status: 404 });

/**
 * POST /api/publish/:id
 *
 * The publish step for a scheduled post (M3 plan, P2/P3 —
 * lib/publishers/run.ts's publishDue): the due-post email with a "Post on
 * X" / "Post on LinkedIn" button per row due in the same slot, then the
 * rows become `emailed`. Two callers, two gates, either one suffices:
 *
 * - QStash, when the timer fires: the delivery carries an `Upstash-Signature`
 *   header, verified against the RAW body and the very url the message was
 *   published to (lib/qstash.ts's verifyQstashSignature). Mode `due`: only a
 *   `queued` row is acted on — a duplicate or late delivery finds it
 *   `emailed` and gets a 200 no-op, never a second email.
 * - The owner, with a session: POST /api/scheduled-posts/[id]/run and Plan's
 *   Resend/Retry. Mode `resend`: an `emailed` or `failed` row goes out again.
 *
 * Public in proxy.ts (its own auth is the gate, like /api/agent). 401 when
 * neither gate opens; 404 for a malformed or unknown id. Everything else is
 * 200 with `{ post, … }` — including a recorded failure (`failed` + `error`
 * on the row): QStash retries only non-2xx answers, so a failure that will
 * repeat must not be one. 500 only for an exception before any state
 * changed (the db is down), which IS worth a retry.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const validId = z.uuid().safeParse(id).success;

  let mode: PublishMode;
  // QStash's own id for this delivery: a stale timer of a moved post is skipped (lib/publishers/run.ts).
  const messageId = request.headers.get("upstash-message-id");
  const signature = request.headers.get("upstash-signature");
  if (signature !== null) {
    const body = await request.text();
    if (!validId || !(await verifyQstashSignature({ signature, body, url: publishWebhookUrl(id) }))) {
      return unauthorized();
    }
    mode = "due";
  } else {
    const denied = await requireSession();
    if (denied) return denied;
    mode = "resend";
  }
  if (!validId) return notFound();

  try {
    return publishOutcomeResponse(await publishDue(db, id, { mode, messageId: mode === "due" ? messageId : null }));
  } catch (e) {
    console.error(e);
    return Response.json({ error: "internal error" }, { status: 500 });
  }
}
