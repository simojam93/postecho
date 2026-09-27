import { Client, Receiver } from "@upstash/qstash";

/**
 * Upstash QStash — the timer behind scheduled posts (M3 plan, task P2).
 * When a post is scheduled, one message is published with `notBefore` =
 * slot − lead time, addressed to POST /api/publish/[id]; QStash delivers it
 * (signed) when the time comes, with the Mac off. This module is the only
 * place that talks to the SDK: a thin wrapper over the two calls the app
 * needs plus signature verification for the webhook, every env var read
 * lazily (never at module scope — same rule as lib/session.ts) so `next
 * build` and tests without keys never trip over it.
 *
 * Everything is optional: without QSTASH_TOKEN `createQstash` returns a
 * `disabled` value, scheduling still works (the row just has no timer —
 * `externalId` stays null) and POST /api/scheduled-posts/[id]/run fires the
 * publish step by hand.
 */

/** The slice of the SDK's `Client` this module uses — what tests fake. */
export type QstashMessageClient = {
  publishJSON(request: {
    url: string;
    body?: unknown;
    /** Unix timestamp in SECONDS (the SDK's unit). */
    notBefore?: number;
    retries?: number;
  }): Promise<{ messageId: string }>;
  messages: {
    cancel(messageId: string): Promise<unknown>;
  };
};

/** Verifies one delivery — the SDK's `Receiver`, or a fake in tests. */
export type QstashReceiver = {
  verify(request: { signature: string; body: string; url?: string }): Promise<boolean>;
};

export type Qstash =
  | { enabled: false; reason: string }
  | {
      enabled: true;
      /** Publishes one delayed message; resolves to its QStash message id (stored as the row's `externalId`). */
      scheduleMessage(args: { url: string; notBeforeMs: number; body?: unknown }): Promise<string>;
      /** Cancels a pending message. A message QStash no longer knows (already delivered, already canceled) is a no-op. */
      deleteMessage(messageId: string): Promise<void>;
    };

/** What Settings/Plan show next to a queued post that has no timer. */
export const QSTASH_DISABLED_REASON = "QSTASH_TOKEN not set — the timer is off; run scheduled posts by hand";
/** Same, when the token is there but QStash could never call us back. */
export const QSTASH_NOT_PUBLIC_REASON =
  "PUBLIC_BASE_URL is not a public https URL — the timer is off in this environment; run scheduled posts by hand";

/**
 * QStash refuses loopback/private destinations outright (live, 2026-09-22:
 * `invalid destination url: endpoint resolves to a loopback address: ::1`
 * for the dev default http://localhost:3210), which turned every dev
 * schedule into a 500. So the timer is only "enabled" when the URL it would
 * publish to is one QStash can reach: https, and a host that is not
 * localhost / a loopback or link-local literal / *.local. Anything else
 * degrades to disabled with QSTASH_NOT_PUBLIC_REASON.
 */
export function isPublicBaseUrl(raw: string | undefined): boolean {
  if (!raw?.trim()) return false;
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return false;
  }
  if (url.protocol !== "https:") return false;
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) return false;
  if (host === "::1" || host === "0.0.0.0" || host.startsWith("127.") || host.startsWith("169.254.")) return false;
  if (/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host)) return false;
  return true;
}
/** How many times QStash re-delivers on a non-2xx response before parking the message in its DLQ. */
const RETRIES = 3;

type Env = Record<string, string | undefined>;

function isNotFound(e: unknown): boolean {
  // The SDK's QstashError carries the HTTP status; a 404 means the message
  // is gone already (delivered, or canceled from the console) — exactly the
  // outcome deleteMessage wants, so it isn't an error here.
  return typeof e === "object" && e !== null && (e as { status?: unknown }).status === 404;
}

/**
 * The timer for `env` (default: the real process.env, read now): disabled
 * without QSTASH_TOKEN, otherwise wrapping `client` — the SDK's `Client`
 * built from the token and QSTASH_URL when none is injected. QSTASH_URL is
 * the token's REGIONAL endpoint (the owner's is
 * https://qstash-eu-central-1.upstash.io): passed as `baseUrl` because the
 * SDK otherwise targets the global endpoint, which rejects a regional token.
 */
export function createQstash(env: Env = process.env, client?: QstashMessageClient): Qstash {
  const token = env.QSTASH_TOKEN?.trim();
  if (!token) return { enabled: false, reason: QSTASH_DISABLED_REASON };
  if (!isPublicBaseUrl(env.PUBLIC_BASE_URL)) return { enabled: false, reason: QSTASH_NOT_PUBLIC_REASON };

  const baseUrl = env.QSTASH_URL?.trim();
  const sdk: QstashMessageClient = client ?? new Client({ token, ...(baseUrl ? { baseUrl } : {}) });

  return {
    enabled: true,
    async scheduleMessage({ url, notBeforeMs, body }) {
      const { messageId } = await sdk.publishJSON({
        url,
        body: body ?? {},
        notBefore: Math.floor(notBeforeMs / 1000),
        retries: RETRIES,
      });
      return messageId;
    },
    async deleteMessage(messageId) {
      try {
        // `messages.delete` is deprecated in @upstash/qstash 2.11 — `cancel` is the current call.
        await sdk.messages.cancel(messageId);
      } catch (e) {
        if (isNotFound(e)) return;
        throw e;
      }
    },
  };
}

let override: Qstash | null = null;

/**
 * Test-only override for what `getQstash` returns — the same module-level
 * setter shape as lib/slop.ts's setSlopDeps, for callers (lib/schedule.ts,
 * the mark-posted route) that resolve the timer themselves rather than
 * receiving one. `setQstashForTests(null)` restores the env-driven default.
 */
export function setQstashForTests(next: Qstash | null): void {
  override = next;
}

/** The app's timer: the test override if set, else `createQstash(process.env)` — evaluated per call, so env is read lazily. */
export function getQstash(): Qstash {
  return override ?? createQstash(process.env);
}

/**
 * Best-effort cancel of the QStash message behind a row that no longer
 * needs it (canceled, or posted before the slot). Nothing to do for a null
 * id or a disabled timer; a failure is logged and swallowed — the row's new
 * status already makes a late delivery a no-op (POST /api/publish/[id]
 * answers 200 to a row that isn't queued), so the owner's action must not
 * fail because Upstash was unreachable for a second.
 */
export async function forgetMessage(qstash: Qstash, messageId: string | null | undefined): Promise<void> {
  if (!messageId || !qstash.enabled) return;
  try {
    await qstash.deleteMessage(messageId);
  } catch (e) {
    console.warn(`[qstash] could not cancel message ${messageId}:`, e instanceof Error ? e.message : e);
  }
}

/**
 * Whether `signature` (the `Upstash-Signature` header) is QStash's genuine
 * signature over `body` (the RAW request body) for a message published to
 * `url` — verified with QSTASH_CURRENT_SIGNING_KEY / QSTASH_NEXT_SIGNING_KEY
 * (both keys, so a key rotation in the Upstash console never locks the
 * webhook out). Fails closed: no signature, no keys, a malformed token, a
 * body that doesn't hash to the token's `body` claim, a `sub` other than
 * `url`, or an expired token are all `false`. `receiver` is injectable for
 * tests; the default is the SDK's `Receiver`.
 */
export async function verifyQstashSignature(
  { signature, body, url }: { signature: string; body: string; url?: string },
  env: Env = process.env,
  receiver?: QstashReceiver,
): Promise<boolean> {
  const currentSigningKey = env.QSTASH_CURRENT_SIGNING_KEY?.trim();
  const nextSigningKey = env.QSTASH_NEXT_SIGNING_KEY?.trim();
  if (!signature || !currentSigningKey || !nextSigningKey) return false;
  // devMode: false — never let a stray QSTASH_DEV env var swap the real keys for the local dev server's.
  const verifier = receiver ?? new Receiver({ currentSigningKey, nextSigningKey, devMode: false });
  try {
    return await verifier.verify({ signature, body, url });
  } catch {
    return false;
  }
}
