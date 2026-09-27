"use client";

import { useEffect, useRef, useState } from "react";
import { nextSlopCheck, takesOf } from "./post-state";
import type { Draft } from "./types";

const JSON_HEADERS = { "Content-Type": "application/json" };

// POST /api/slop-check 503s when TYPESAFE_API_KEY isn't configured — an
// opt-in feature (see the route). One 503 turns the background checks off
// for the rest of the browser session, silently: the flag lives at module
// level so leaving Write and coming back doesn't ask again.
let unavailableThisSession = false;

/**
 * AI-style on every take (M3.5 plan, task U2 — owner: "abbiamo perso la
 * parte di AI slop?"). Scores, in the background and strictly one at a
 * time, each kept/candidate draft of the post that has no persisted
 * `meta.slop` yet: POST /api/slop-check with the take's X text (LinkedIn
 * when X is missing — post-state.ts's slopCheckTarget), which persists the
 * result on the draft; `onChecked` then reloads the drafts so the card's
 * SlopBadge reads the truth from `meta.slop`. Returns the id of the take
 * being scored, for the card's "Checking AI-style…" hint.
 *
 * Which take is next is derived from the drafts + the attempted set on every
 * render (post-state.ts's nextSlopCheck), so the hint and the request always
 * agree without extra state; a ref keeps at most one request in flight
 * across the re-renders the 3-second poll causes. A failed check (5xx,
 * network) is not retried this page-visit; a 503 stops the queue for the
 * session with no error UI.
 */
export function useSlopQueue(drafts: Draft[] | null, onChecked: () => void): string | null {
  const [attempted, setAttempted] = useState<ReadonlySet<string>>(() => new Set());
  const [unavailable, setUnavailable] = useState(() => unavailableThisSession);
  const inFlight = useRef<string | null>(null);

  const next = drafts && !unavailable ? nextSlopCheck(takesOf(drafts), attempted) : null;

  useEffect(() => {
    if (!drafts || unavailable || inFlight.current) return;
    const target = nextSlopCheck(takesOf(drafts), attempted);
    if (!target) return;
    inFlight.current = target.draftId;
    (async () => {
      let gotUnavailable = false;
      try {
        const res = await fetch("/api/slop-check", {
          method: "POST",
          headers: JSON_HEADERS,
          body: JSON.stringify({ text: target.text, platform: target.platform, draftId: target.draftId }),
        });
        gotUnavailable = res.status === 503;
        if (!res.ok && !gotUnavailable) console.error(`slop check failed for take ${target.draftId} (${res.status})`);
      } catch (e) {
        console.error("slop check failed:", e);
      }
      inFlight.current = null;
      if (gotUnavailable) {
        unavailableThisSession = true;
        setUnavailable(true);
        return;
      }
      setAttempted((current) => new Set(current).add(target.draftId));
      onChecked();
    })();
  }, [drafts, attempted, unavailable, onChecked]);

  return next?.draftId ?? null;
}
