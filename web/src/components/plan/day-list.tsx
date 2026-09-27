"use client";

import Link from "next/link";
import { ScheduleCard, platformPillCls } from "./schedule-card";
import {
  dayLabel, PLATFORM_LABEL, PLATFORM_TAG,
  type DayKey, type DayRow, type FreeSlot, type PlanAction, type PlanOutcome, type PlanPost,
} from "./plan-calendar";

/**
 * The `+` on a free slot hands off to Write. Link contract (M3 plan, P5):
 * `/create?slot=<UTC ISO instant>&platform=<x|linkedin>` — `slot` is the
 * free default slot, `platform` the platform whose slot it is; Write's
 * Schedule sheet is meant to preselect that platform and prefill its
 * datetime input with the slot for the next Schedule action. Write may
 * ignore both params today — then the link simply opens Write.
 */
function scheduleHref(slot: FreeSlot): string {
  return `/create?slot=${encodeURIComponent(slot.at)}&platform=${slot.platform}`;
}

/**
 * The selected day (M3 plan, P5), soonest first: the still-free default
 * slots from Settings as dashed rows with a **+**, and each scheduled post
 * as a ScheduleCard — plan-calendar.ts's dayRows decides the order and
 * leaves the canceled rows out (they're the Archive's, archive-list.tsx).
 */
export function DayList({ day, isToday, rows, now, busy, errors, onAction, onEdit, rating = null, onRate }: {
  day: DayKey;
  isToday: boolean;
  rows: DayRow[];
  /** UTC ISO captured when the calendar loaded (see ScheduleCard). */
  now: string;
  /** The action in flight, if any: which card and what. */
  busy: { id: string; action: PlanAction } | null;
  /** Inline error per post id, from the last action that failed on it. */
  errors: Record<string, string>;
  onAction: (post: PlanPost, action: PlanAction) => void;
  /** Plan's Edit (schedule-card.tsx): resolves to an error message, or null once saved. */
  onEdit?: (post: PlanPost, changes: { publishAt?: string; text?: string }) => Promise<string | null>;
  /** The post whose vote is being saved, if any. */
  rating?: string | null;
  /** Plan's vote on a post that is out (schedule-card.tsx's RateRow). */
  onRate?: (post: PlanPost, outcome: PlanOutcome | null) => void;
}) {
  return (
    <section aria-label={dayLabel(day)} className="min-w-0 space-y-3">
      <h2 className="font-semibold">
        {dayLabel(day)}
        {isToday && <span className="text-text-dim"> · today</span>}
      </h2>

      {rows.length === 0 && <p className="text-sm text-text-dim">Nothing on this day.</p>}

      <ul className="space-y-3">
        {rows.map((row) => {
          if (row.kind === "free") {
            return (
              <li
                key={`free-${row.platform}-${row.at}`}
                className="flex items-center justify-between gap-3 rounded-xl border border-dashed border-border px-4 py-2 text-sm text-text-dim"
              >
                <span className="flex min-w-0 items-center gap-2">
                  <span className="font-medium text-text">{row.time}</span>
                  <span aria-hidden>·</span>
                  <span className={platformPillCls}>{PLATFORM_TAG[row.platform]}</span>
                  <span aria-hidden>·</span>
                  <span>free</span>
                </span>
                <Link
                  href={scheduleHref(row)}
                  aria-label={`Schedule a ${PLATFORM_LABEL[row.platform]} post at ${row.time}`}
                  data-tip="Schedule a post from Write here"
                  className="rounded-full border border-border px-3 py-1 text-sm leading-none hover:text-text"
                >
                  +
                </Link>
              </li>
            );
          }
          return (
            <li key={row.post.id}>
              <ScheduleCard
                post={row.post}
                now={now}
                busy={busy?.id === row.post.id ? busy.action : null}
                error={errors[row.post.id] ?? null}
                onAction={onAction}
                onEdit={onEdit}
                rating={rating === row.post.id}
                onRate={onRate}
              />
            </li>
          );
        })}
      </ul>
    </section>
  );
}
