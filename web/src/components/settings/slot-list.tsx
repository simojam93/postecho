"use client";

import { useRef } from "react";

/** The API takes at most six slots per platform (api/settings). */
export const MAX_SLOTS = 6;
const TIME_RE = /^\d{2}:\d{2}$/;
const DAY_MINUTES = 24 * 60;

const toMinutes = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
const fromMinutes = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;

/** What's saved: valid HH:MM times, each once, earliest first. */
export function normalizeSlots(slots: string[]): string[] {
  return [...new Set(slots.filter((t) => TIME_RE.test(t)))].sort();
}

/** Where a new slot starts: an hour after the latest one (09:00 for the first), never on one that's there. */
export function nextSlot(slots: string[]): string {
  const valid = slots.filter((t) => TIME_RE.test(t));
  let m = valid.length ? Math.max(...valid.map(toMinutes)) + 60 : 9 * 60;
  for (let tries = 0; tries < 24 && valid.includes(fromMinutes(m % DAY_MINUTES)); tries++) m += 60;
  return fromMinutes(m % DAY_MINUTES);
}

/**
 * One platform's default slots (owner, 2026-09-27: "un orologio da
 * selezionare con ore e minuti? e poi con sotto un + dove puoi aggiungere
 * slots"): a time picker per slot, × to take one out, + to add one. The
 * picker is the browser's own: a click anywhere on the time opens its hours
 * and minutes where the browser has one, and it shows the time the way the
 * owner's language does.
 */
export function SlotList({ platform, slots, onChange }: { platform: string; slots: string[]; onChange: (next: string[]) => void }) {
  // The slot just added gets the focus and its picker, still inside the + click.
  const openIndex = useRef<number | null>(null);

  function add() {
    openIndex.current = slots.length;
    onChange([...slots, nextSlot(slots)]);
  }

  return (
    <div className="space-y-2">
      {slots.length > 0 && (
        <ul className="space-y-2">
          {slots.map((t, i) => (
            <li key={i} className="flex items-center gap-2">
              <input
                type="time"
                required
                value={t}
                aria-label={`${platform} slot ${i + 1}`}
                ref={(el) => {
                  if (!el || openIndex.current !== i) return;
                  openIndex.current = null;
                  el.focus();
                  openPicker(el);
                }}
                onClick={(e) => openPicker(e.currentTarget)}
                // A time only: clearing a part of it keeps the last whole time (× takes a slot out).
                onChange={(e) => { if (TIME_RE.test(e.target.value)) onChange(slots.map((s, j) => (j === i ? e.target.value : s))); }}
                className="w-32 cursor-pointer rounded-lg border border-border bg-surface px-3 py-1.5 text-sm tabular-nums outline-none focus:border-text-dim"
              />
              <button type="button" onClick={() => onChange(slots.filter((_, j) => j !== i))}
                aria-label={`Remove ${t} from ${platform}`} data-tip="Remove this slot"
                className="grid h-7 w-7 place-items-center rounded-full text-text-dim hover:bg-surface hover:text-text">
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
      {slots.length < MAX_SLOTS && (
        <button type="button" onClick={add} aria-label={`Add a slot on ${platform}`} data-tip="Add a time to post at"
          className="rounded-full border border-dashed border-border px-3 py-1 text-xs font-medium text-text-dim hover:border-text-dim hover:text-text">
          + Add slot
        </button>
      )}
    </div>
  );
}

function openPicker(el: HTMLInputElement) {
  try {
    el.showPicker();
  } catch {
    // No picker for times in this browser (Safari on a Mac): the field still takes hours and minutes.
  }
}
