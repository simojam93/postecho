"use client";

import { useEffect, useId, useState } from "react";
import Link from "next/link";
import { Modal } from "@/components/modal";
import { composerUrl as linkedinComposerUrl } from "@/lib/publishers/linkedin";
import { PLATFORM_LABEL } from "./post-state";
import { formatRomeSlot, fromDatetimeLocal, toDatetimeLocal } from "./schedule-format";
import type { Platform } from "./types";

const X_LIMIT = 280;
// Mirrors lib/schedule.ts's PAST_TOLERANCE_MS.
const PAST_TOLERANCE_MS = 60_000;
const JSON_HEADERS = { "Content-Type": "application/json" };
const inputCls = "w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm outline-none focus:border-text-dim";
const pillCls = "rounded-full border border-border px-4 py-2 text-sm text-text-dim hover:text-text disabled:opacity-50";
const primaryPillCls = "rounded-full bg-accent px-4 py-2 text-sm font-medium text-accent-ink disabled:opacity-50";
const chipCls = "rounded-full border border-border px-2 py-0.5 text-xs text-text-dim hover:text-text disabled:opacity-50";

export type ScheduleTarget = { platform: Platform; text: string };

/** Claude's note after a name worth tagging on LinkedIn (agent/src/prompts.ts's LINKEDIN_TAG_NOTE, 2026-09-25). */
export const LINKEDIN_TAG_NOTE = "(to tag on LinkedIn)";

type Row = ScheduleTarget & {
  /** The datetime-local value: the time the owner scheduled it for on the platform. */
  when: string;
  /** The platform's next free default slots (UTC ISO). */
  slots: string[];
  /** Its composer was opened. */
  opened: boolean;
  /** Recorded: the publishAt Plan keeps (UTC ISO). */
  done: string | null;
  busy: boolean;
  copied: boolean;
  error: string | null;
};

/**
 * X's full composer, not its share intent (owner, 2026-09-25: from the intent
 * "it didn't let me schedule it, just post it immediately… I had to refresh
 * the page and then it worked"): the intent opens the light composer share
 * buttons use; the full one has the calendar icon. The text rides along in
 * case X fills it in, and is copied too (openComposer) for when it doesn't.
 */
export const X_COMPOSE_URL = "https://x.com/compose/post?text=";

/** Each platform's own composer with the text: X's full composer, LinkedIn's share box. */
export function composerFor(platform: Platform, text: string): string {
  return platform === "x" ? X_COMPOSE_URL + encodeURIComponent(text) : linkedinComposerUrl(text);
}

/** Opens the platform's composer in a new tab and copies the text, inside the click (popup blockers, clipboard). */
export function openComposer(platform: Platform, text: string): void {
  window.open(composerFor(platform, text), "_blank", "noopener");
  void navigator.clipboard?.writeText(text).catch(() => { /* Copy text is there too */ });
}

export type RecordResult = { ok: true; publishAt: string } | { ok: false; error: string };

/**
 * Tells PostEcho the time the owner scheduled a post for on the platform (POST
 * /api/scheduled-posts/mark-posted with publishAt; lib/schedule.ts's markPostedManually): this window's
 * Scheduled on X, and Schedule all's Scheduled for (schedule in a row, 2026-10-10). `when` is the
 * datetime-local value; an empty or past one is refused without a request. `flush` saves an unsaved
 * edit first. The error is the one to show.
 */
export async function recordSchedule({ draftId, platform, when, flush }: {
  draftId: string;
  platform: Platform;
  when: string;
  flush?: () => Promise<boolean>;
}): Promise<RecordResult> {
  const at = fromDatetimeLocal(when);
  if (!at) return { ok: false, error: `Pick the time you scheduled it for on ${PLATFORM_LABEL[platform]}.` };
  if (new Date(at).getTime() < Date.now() - PAST_TOLERANCE_MS) return { ok: false, error: "That time has passed: pick the one you scheduled it for." };
  try {
    if (flush && !(await flush())) return { ok: false, error: "Your edit couldn't be saved, so nothing was recorded." };
    const res = await fetch("/api/scheduled-posts/mark-posted", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ draftId, platform, publishAt: at }),
    });
    const body = await res.json().catch(() => null);
    if (!res.ok) return { ok: false, error: typeof body?.error === "string" ? body.error : "Couldn't record it. Try again." };
    return { ok: true, publishAt: typeof body?.post?.publishAt === "string" ? body.post.publishAt : at };
  } catch {
    return { ok: false, error: "Network error: nothing was recorded." };
  }
}

/** What to do in the composer, once it's open or before (X Help; LinkedIn Help "Schedule posts"). */
export function howTo(platform: Platform, opened: boolean): string {
  if (platform === "x") {
    return `${opened ? "X is open in a new tab with its full composer" : "Opens X's full composer"}. Your text is copied too: paste it if the box is empty, then use the calendar icon to schedule it.`;
  }
  return `${opened ? "LinkedIn is open in a new tab with your text" : "Opens LinkedIn with your text"}: use the clock icon next to Post to schedule it.`;
}

/**
 * Write's Schedule (owner, 2026-09-24: "quando clicco schedule… mi apra un
 * post con il testo dentro di X e io posso schedularlo subito… poi posso dire
 * scheduled nel pop up. Il plan diventa un posto dove tenere i post già
 * pronti sui due social media"). The Schedule click already opened the first
 * platform's own composer with the text (post-editor.tsx, inside the click, so
 * no popup blocker stops it); here the owner schedules it there with X's or
 * LinkedIn's own scheduler, then tells PostEcho the time: POST
 * /api/scheduled-posts/mark-posted with publishAt records it for Plan, where
 * it waits as scheduled and then counts as posted. No timer, no email — the
 * platform publishes it. One row per platform with text; each can be opened
 * again, or its text copied, and each is marked on its own.
 */
export function ScheduleDialog({ draftId, targets, openedFirst, now, flush, onScheduled, onClose }: {
  draftId: string;
  targets: ScheduleTarget[];
  /** The platform whose composer the Schedule click opened. */
  openedFirst: Platform | null;
  /** UTC ISO when the dialog opened: "now" for its labels and the time input's minimum. */
  now: string;
  /** Saves an unsaved edit first; false when that failed. */
  flush: () => Promise<boolean>;
  onScheduled: (platform: Platform, publishAt: string) => void;
  onClose: () => void;
}) {
  const titleId = useId();
  const [rows, setRows] = useState<Row[]>(() => targets.map((t) => ({
    ...t, when: "", slots: [], opened: t.platform === openedFirst, done: null, busy: false, copied: false, error: null,
  })));
  // Fixed for the dialog's life: the platforms it was opened for.
  const [platforms] = useState(() => targets.map((t) => t.platform));

  // The next free default slots per platform; the first prefills the time. Every setState after an await.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const loaded = await Promise.all(platforms.map(async (platform) => {
        try {
          const res = await fetch(`/api/scheduled-posts/slots?platform=${platform}`);
          if (!res.ok) return { platform, slots: [] as string[] };
          const body = await res.json();
          const slots: string[] = Array.isArray(body?.slots) ? body.slots.filter((s: unknown) => typeof s === "string") : [];
          return { platform, slots: slots.slice(0, 3) };
        } catch {
          return { platform, slots: [] as string[] };
        }
      }));
      if (cancelled) return;
      setRows((current) => current.map((row) => {
        const hit = loaded.find((l) => l.platform === row.platform);
        if (!hit) return row;
        return { ...row, slots: hit.slots, when: row.when || (hit.slots[0] ? toDatetimeLocal(hit.slots[0]) : "") };
      }));
    })();
    return () => { cancelled = true; };
  }, [platforms]);

  function update(platform: Platform, patch: Partial<Row>) {
    setRows((current) => current.map((row) => (row.platform === platform ? { ...row, ...patch } : row)));
  }

  function open(row: Row) {
    openComposer(row.platform, row.text);
    update(row.platform, { opened: true, error: null });
  }

  async function copy(row: Row) {
    try {
      await navigator.clipboard.writeText(row.text);
      update(row.platform, { copied: true });
    } catch {
      update(row.platform, { error: "Couldn't copy: select the text in the editor instead." });
    }
  }

  async function mark(row: Row) {
    if (row.busy) return;
    update(row.platform, { busy: true, error: null });
    const result = await recordSchedule({ draftId, platform: row.platform, when: row.when, flush });
    if (!result.ok) { update(row.platform, { busy: false, error: result.error }); return; }
    update(row.platform, { busy: false, done: result.publishAt });
    onScheduled(row.platform, result.publishAt);
  }

  const busy = rows.some((row) => row.busy);
  const allDone = rows.every((row) => row.done !== null);
  const names = rows.map((row) => PLATFORM_LABEL[row.platform]).join(" and ");
  const requestClose = () => { if (!busy) onClose(); };

  return (
    <Modal labelledBy={titleId} onRequestClose={requestClose}>
      <div className="space-y-4 p-5">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 space-y-1">
            <h2 id={titleId} className="text-base font-semibold">Schedule</h2>
            <p className="text-xs text-text-dim">
              Schedule it with {rows.length > 1 ? "each platform's" : `${names}'s`} own scheduler, then tell PostEcho the time. Schedule shows it by date. No emails.
            </p>
          </div>
          <button type="button" onClick={requestClose} disabled={busy} aria-label="Close"
            className="shrink-0 rounded-full border border-border px-2.5 py-0.5 text-sm text-text-dim hover:text-text disabled:opacity-50">
            ×
          </button>
        </div>

        {rows.map((row) => {
          const label = PLATFORM_LABEL[row.platform];
          const tooLong = row.platform === "x" && row.text.length > X_LIMIT;
          return (
            <section key={row.platform} aria-label={label} className="space-y-3 rounded-xl border border-border bg-surface-2 p-4">
              <div className="flex items-center justify-between gap-2">
                <span className="text-sm font-medium">{label}</span>
                {row.done && <span role="status" className="text-sm text-ok">✓ Scheduled · {formatRomeSlot(row.done, now)}</span>}
              </div>
              {!row.done && (
                <>
                  {tooLong ? (
                    <p className="text-xs text-danger">The X text is over {X_LIMIT} characters: shorten it first.</p>
                  ) : (
                    <p className="text-xs text-text-dim">{howTo(row.platform, row.opened)}</p>
                  )}
                  {row.platform === "linkedin" && !tooLong && row.text.includes(LINKEDIN_TAG_NOTE) && (
                    <p className="text-xs text-text-dim">
                      Each name followed by {LINKEDIN_TAG_NOTE}: type @ and the name in LinkedIn to tag them, then delete the note.
                    </p>
                  )}
                  <div className="flex flex-wrap items-center gap-3">
                    <button type="button" onClick={() => open(row)} disabled={tooLong} className={row.opened ? pillCls : primaryPillCls}>
                      {row.opened ? `Open ${label} again ↗` : `Open in ${label} ↗`}
                    </button>
                    <button type="button" onClick={() => void copy(row)} className="text-xs text-text-dim underline hover:text-text">
                      {row.copied ? "Copied" : "Copy text"}
                    </button>
                  </div>
                  <label className="block space-y-1.5">
                    <span className="text-xs text-text-dim">The time you picked on {label}</span>
                    <input
                      type="datetime-local"
                      value={row.when}
                      min={toDatetimeLocal(now)}
                      onChange={(e) => update(row.platform, { when: e.target.value, error: null })}
                      className={inputCls}
                    />
                  </label>
                  {row.slots.length > 0 && (
                    <div className="flex flex-wrap items-center gap-1">
                      <span className="text-xs text-text-dim">Your free slots:</span>
                      {row.slots.map((iso) => (
                        <button key={iso} type="button" onClick={() => update(row.platform, { when: toDatetimeLocal(iso), error: null })}
                          className={chipCls} data-tip={new Date(iso).toLocaleString()}>
                          {formatRomeSlot(iso, now)}
                        </button>
                      ))}
                    </div>
                  )}
                  <button type="button" onClick={() => void mark(row)} disabled={row.busy || tooLong || !row.when}
                    className={row.opened ? primaryPillCls : pillCls}>
                    {row.busy ? "Saving…" : `Scheduled on ${label}`}
                  </button>
                  {row.error && <p className="text-xs text-danger">{row.error}</p>}
                </>
              )}
            </section>
          );
        })}

        <div className="flex flex-wrap items-center justify-end gap-3 border-t border-border pt-4">
          {rows.some((row) => row.done) && (
            <Link href="/calendar" className="text-sm text-text-dim underline hover:text-text">See it in Schedule</Link>
          )}
          <button type="button" onClick={requestClose} disabled={busy} className={allDone ? primaryPillCls : pillCls}>
            {allDone ? "Done" : "Close"}
          </button>
        </div>
      </div>
    </Modal>
  );
}
