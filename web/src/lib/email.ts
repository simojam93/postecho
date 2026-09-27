import { Resend } from "resend";

/**
 * Outbound email (M3 plan, task P3) — one function, one provider (Resend),
 * optional like every integration here: without RESEND_API_KEY the message
 * is written to the server log instead and the caller learns it wasn't
 * sent, so the publish flow still runs end to end in dev.
 *
 * Sender: RESEND_FROM, else Resend's shared test sender. Without a verified
 * domain that shared sender only delivers to the Resend account owner's own
 * address — Settings → notificationEmail must be that address (spec §6.3 /
 * M3 plan). Env is read per call, never at module scope (see lib/session.ts
 * on why).
 */

export type MailMessage = { to: string; subject: string; html: string; text: string };

/** The slice of the `resend` SDK this module uses — what tests fake. */
export type MailClient = {
  emails: {
    send(payload: { from: string; to: string; subject: string; html: string; text: string }): Promise<{
      data: { id: string } | null;
      error: { message: string } | null;
    }>;
  };
};

export type SendMailResult =
  | { sent: true; id: string }
  | { sent: false; reason: string };

export const DEFAULT_FROM = "PostEcho <onboarding@resend.dev>";
export const MAIL_DISABLED_REASON = "RESEND_API_KEY not set";

/** Resend answered with an error (bad key, unverified sender, recipient not allowed, rate limit…). */
export class MailError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MailError";
  }
}

type Env = Record<string, string | undefined>;

/**
 * Sends `message`. `{ sent: false }` only when email isn't configured (the
 * text is logged instead); a provider error THROWS a MailError — the two
 * outcomes differ for the caller (lib/publishers/run.ts): the first still
 * counts as emailed in dev, the second marks the post failed.
 */
export async function sendMail(
  message: MailMessage,
  { env = process.env, client }: { env?: Env; client?: MailClient } = {},
): Promise<SendMailResult> {
  const key = env.RESEND_API_KEY?.trim();
  if (!key) {
    console.info(
      `[email] ${MAIL_DISABLED_REASON} — not sent.\nTo: ${message.to}\nSubject: ${message.subject}\n\n${message.text}`,
    );
    return { sent: false, reason: MAIL_DISABLED_REASON };
  }

  const resend: MailClient = client ?? new Resend(key);
  const from = env.RESEND_FROM?.trim() || DEFAULT_FROM;
  const { data, error } = await resend.emails.send({
    from, to: message.to, subject: message.subject, html: message.html, text: message.text,
  });
  if (error || !data) throw new MailError(`resend: ${error?.message ?? "no message id returned"}`);
  return { sent: true, id: data.id };
}
