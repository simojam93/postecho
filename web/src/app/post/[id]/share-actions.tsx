"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { composerUrl as linkedinComposerUrl } from "@/lib/publishers/linkedin";
import { composerUrl as xComposerUrl } from "@/lib/publishers/x";

/**
 * The share page's controls (app/post/[id]/page.tsx): ONE button per post,
 * "Post on X" / "Post on LinkedIn", plus "Mark as posted" (owner direction,
 * 2026-09-22: "mi basta solo quel tasto … mi serve che vada su iPhone").
 *
 * The button does the right thing per device, decided on the client:
 * - Desktop: opens the platform's web composer prefilled (owner-verified on
 *   the Mac for both platforms).
 * - Phone, X: opens the X app's composer directly through its `twitter://post`
 *   scheme — the https intent inside a mail app's in-app browser lands on a
 *   logged-out x.com (owner test).
 * - Phone, LinkedIn: the LinkedIn app ignores the web composer's text
 *   parameter (owner test), so the button opens the native share sheet
 *   (`navigator.share({ text })`); picking LinkedIn there opens its composer
 *   prefilled. Falls back to the web composer where the sheet is unavailable.
 * If nothing seems to have happened after a moment, a small fallback row
 * appears (share sheet / the website / copy) — each a fresh tap, since the
 * share sheet and window.open need user activation.
 *
 * Only x.ts / linkedin.ts are imported (pure modules) — lib/publishers/index.ts
 * pulls in node:crypto and must stay on the server.
 */

type Platform = "x" | "linkedin";

const POST_ON: Record<Platform, string> = { x: "Post on X", linkedin: "Post on LinkedIn" };
const SITE: Record<Platform, string> = { x: "x.com", linkedin: "linkedin.com" };
const FALLBACK_AFTER_MS = 2000;
const COPIED_MS = 1500;

const primaryCls =
  "flex min-h-12 w-full items-center justify-center rounded-full bg-accent px-6 py-3 text-base font-medium text-accent-ink disabled:opacity-50";
const pillCls =
  "flex min-h-11 w-full items-center justify-center rounded-full border border-border px-6 py-3 text-sm text-text-dim hover:text-text disabled:opacity-50";
const linkCls = "underline hover:text-text";

/** The web composer URL, or null when the platform would refuse the text (x.ts throws over 280). */
function composerUrlFor(platform: Platform, text: string): string | null {
  try {
    return platform === "x" ? xComposerUrl(text) : linkedinComposerUrl(text);
  } catch {
    return null;
  }
}

/** The X app's own composer (iOS/Android) — the scheme the app still registers. */
function xAppUrl(text: string): string {
  return `twitter://post?message=${encodeURIComponent(text)}`;
}

// Browser-only facts, read after hydration (false on the server) so the
// markup never has to guess the device.
const subscribeNever = () => () => {};
const canShareNow = () => typeof navigator !== "undefined" && "share" in navigator;
const isPhoneNow = () =>
  typeof navigator !== "undefined" &&
  (/iPhone|iPad|iPod|Android/i.test(navigator.userAgent) ||
    (typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches && !/Macintosh/.test(navigator.userAgent)));
const onServer = () => false;

export function ShareActions({ id, sig, platform, text }: { id: string; sig: string; platform: Platform; text: string }) {
  const canShare = useSyncExternalStore(subscribeNever, canShareNow, onServer);
  const isPhone = useSyncExternalStore(subscribeNever, isPhoneNow, onServer);
  const [fallback, setFallback] = useState(false);
  const [copied, setCopied] = useState(false);
  const [mark, setMark] = useState<"idle" | "busy" | "done" | "error">("idle");
  const composerUrl = composerUrlFor(platform, text);
  const autoOpened = useRef(false);

  // On a phone the X app can be opened the moment the page loads — the owner
  // asked to skip the extra tap (2026-09-23). Only X: its app scheme needs no
  // user gesture, while LinkedIn's share sheet does (navigator.share
  // requires transient activation), so LinkedIn stays one tap. The button
  // stays rendered underneath as the fallback for browsers that block
  // scheme navigations without a tap. No setState here (eslint's
  // set-state-in-effect rule) — the fallback row arms itself via the timer.
  useEffect(() => {
    if (!isPhone || platform !== "x" || !composerUrl || autoOpened.current) return;
    autoOpened.current = true;
    window.location.href = xAppUrl(text);
    const t = setTimeout(() => { if (document.visibilityState === "visible") setFallback(true); }, FALLBACK_AFTER_MS);
    return () => clearTimeout(t);
  }, [isPhone, platform, composerUrl, text]);

  async function shareSheet(): Promise<boolean> {
    if (!canShare) return false;
    try {
      await navigator.share({ text });
      return true;
    } catch {
      return false; // dismissed (AbortError) or refused — the fallback row covers it
    }
  }

  function openWeb() {
    if (composerUrl) window.open(composerUrl, "_blank", "noopener,noreferrer");
  }

  async function postOn() {
    // A hidden-page check after a moment tells us whether an app took over.
    const armFallback = () => setTimeout(() => { if (document.visibilityState === "visible") setFallback(true); }, FALLBACK_AFTER_MS);
    if (!isPhone) {
      openWeb();
      armFallback();
      return;
    }
    if (platform === "x") {
      window.location.href = xAppUrl(text);
      armFallback();
      return;
    }
    if (!(await shareSheet())) openWeb();
    armFallback();
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), COPIED_MS);
    } catch {
      setFallback(true);
    }
  }

  async function markPosted() {
    if (mark === "busy" || mark === "done") return;
    setMark("busy");
    try {
      const res = await fetch("/api/mark-posted", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id, sig }),
      });
      setMark(res.ok ? "done" : "error");
    } catch {
      setMark("error");
    }
  }

  if (mark === "done") {
    return (
      <div className="space-y-1 text-center">
        <p className="text-lg font-semibold tracking-tight">Marked as posted ✓</p>
        <p className="text-sm text-text-dim">Recorded in your Calendar. You can close this tab.</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <button type="button" onClick={postOn} className={primaryCls}>
        {POST_ON[platform]}
      </button>
      {!composerUrl && platform === "x" && (
        <p className="text-sm text-danger">This text is over 280 characters — trim it in Compose before posting on X.</p>
      )}
      {fallback && (
        <p className="text-center text-sm text-text-dim">
          Didn&apos;t open?{" "}
          {canShare && (
            <>
              <button type="button" onClick={shareSheet} className={linkCls}>Share…</button>
              {" · "}
            </>
          )}
          {composerUrl && (
            <>
              <a href={composerUrl} target="_blank" rel="noopener noreferrer" className={linkCls}>Open {SITE[platform]}</a>
              {" · "}
            </>
          )}
          <button type="button" onClick={copy} className={linkCls}>{copied ? "Copied" : "Copy text"}</button>
        </p>
      )}
      <button type="button" onClick={markPosted} disabled={mark === "busy"} className={pillCls}>
        {mark === "busy" ? "Saving…" : "Mark as posted"}
      </button>
      {mark === "error" && <p className="text-sm text-danger">Could not record it. Open the link from the email again.</p>}
    </div>
  );
}
