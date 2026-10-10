"use client";

import { useId, useReducer, useState } from "react";
import { Modal } from "@/components/modal";
import { howTo, LINKEDIN_TAG_NOTE, openComposer, recordSchedule } from "@/components/write/schedule-dialog";
import { formatRomeSlot, fromDatetimeLocal, toDatetimeLocal } from "@/components/write/schedule-format";
import { platformPillCls } from "./schedule-card";
import { dayKeyOf, dayLabel, PLATFORM_LABEL, PLATFORM_TAG, romeTime } from "./plan-calendar";
import {
  scheduledCount, sequenceDone, sequenceReducer, startSequence,
  type Recorded, type SequencePost, type SequenceState, type SequenceStep,
} from "./schedule-all";

const X_LIMIT = 280;
const inputCls = "w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm outline-none focus:border-text-dim";
const pillCls = "rounded-full border border-border px-4 py-2 text-sm text-text-dim hover:text-text disabled:opacity-50";
const primaryPillCls = "rounded-full bg-accent px-4 py-2 text-sm font-medium text-accent-ink disabled:opacity-50";

/**
 * Schedule all (schedule in a row, 2026-10-10): the ready posts one at a time, in the list's order. Each
 * platform's step is the single post's Schedule (write/schedule-dialog.tsx) in sequence: Open X copies
 * the text and opens X's composer filled in, the owner sets the time in X's scheduler, and Scheduled
 * for records it (recordSchedule); then LinkedIn when the post has it, then the next post. Skip leaves
 * the post in the list; Stop, or Esc, ends it, and what was recorded stays. The end says how many were
 * scheduled and on which days; `onClose` gets what was recorded.
 */
export function ScheduleAllDialog({ posts, now, initial, onClose }: {
  /** The ready posts in the list's order, each with its time. */
  posts: SequencePost[];
  /** UTC ISO: "now" for the time labels. */
  now: string;
  /** Where to start (tests); a fresh sequence over `posts` otherwise. */
  initial?: SequenceState;
  onClose: (recorded: Recorded[]) => void;
}) {
  const titleId = useId();
  const [state, dispatch] = useReducer(sequenceReducer, initial ?? startSequence(posts));
  const [busy, setBusy] = useState(false);
  const done = sequenceDone(state);
  const step = done ? null : state.steps[state.at];

  const requestClose = () => {
    if (busy) return;
    if (done) onClose(state.recorded); else dispatch({ type: "stop" });
  };

  return (
    <Modal labelledBy={titleId} onRequestClose={requestClose}>
      <div className="space-y-4 p-5">
        {step ? (
          <StepView
            key={state.at}
            titleId={titleId}
            step={step}
            posts={state.posts}
            progress={state.at / state.steps.length}
            now={now}
            busy={busy}
            setBusy={setBusy}
            onRecorded={(publishAt) => dispatch({ type: "recorded", publishAt })}
            onSkip={() => dispatch({ type: "skip" })}
            onStop={() => dispatch({ type: "stop" })}
          />
        ) : (
          <EndView titleId={titleId} state={state} onDone={() => onClose(state.recorded)} />
        )}
      </div>
    </Modal>
  );
}

function StepView({ titleId, step, posts, progress, now, busy, setBusy, onRecorded, onSkip, onStop }: {
  titleId: string;
  step: SequenceStep;
  posts: number;
  /** 0–1: the steps behind this one. */
  progress: number;
  now: string;
  busy: boolean;
  setBusy: (busy: boolean) => void;
  onRecorded: (publishAt: string) => void;
  onSkip: () => void;
  onStop: () => void;
}) {
  const label = PLATFORM_LABEL[step.platform];
  const [when, setWhen] = useState(step.time ? toDatetimeLocal(step.time) : "");
  const [opened, setOpened] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const tooLong = step.platform === "x" && step.text.length > X_LIMIT;
  const at = fromDatetimeLocal(when);

  async function record() {
    if (busy) return;
    setBusy(true);
    setError(null);
    const result = await recordSchedule({ draftId: step.draftId, platform: step.platform, when });
    setBusy(false);
    if (result.ok) onRecorded(result.publishAt); else setError(result.error);
  }

  return (
    <>
      <div className="space-y-2">
        <h2 id={titleId} className="text-base font-semibold">Post {step.post + 1} of {posts}</h2>
        <div role="progressbar" aria-label="Scheduled so far" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(progress * 100)}
          className="h-1 w-full overflow-hidden rounded-full bg-surface-2">
          <div className="h-full rounded-full bg-accent" style={{ width: `${Math.round(progress * 100)}%` }} />
        </div>
      </div>
      <section aria-label={label} className="space-y-3 rounded-xl border border-border bg-surface-2 p-4">
        <p className="line-clamp-6 whitespace-pre-wrap break-words text-sm leading-relaxed">{step.text}</p>
        {tooLong ? (
          <p className="text-xs text-danger">The X text is over {X_LIMIT} characters: shorten it in Compose.</p>
        ) : (
          <p className="text-xs text-text-dim">{howTo(step.platform, opened)}</p>
        )}
        {step.platform === "linkedin" && step.text.includes(LINKEDIN_TAG_NOTE) && (
          <p className="text-xs text-text-dim">
            Each name followed by {LINKEDIN_TAG_NOTE}: type @ and the name in LinkedIn to tag them, then delete the note.
          </p>
        )}
        <button type="button" disabled={tooLong} className={opened ? pillCls : primaryPillCls}
          onClick={() => { openComposer(step.platform, step.text); setOpened(true); setError(null); }}>
          {opened ? `Open ${label} again ↗` : `Open ${label} ↗`}
        </button>
        <label className="block space-y-1.5">
          <span className="text-xs text-text-dim">The time you picked on {label}</span>
          <input type="datetime-local" value={when} min={toDatetimeLocal(now)} className={inputCls}
            onChange={(e) => { setWhen(e.target.value); setError(null); }} />
        </label>
        <button type="button" onClick={() => void record()} disabled={busy || tooLong || !at} className={opened ? primaryPillCls : pillCls}>
          {busy ? "Saving…" : at ? `Scheduled for ${formatRomeSlot(at, now)}` : "Scheduled"}
        </button>
        {error && <p className="text-xs text-danger">{error}</p>}
      </section>
      <div className="flex flex-wrap items-center justify-end gap-3 border-t border-border pt-4">
        <button type="button" onClick={onSkip} disabled={busy} className="text-sm text-text-dim underline hover:text-text disabled:opacity-50">Skip</button>
        <button type="button" onClick={onStop} disabled={busy} className={pillCls}>Stop</button>
      </div>
    </>
  );
}

/** The end: how many posts were scheduled, and the days they're on, soonest first. */
function EndView({ titleId, state, onDone }: { titleId: string; state: SequenceState; onDone: () => void }) {
  const byDay = new Map<string, Array<Recorded & { text: string }>>();
  for (const r of [...state.recorded].sort((a, b) => a.publishAt.localeCompare(b.publishAt))) {
    const text = state.steps.find((s) => s.draftId === r.draftId && s.platform === r.platform)?.text ?? "";
    const key = dayKeyOf(r.publishAt);
    byDay.set(key, [...(byDay.get(key) ?? []), { ...r, text }]);
  }
  return (
    <>
      <h2 id={titleId} className="text-base font-semibold">{scheduledCount(state)} scheduled</h2>
      {byDay.size > 0 && (
        <ul className="space-y-3">
          {[...byDay].map(([day, rows]) => (
            <li key={day} className="space-y-1.5">
              <span className="text-xs font-medium text-text-dim">{dayLabel(day)}</span>
              <ul className="space-y-1">
                {rows.map((r) => (
                  <li key={`${r.draftId}-${r.platform}`} className="flex items-center gap-2 text-sm">
                    <span className="shrink-0 font-medium">{romeTime(r.publishAt)}</span>
                    <span className={platformPillCls}>{PLATFORM_TAG[r.platform]}</span>
                    <span className="min-w-0 truncate text-text-dim">{r.text.split("\n")[0]}</span>
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      )}
      <div className="flex justify-end border-t border-border pt-4">
        <button type="button" onClick={onDone} className={primaryPillCls}>Done</button>
      </div>
    </>
  );
}
