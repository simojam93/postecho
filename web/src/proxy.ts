import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

// Cookie presence check only (fast). Every page/handler still verifies
// the sealed session server-side via requireSession/getSession.
export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const isPublic =
    pathname === "/login" ||
    pathname === "/api/login" ||
    pathname === "/api/logout" || // destroying a nonexistent session is a safe no-op
    pathname === "/api/cron/scout" || // bearer CRON_SECRET, set by Vercel Cron
    pathname.startsWith("/api/ideas") || // has its own token/session logic
    pathname.startsWith("/api/agent") || // bearer AGENT_TOKEN
    pathname.startsWith("/api/publish") || // QStash signature or session — see api/publish/[id]
    pathname === "/api/mark-posted" || // HMAC-signed link from the due-post email — see lib/publishers
    pathname === "/mark-posted" || // the page that link lands on, opened on the phone with no session
    pathname.startsWith("/post/"); // the share page the email's "Post on …" button opens, same signature — see app/post/[id]

  const hasCookie = request.cookies.has("postecho_session");
  if (!isPublic && !hasCookie) {
    // API routes get a plain 401 (a fetch()/agent caller can't follow a
    // redirect into an HTML login page); page routes still redirect so a
    // human hitting a bare URL lands on the login screen.
    if (pathname.startsWith("/api/")) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
    return NextResponse.redirect(new URL("/login", request.url));
  }
  return NextResponse.next();
}

// Next.js 16 renamed `middleware.ts`'s `config` export convention to live in
// `proxy.ts`, but the export itself is still named `config` (not
// `proxyConfig` — verified against the bundled Next 16.3.5 docs at
// node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/proxy.md,
// which documents `export const config = { matcher: ... }`).
//
// The app icons stay outside it (2026-09-23): the login page links
// /icon.svg and /apple-icon.png, and a visitor without a session was being
// redirected to /login for them, so only the favicon ever showed there.
export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|icon.svg|apple-icon.png|icons).*)"],
};
