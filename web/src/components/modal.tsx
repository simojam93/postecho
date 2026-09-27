"use client";

import { useEffect, useRef, type ReactNode } from "react";

/**
 * A window in front of the page (owner, 2026-09-24: "mi aspetto una finestra
 * davanti", then "un pop up" for Schedule). A native <dialog> opened with
 * showModal() on mount: it sits above everything, keeps the keyboard inside,
 * and Esc or a click on the dimmed page asks `onRequestClose` — which decides
 * (a confirm when there are unsaved changes, nothing while saving). The page
 * behind doesn't scroll while it's open. Unmount to close.
 */
export function Modal({ labelledBy, onRequestClose, children, initialFocus, width = "36rem", height }: {
  labelledBy: string;
  onRequestClose: () => void;
  children: ReactNode;
  /** The element to focus once open, instead of the first focusable one. */
  initialFocus?: React.RefObject<HTMLElement | null>;
  width?: string;
  /** A fixed height (capped at 88vh): the window itself doesn't scroll, its content does (Settings). */
  height?: string;
}) {
  const ref = useRef<HTMLDialogElement | null>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (!dialog.open) dialog.showModal();
    initialFocus?.current?.focus();
    const root = document.documentElement;
    const overflow = root.style.overflow;
    root.style.overflow = "hidden";
    return () => {
      root.style.overflow = overflow;
      if (dialog.open) dialog.close();
    };
    // Mount-only: the ref objects are stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <dialog
      ref={ref}
      aria-labelledby={labelledBy}
      // Esc closes only this window: React would pass the cancel on to a window this one sits in
      // (a Connect window over the welcome or Settings, 2026-09-26).
      onCancel={(e) => { e.preventDefault(); e.stopPropagation(); onRequestClose(); }}
      onClick={(e) => { if (e.target === e.currentTarget) onRequestClose(); }}
      style={{ width: `min(92vw, ${width})`, ...(height ? { height: `min(88vh, ${height})` } : {}) }}
      className={`m-auto max-h-[90vh] rounded-2xl border border-border bg-surface p-0 text-text shadow-2xl backdrop:bg-black/70 backdrop:backdrop-blur-sm ${height ? "overflow-hidden" : "overflow-y-auto"}`}
    >
      {children}
    </dialog>
  );
}
