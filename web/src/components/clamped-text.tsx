"use client";

import { useCallback, useState, type ReactNode } from "react";

// Literal class names, so Tailwind compiles each one.
const CLAMP = { 2: "line-clamp-2", 3: "line-clamp-3", 4: "line-clamp-4", 5: "line-clamp-5", 8: "line-clamp-8" } as const;
export type ClampLines = keyof typeof CLAMP;

/**
 * A paragraph clamped to a few lines, with "more" / "less" wherever the text
 * is actually cut (owner, 2026-09-25: "mi aggiungi il more dappertutto? alcune
 * di queste cose non ci sono" — a character count missed short texts that
 * still wrap past the clamp on a narrow card). Measured, not guessed: the
 * paragraph's full height against its clamped box, when it's attached and
 * whenever its size changes. `likely` is the guess a server render shows.
 */
export function ClampedText({ lines, text, likely = false, className = "", children }: {
  lines: ClampLines;
  /** The text shown — measured again when it changes. */
  text: string;
  likely?: boolean;
  className?: string;
  /** What to render instead of the plain text (links in it, say); `text` still decides the measuring. */
  children?: ReactNode;
}) {
  const clampCls = CLAMP[lines];
  const [expanded, setExpanded] = useState(false);
  const [cut, setCut] = useState(likely);

  // Measured the moment the paragraph is attached — synchronously, before it's
  // painted, so the toggle is right from the first frame (and in a tab that
  // isn't on screen) — then again whenever its box changes size. A new text
  // gives a new callback, so it's attached, and measured, again. Only while
  // clamped: expanded, nothing is cut, and "less" must stay.
  const measureRef = useCallback((el: HTMLParagraphElement | null) => {
    if (!el || !text) return;
    const measure = () => {
      if (el.classList.contains(clampCls)) setCut(el.scrollHeight > el.clientHeight + 1);
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [clampCls, text]);

  return (
    <div className="min-w-0">
      <p ref={measureRef} className={`${className} ${expanded ? "" : clampCls}`}>{children ?? text}</p>
      {(cut || expanded) && (
        <button type="button" onClick={() => setExpanded((open) => !open)} className="mt-1 text-xs text-text-dim hover:text-text">
          {expanded ? "less" : "more"}
        </button>
      )}
    </div>
  );
}
