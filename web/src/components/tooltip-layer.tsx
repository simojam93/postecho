"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

/** How long the pointer rests on something before its tooltip shows. */
const DELAY_MS = 450;
const GAP = 8;
const EDGE = 8;

type Tip = { text: string; target: Element; host: Element };

/**
 * One tooltip for the whole app (owner, 2026-09-27: "io farei i tooltip che
 * sono uguali dappertutto nell'app, con un copy corto e chiaro e ci resti
 * sopra"): any element with `data-tip` shows it, after the pointer rests on
 * it or when the keyboard reaches it — above the element, or below when
 * there's no room. Drawn inside the open window when the element is in one
 * (a <dialog> sits in the top layer, above anything else), else on the page.
 * The browser's own `title` tooltips are gone for these.
 */
export function TooltipLayer() {
  const [tip, setTip] = useState<Tip | null>(null);
  const boxRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let current: Element | null = null;
    const tipOf = (el: Element | null) => el?.closest("[data-tip]") ?? null;
    const open = (el: Element) => {
      const text = el.getAttribute("data-tip")?.trim();
      if (text) setTip({ text, target: el, host: el.closest("dialog[open]") ?? document.body });
    };
    const close = () => {
      if (timer) clearTimeout(timer);
      current = null;
      setTip(null);
    };
    const onOver = (e: PointerEvent) => {
      if (e.pointerType !== "mouse") return;
      const el = tipOf(e.target as Element);
      if (el === current) return;
      close();
      current = el;
      if (el) timer = setTimeout(() => open(el), DELAY_MS);
    };
    const onFocus = (e: FocusEvent) => {
      const el = tipOf(e.target as Element);
      // Only a keyboard focus: a click focuses too, and the pointer already handles that.
      if (el && (e.target as Element).matches(":focus-visible")) { close(); current = el; open(el); }
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") close(); };
    document.addEventListener("pointerover", onOver);
    document.addEventListener("focusin", onFocus);
    document.addEventListener("focusout", close);
    document.addEventListener("pointerdown", close, true);
    document.addEventListener("keydown", onKey);
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    return () => {
      close();
      document.removeEventListener("pointerover", onOver);
      document.removeEventListener("focusin", onFocus);
      document.removeEventListener("focusout", close);
      document.removeEventListener("pointerdown", close, true);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
    };
  }, []);

  // Placed once its size is known: centred over the element, kept inside the window.
  useLayoutEffect(() => {
    const box = boxRef.current;
    if (!tip || !box) return;
    const r = tip.target.getBoundingClientRect();
    const b = box.getBoundingClientRect();
    const above = r.top - GAP - b.height;
    const top = above >= EDGE ? above : r.bottom + GAP;
    const left = Math.min(Math.max(r.left + r.width / 2 - b.width / 2, EDGE), window.innerWidth - b.width - EDGE);
    box.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
    box.style.visibility = "visible";
  }, [tip]);

  if (!tip) return null;
  return createPortal(
    <div ref={boxRef} role="tooltip"
      style={{ position: "fixed", left: 0, top: 0, visibility: "hidden" }}
      className="pointer-events-none z-[1000] max-w-64 rounded-lg border border-border bg-surface-2 px-2.5 py-1.5 text-xs leading-snug text-text shadow-xl">
      {tip.text}
    </div>,
    tip.host,
  );
}
