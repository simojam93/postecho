"use client";

import { useEffect, useLayoutEffect, useRef } from "react";
import { createPortal } from "react-dom";

/** How long a finger rests on a card before its menu opens: phones have no right-click. */
export const LONG_PRESS_MS = 500;
/** How far the finger may drift before it's a scroll, not a press. */
export const LONG_PRESS_SLOP_PX = 10;

/**
 * Whether a right-click should get the browser's own menu rather than the card's: on a link
 * or a field (copy the link, open it in a new tab, paste), or with text selected in the card
 * (copy it).
 */
export function keepsBrowserMenu(target: EventTarget | null, hasSelection: boolean): boolean {
  const el = target as { closest?: (selector: string) => unknown } | null;
  if (el && typeof el.closest === "function" && el.closest("a, input, textarea, select, [contenteditable='true']")) return true;
  return hasSelection;
}

/**
 * A long press as a small state machine the card feeds touch events to: `down` starts the
 * timer, drifting past the slop or `up` cancels it, and once it fires `takeFired` answers true
 * a single time, so the click that ends the press can be swallowed.
 */
export function createLongPress(
  onFire: (x: number, y: number) => void,
  { delay = LONG_PRESS_MS, slop = LONG_PRESS_SLOP_PX }: { delay?: number; slop?: number } = {},
) {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let start: { x: number; y: number } | null = null;
  let fired = false;
  const clear = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    start = null;
  };
  return {
    down(x: number, y: number) {
      clear();
      fired = false;
      start = { x, y };
      timer = setTimeout(() => {
        timer = null;
        start = null;
        fired = true;
        onFire(x, y);
      }, delay);
    },
    move(x: number, y: number) {
      if (start && Math.hypot(x - start.x, y - start.y) > slop) clear();
    },
    up: clear,
    takeFired() {
      const was = fired;
      fired = false;
      return was;
    },
  };
}

export type CardMenuItem = { label: string; icon?: string; onSelect: () => void };

/**
 * A card's own menu at (x, y), kept inside the window: `role="menu"`, focus on its first item,
 * closed by Esc, a click elsewhere, a scroll, a resize or leaving the window — and focus then
 * goes back where it was.
 */
export function CardMenu({ x, y, items, onClose }: { x: number; y: number; items: CardMenuItem[]; onClose: () => void }) {
  const ref = useRef<HTMLDivElement | null>(null);

  // Measured and placed on the DOM node itself: no state, no second render.
  useLayoutEffect(() => {
    const menu = ref.current;
    if (!menu) return;
    const returnTo = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const { width, height } = menu.getBoundingClientRect();
    const margin = 8;
    menu.style.left = `${Math.max(margin, Math.min(x, window.innerWidth - width - margin))}px`;
    menu.style.top = `${Math.max(margin, Math.min(y, window.innerHeight - height - margin))}px`;
    menu.querySelector<HTMLButtonElement>("[role='menuitem']")?.focus({ preventScroll: true });
    return () => {
      if (returnTo?.isConnected) returnTo.focus({ preventScroll: true });
    };
  }, [x, y]);

  useEffect(() => {
    const close = () => onClose();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    const onPointer = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("pointerdown", onPointer, true);
    window.addEventListener("scroll", close, { capture: true, passive: true });
    window.addEventListener("resize", close);
    window.addEventListener("blur", close);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pointerdown", onPointer, true);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
      window.removeEventListener("blur", close);
    };
  }, [onClose]);

  return createPortal(
    <div ref={ref} role="menu" aria-label="Card actions" style={{ left: x, top: y }}
      className="fixed z-50 min-w-52 rounded-lg border border-border bg-surface-2 p-1 shadow-lg">
      {items.map((item) => (
        <button
          key={item.label}
          type="button"
          role="menuitem"
          onClick={() => {
            onClose();
            item.onSelect();
          }}
          className="flex w-full items-center gap-2.5 rounded-md px-3 py-2 text-left text-sm text-text hover:bg-surface focus:bg-surface focus:outline-none"
        >
          {item.icon && <span aria-hidden className="w-5 shrink-0 text-xs font-semibold text-text-dim">{item.icon}</span>}
          {item.label}
        </button>
      ))}
    </div>,
    document.body,
  );
}
