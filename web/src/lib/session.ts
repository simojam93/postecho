import { getIronSession, type SessionOptions } from "iron-session";
import { cookies } from "next/headers";

export type AppSession = { loggedIn?: boolean };

/**
 * Lazy on purpose: this must NOT run at module scope, so that `next build`
 * (which imports route modules to collect page data) never touches
 * `process.env.SESSION_SECRET` before a request actually needs it. Building
 * without the env var must keep working; only a real request without it
 * should fail, and it should fail with a clear message instead of iron-session
 * throwing an opaque error deep inside `getIronSession`.
 */
function getSessionOptions(): SessionOptions {
  const password = process.env.SESSION_SECRET;
  if (!password || password.length < 32) {
    throw new Error(
      "SESSION_SECRET is missing or shorter than 32 characters — set it in web/.env.local or your Vercel env (see web/.env.example)",
    );
  }
  return {
    password,
    cookieName: "postecho_session",
    // iron-session v9 ignores cookieOptions.maxAge for the seal's expiry —
    // `ttl` governs both the seal expiry and the derived cookie Max-Age.
    ttl: 60 * 60 * 24 * 30, // 30 days
    cookieOptions: {
      secure: process.env.NODE_ENV === "production",
      httpOnly: true,
      sameSite: "lax",
    },
  };
}

export async function getSession() {
  return getIronSession<AppSession>(await cookies(), getSessionOptions());
}

/** For route handlers: returns null if authorized, a 401 Response otherwise. */
export async function requireSession(): Promise<Response | null> {
  const session = await getSession();
  if (!session.loggedIn) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  return null;
}

/** Constant-time-ish comparison to avoid trivial timing leaks. */
export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
