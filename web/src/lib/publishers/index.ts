import { createHmac } from "node:crypto";
import { safeEqual } from "@/lib/session";
import * as linkedin from "./linkedin";
import * as x from "./x";

export type Platform = "x" | "linkedin";

/**
 * One publisher per platform (M3 plan): what putting a due post in front
 * of the owner needs — the label for the email and the share page, and the
 * composer URL the share page's "Open on x.com" / "Open linkedin.com" link
 * opens (the desktop path; on the phone the page's Share… hands the text to
 * the platform's own app instead — see app/post/[id]). Both current
 * publishers are human-in-the-loop (owner decision 2026-09-22); an
 * API-backed one (the deferred LinkedIn P4) would add a `publish()` next to
 * `composerUrl` behind this same map, leaving the webhook platform-agnostic.
 */
export type Publisher = {
  platform: Platform;
  /** Human label: "X", "LinkedIn" — the email's section titles and subject. */
  label: string;
  /** The platform's composer prefilled with `text`; throws when the text can't be posted there (X > 280). */
  composerUrl(text: string): string;
};

export const PUBLISHERS: Record<Platform, Publisher> = {
  x: { platform: "x", label: "X", composerUrl: x.composerUrl },
  linkedin: { platform: "linkedin", label: "LinkedIn", composerUrl: linkedin.composerUrl },
};

export function publisherFor(platform: Platform): Publisher {
  return PUBLISHERS[platform];
}

type Env = Record<string, string | undefined>;

/** Where this deployment is reachable from outside: QStash calls it, the email links into it. Dev default. */
export const DEFAULT_PUBLIC_BASE_URL = "http://localhost:3210";

/** PUBLIC_BASE_URL without a trailing slash, or the dev default. Read per call (see lib/session.ts on env at module scope). */
export function publicBaseUrl(env: Env = process.env): string {
  return (env.PUBLIC_BASE_URL?.trim() || DEFAULT_PUBLIC_BASE_URL).replace(/\/+$/, "");
}

/**
 * The QStash target for a scheduled post — POST /api/publish/[id]. Built
 * here (not from an incoming request) because it is also the `sub` claim
 * the webhook demands of a delivery's signature: what we published to is
 * exactly what a genuine delivery was signed for.
 */
export function publishWebhookUrl(id: string, env: Env = process.env): string {
  return `${publicBaseUrl(env)}/api/publish/${encodeURIComponent(id)}`;
}

/** hex HMAC-SHA256(id, SESSION_SECRET); null when the secret is unset — nothing can be signed, so nothing verifies. */
export function markPostedSig(id: string, env: Env = process.env): string | null {
  const secret = env.SESSION_SECRET;
  if (!secret) return null;
  return createHmac("sha256", secret).update(id).digest("hex");
}

/**
 * The email's "Mark as posted" link for a scheduled post: GET
 * /api/mark-posted?id=…&sig=…, which records the post and lands on the
 * /mark-posted confirmation page. Signed with SESSION_SECRET so it works
 * from the phone with no login, and only for this one id.
 */
export function markPostedUrl(id: string, env: Env = process.env): string {
  const sig = markPostedSig(id, env);
  if (!sig) throw new Error("SESSION_SECRET is not set — the mark-as-posted link cannot be signed");
  return `${publicBaseUrl(env)}/api/mark-posted?id=${encodeURIComponent(id)}&sig=${sig}`;
}

/**
 * The email's "Post on …" button for a scheduled post: the public share
 * page /post/<id>?sig=…, where the phone's native share sheet (or, on a
 * desktop, the composer link) takes over. Owner test on the iPhone,
 * 2026-09-22: a composer URL straight from the email opens in the mail
 * app's in-app browser, logged out of x.com, and the LinkedIn app ignores
 * the prefill parameter. Signed exactly like the mark-as-posted link — the
 * same HMAC over the id, checked by verifyMarkPostedSig — so one signature
 * per row serves both the page and the mark, and the page can hand its own
 * `sig` to POST /api/mark-posted.
 */
export function postPageUrl(id: string, env: Env = process.env): string {
  const sig = markPostedSig(id, env);
  if (!sig) throw new Error("SESSION_SECRET is not set — the post page link cannot be signed");
  return `${publicBaseUrl(env)}/post/${encodeURIComponent(id)}?sig=${sig}`;
}

const HEX_SHA256 = /^[0-9a-f]{64}$/;

/** Whether `sig` is the genuine signature for `id` — constant-time compare (lib/session.ts's safeEqual). */
export function verifyMarkPostedSig(id: string, sig: string, env: Env = process.env): boolean {
  const expected = markPostedSig(id, env);
  return expected !== null && HEX_SHA256.test(sig) && safeEqual(sig, expected);
}
