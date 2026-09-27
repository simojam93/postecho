"use client";

import { dayDots, dayLabel, type DayCell, type DayKey, type DotStatus, type PlanPost } from "./plan-calendar";

/** Dot colour per status — scheduled a hollow silver ring (ready on the platform), queued dim silver, emailed accent silver, posted ok, failed danger (canceled never gets a dot). */
const DOT_CLS: Record<DotStatus, string> = {
  scheduled: "border border-accent",
  queued: "bg-text-dim",
  emailed: "bg-accent",
  posted: "bg-ok",
  failed: "bg-danger",
};
const LEGEND: DotStatus[] = ["scheduled", "posted", "queued", "emailed", "failed"];
const WEEKDAYS = ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"];

/**
 * The month (M3 plan, P5): Monday-first full weeks from plan-calendar.ts's
 * monthMatrix, today ringed in the accent, the selected day filled, up to
 * three status dots per day plus a "+N" overflow. Compact enough for a
 * 360px phone (seven ~44px cells inside the layout's 16px gutters);
 * adjacent-month cells are dimmed but clickable — their posts are in the
 * same fetch (see gridRangeUtc).
 */
export function MonthGrid({ weeks, today, selected, postsByDay, onSelect }: {
  weeks: DayCell[][];
  today: DayKey;
  selected: DayKey;
  postsByDay: Map<DayKey, PlanPost[]>;
  onSelect: (day: DayKey) => void;
}) {
  return (
    <div className="rounded-xl border border-border bg-surface p-2 sm:p-3">
      <div className="mb-1 grid grid-cols-7 text-center text-[10px] uppercase tracking-wide text-text-dim" aria-hidden>
        {WEEKDAYS.map((d) => <span key={d}>{d}</span>)}
      </div>
      <div className="grid grid-cols-7 gap-0.5 sm:gap-1">
        {weeks.flat().map((cell) => {
          const { dots, overflow } = dayDots(postsByDay.get(cell.key) ?? []);
          const count = dots.length + overflow;
          const isToday = cell.key === today;
          const isSelected = cell.key === selected;
          return (
            <button
              key={cell.key}
              type="button"
              onClick={() => onSelect(cell.key)}
              aria-pressed={isSelected}
              aria-current={isToday ? "date" : undefined}
              aria-label={`${dayLabel(cell.key)}${count > 0 ? `, ${count} post${count === 1 ? "" : "s"}` : ""}`}
              className={`flex h-11 flex-col items-center gap-1 rounded-lg pt-1 text-xs ${
                isSelected
                  ? "bg-surface-2 text-text"
                  : cell.inMonth
                    ? "text-text hover:bg-surface-2"
                    : "text-text-dim/50 hover:bg-surface-2"
              }`}
            >
              <span
                className={`flex h-5 w-5 items-center justify-center rounded-full ${
                  isToday ? "bg-accent font-semibold text-accent-ink" : ""
                }`}
              >
                {cell.day}
              </span>
              <span className="flex h-1.5 items-center gap-0.5">
                {dots.map((status, i) => (
                  <span key={`${status}-${i}`} className={`h-1.5 w-1.5 rounded-full ${DOT_CLS[status]}`} />
                ))}
                {overflow > 0 && <span className="text-[9px] leading-none text-text-dim">+{overflow}</span>}
              </span>
            </button>
          );
        })}
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 px-1 text-[10px] text-text-dim" aria-hidden>
        {LEGEND.map((status) => (
          <span key={status} className="flex items-center gap-1">
            <span className={`h-1.5 w-1.5 rounded-full ${DOT_CLS[status]}`} />
            {status}
          </span>
        ))}
      </div>
    </div>
  );
}

const arrowCls =
  "flex h-7 w-7 items-center justify-center rounded-full border border-border text-text-dim hover:text-text disabled:opacity-50";

/** Previous / next month arrows and the "Today" pill — lives in the header strip, next to the month name. */
/** ‹ › move a day at a time (owner, 2026-09-27: "avanti e indietro devono farmi muovere di un giorno non di 1 mese"); Today jumps back. */
export function DayNav({ onPrev, onNext, onToday }: { onPrev: () => void; onNext: () => void; onToday: () => void }) {
  return (
    <div className="flex items-center gap-1">
      <button
        type="button"
        onClick={onToday}
        className="mr-1 rounded-full border border-border px-3 py-1 text-xs font-medium text-text-dim hover:text-text"
      >
        Today
      </button>
      <button type="button" onClick={onPrev} aria-label="Previous day" data-tip="Previous day" className={arrowCls}>‹</button>
      <button type="button" onClick={onNext} aria-label="Next day" data-tip="Next day" className={arrowCls}>›</button>
    </div>
  );
}
