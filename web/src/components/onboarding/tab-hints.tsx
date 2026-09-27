"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import type { HintId } from "@/lib/setup";
import { SHOW_WELCOME_EVENT } from "./welcome";

/**
 * First-time things (owner, 2026-09-27: "un'animazione di highlight la prima
 * volta"): Find Ideas' + More sources glows until it's first touched, and
 * Settings opens on Start here once. Write's and Calendar's own pills went
 * the same night ("non aggiunge nulla"): the app's tooltips say what each
 * control does. The layout hands in what's already been seen (kv seenHints);
 * the welcome, shown again, brings it all back.
 */
const HintsContext = createContext<{ seen: ReadonlySet<HintId>; close: (id: HintId) => void } | null>(null);

const JSON_HEADERS = { "Content-Type": "application/json" };

function post(body: unknown) {
  void fetch("/api/setup", { method: "POST", headers: JSON_HEADERS, body: JSON.stringify(body) })
    .catch((e) => console.error("hints: couldn't save it:", e));
}

export function HintsProvider({ seen: saved, children }: { seen: HintId[]; children?: ReactNode }) {
  const [seen, setSeen] = useState<ReadonlySet<HintId>>(() => new Set(saved));

  useEffect(() => {
    const reset = () => {
      setSeen(new Set());
      post({ resetHints: true });
    };
    window.addEventListener(SHOW_WELCOME_EVENT, reset);
    return () => window.removeEventListener(SHOW_WELCOME_EVENT, reset);
  }, []);

  const value = useMemo(() => ({
    seen,
    close: (id: HintId) => {
      setSeen((current) => new Set([...current, id]));
      post({ hint: id });
    },
  }), [seen]);
  return <HintsContext.Provider value={value}>{children}</HintsContext.Provider>;
}

// The first-time glow's keyframes, hoisted and deduped by React 19 like the progress bar's:
// a silver ring (the accent, #e6e8ec) that swells and fades.
const GLOW_CSS = "@keyframes postecho-glow{0%,100%{box-shadow:0 0 0 0 rgb(230 232 236 / 0.4)}60%{box-shadow:0 0 0 6px rgb(230 232 236 / 0)}}";
const GLOW_CLS = "animate-[postecho-glow_1.8s_ease-in-out_infinite] motion-reduce:animate-none";

/** Whether `id` is still unseen, and the call that marks it seen — for Settings' Start here. */
export function useHintSeen(id: HintId): { unseen: boolean; markSeen: () => void } {
  const hints = useContext(HintsContext);
  const markSeen = useCallback(() => hints?.close(id), [hints, id]);
  return { unseen: Boolean(hints && !hints.seen.has(id)), markSeen };
}

/** Whether `id` was still unseen when this mounted, and the call that marks it seen (the first touch). */
function useFirstTime(id: HintId) {
  const hints = useContext(HintsContext);
  const [freshAtMount] = useState(() => Boolean(hints && !hints.seen.has(id)));
  const [touched, setTouched] = useState(false);
  const touch = () => {
    if (!freshAtMount || touched) return;
    setTouched(true);
    hints?.close(id);
  };
  return { freshAtMount, glowing: freshAtMount && !touched, touch };
}

/** A pill that glows the first time, until it's hovered or focused (Find Ideas' + More sources). */
export function GlowOnce({ id, children }: { id: HintId; children?: ReactNode }) {
  const { glowing, touch } = useFirstTime(id);
  return (
    <span onPointerEnter={touch} onFocus={touch} className={`inline-flex shrink-0 rounded-full ${glowing ? GLOW_CLS : ""}`}>
      {glowing && <style href="postecho-glow" precedence="default">{GLOW_CSS}</style>}
      {children}
    </span>
  );
}
