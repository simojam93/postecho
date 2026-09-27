"use client";

import { useEffect, useId, useRef, useState } from "react";
import { ClampedText } from "@/components/clamped-text";
import { Modal } from "@/components/modal";
import { formatRomeSlot, fromDatetimeLocal, toDatetimeLocal } from "@/components/write/schedule-format";
import { composerUrl as linkedinComposerUrl } from "@/lib/publishers/linkedin";
import {
  actionsFor, isOutStatus, PLATFORM_LABEL, PLATFORM_TAG, romeTime, slotLabel,
  type PlanAction, type PlanOutcome, type PlanPlatform, type PlanPost, type PlanStatus,
} from "./plan-calendar";

// Pill classes as idea-card.tsx's footer buttons (and post-editor.tsx's
// hover-to-danger discard button) spell them.
const pillCls = "rounded-full border border-border px-3 py-1.5 text-sm text-text-dim hover:text-text disabled:opacity-50";
const primaryPillCls = "rounded-full bg-accent px-3 py-1.5 text-sm font-medium text-accent-ink disabled:opacity-50";
const dangerPillCls =
  "rounded-full border border-border px-3 py-1.5 text-sm text-text-dim hover:border-danger hover:text-danger disabled:opacity-50";
/** The source pill of idea-card.tsx, reused for the platform. */
export const platformPillCls =
  "shrink-0 rounded-full border border-border px-2 py-0.5 text-[10px] uppercase tracking-wide text-text-dim";

/** Badge text and colour per status — the grid's dot colours (queued dim, emailed silver, posted ok, failed danger); canceled never shows in the days. */
const BADGE: Record<PlanStatus, { label: string; cls: string }> = {
  scheduled: { label: "scheduled", cls: "border-accent text-text" },
  queued: { label: "queued", cls: "border-border text-text-dim" },
  emailed: { label: "emailed", cls: "border-text-dim text-accent" },
  published: { label: "published", cls: "border-ok/50 text-ok" },
  posted_manually: { label: "posted", cls: "border-ok/50 text-ok" },
  failed: { label: "failed", cls: "border-danger/50 text-danger" },
  canceled: { label: "canceled", cls: "border-border text-text-dim/60" },
};

const ACTION: Record<PlanAction, { label: string; busy: string; cls: string }> = {
  resend: { label: "Resend email", busy: "Sending…", cls: pillCls },
  retry: { label: "Retry", busy: "Retrying…", cls: pillCls },
  "mark-posted": { label: "Mark as posted", busy: "Marking…", cls: primaryPillCls },
  cancel: { label: "Cancel", busy: "Canceling…", cls: dangerPillCls },
  remove: { label: "Remove", busy: "Removing…", cls: dangerPillCls },
};

/**
 * Where a post scheduled on its platform is edited (owner, 2026-09-27: Edit
 * "dovrebbe rimandarti all'editing dei scheduled post sia in X che in
 * Linkedin, senza aprire cose in calendar"): X's list of scheduled posts;
 * LinkedIn has no link to its own, so its post box, whose clock icon leads
 * to them (LINKEDIN_SCHEDULED_TIP).
 */
export const PLATFORM_SCHEDULED_URL: Record<PlanPlatform, string> = {
  x: "https://x.com/compose/post/unsent/scheduled",
  linkedin: linkedinComposerUrl(""),
};
export const LINKEDIN_SCHEDULED_TIP = "In the post box: the clock icon, then View all scheduled posts";

const X_LIMIT = 280;
const inputCls = "w-full rounded-lg border border-border bg-surface-2 px-3 py-2 text-sm outline-none focus:border-text-dim";
const chipCls = "rounded-full border border-border px-2 py-0.5 text-xs text-text-dim hover:text-text disabled:opacity-50";
const timeInputCls = "rounded-lg border border-border bg-surface-2 px-2 py-1 text-xs text-text outline-none focus:border-text-dim";
const rateBaseCls = "inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs disabled:opacity-50";

/** A thumb in the line style of Settings' tab icons; `down` turns it over. */
function ThumbIcon({ down = false }: { down?: boolean }) {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" className={`h-3.5 w-3.5 shrink-0 ${down ? "rotate-180" : ""}`}
      fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
      <path d="M2.5 7.5h2.5v6H2.5zM5 7.5l2.6-5c1 0 1.7.8 1.5 1.8L8.6 7h3.6c.9 0 1.6.9 1.4 1.8l-.9 3.8c-.2.7-.8 1.2-1.5 1.2H5" />
    </svg>
  );
}

/**
 * "How did it do?" on a post that is out (owner, 2026-09-26: "il tocco in plan serve sia se
 * il post è andato bene che se è andato male"): Did well or Didn't land, as toggles — the
 * pressed one again takes the vote back. Find Ideas learns from the votes (lib/taste.ts).
 */
export function RateRow({ outcome, disabled = false, onRate }: {
  outcome: PlanOutcome | null;
  disabled?: boolean;
  onRate: (next: PlanOutcome | null) => void;
}) {
  const vote = (value: PlanOutcome, label: string, pressedCls: string) => (
    <button
      type="button"
      aria-pressed={outcome === value}
      disabled={disabled}
      onClick={() => onRate(outcome === value ? null : value)}
      className={`${rateBaseCls} ${outcome === value ? pressedCls : "border-border text-text-dim hover:text-text"}`}
    >
      <ThumbIcon down={value === "bad"} />
      {label}
    </button>
  );
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs text-text-dim">
      <span>How did it do?</span>
      {vote("good", "Did well", "border-ok/60 text-ok")}
      {vote("bad", "Didn't land", "border-danger/60 text-danger")}
    </div>
  );
}

/**
 * The statuses lib/schedule.ts's updateSchedule changes. A scheduled post is
 * edited on its platform (PLATFORM_SCHEDULED_URL), only its time here
 * (MovedRow); the others, PostEcho's own queue, in ScheduleEditDialog.
 */
export function isEditable(status: PlanStatus): boolean {
  return status === "scheduled" || status === "queued" || status === "emailed" || status === "failed";
}

/** What Edit saves: only what changed. Null for "nothing to save". */
export function editChanges(post: Pick<PlanPost, "publishAt" | "text">, when: string | null, text: string): { publishAt?: string; text?: string } | null {
  const changes: { publishAt?: string; text?: string } = {};
  if (when && new Date(when).getTime() !== new Date(post.publishAt).getTime()) changes.publishAt = when;
  if (text !== post.text) changes.text = text;
  return Object.keys(changes).length > 0 ? changes : null;
}

// Shared by both cards below.
const cardCls = "flex min-w-0 flex-col gap-3 rounded-xl border border-border bg-surface p-4";
const previewCls = "whitespace-pre-wrap break-words text-sm leading-relaxed";

/**
 * The source's link, always with the post (owner, 2026-09-25: "always with
 * them the link of the source so that in case I can use it for adding it in
 * the first comment (especially for X)"): open it, or copy it to paste.
 */
export function SourceLink({ url }: { url: string }) {
  const [copied, setCopied] = useState(false);
  let shown = url;
  try {
    const u = new URL(url);
    shown = `${u.hostname.replace(/^www\./, "")}${u.pathname === "/" ? "" : u.pathname}`;
  } catch { /* shown as is */ }
  async function copy() {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
    } catch { /* the link is right there to select */ }
  }
  return (
    <div className="flex min-w-0 items-center gap-2 text-xs text-text-dim">
      <span className="shrink-0">Source</span>
      <a href={url} target="_blank" rel="noopener noreferrer" data-tip={url}
        className="min-w-0 truncate underline decoration-border underline-offset-2 hover:text-text">
        {shown} ↗
      </a>
      <button type="button" onClick={() => void copy()} className="shrink-0 underline hover:text-text">
        {copied ? "Copied" : "Copy link"}
      </button>
    </div>
  );
}

/** The post's text: an X post whole, always — it's 280 characters at most (2026-09-25); a LinkedIn one clamped, with more. */
function PostText({ post }: { post: Pick<PlanPost, "platform" | "text"> }) {
  if (post.platform === "x") return <p className={previewCls}>{post.text}</p>;
  return <ClampedText lines={3} text={post.text} className={previewCls} />;
}

function StatusBadge({ status }: { status: PlanStatus }) {
  const { label, cls } = BADGE[status];
  return (
    <span className={`shrink-0 rounded-full border px-2 py-0.5 text-[10px] uppercase tracking-wide ${cls}`}>{label}</span>
  );
}

/**
 * One scheduled post in the Plan day list (M3 plan, P5): platform pill,
 * Rome time, the frozen text (clamped to three lines), a status badge, a
 * status detail line (the error for a failed row, when the email went out
 * or the post was made otherwise), and the actions plan-calendar.ts's
 * actionsFor allows for the status — the parent runs them (same "card calls
 * back up, parent does the fetch" split as idea-card.tsx). A post scheduled
 * on X or LinkedIn is edited there (Edit on X ↗), then MovedRow asks for its
 * time. A row with a `publishedUrl` gets an **Open post** link whatever its
 * status. Canceled rows never reach the day list.
 */
export function ScheduleCard({ post, now, busy, error, onAction, onEdit, onRate, rating = false }: {
  post: PlanPost;
  /** UTC ISO captured when the calendar loaded — "now" for the relative labels, fixed so render stays pure. */
  now: string;
  /** The action in flight on THIS card, if any: its button shows the busy label and every button is disabled. */
  busy: PlanAction | null;
  error: string | null;
  onAction: (post: PlanPost, action: PlanAction) => void;
  /** Plan's Edit: saves the changes (PATCH /api/scheduled-posts/:id); resolves to an error message, or null once saved. */
  onEdit?: (post: PlanPost, changes: { publishAt?: string; text?: string }) => Promise<string | null>;
  /** Plan's vote on a post that is out: the parent saves it (PATCH /api/scheduled-posts/:id). */
  onRate?: (post: PlanPost, outcome: PlanOutcome | null) => void;
  /** A vote on THIS card is being saved. */
  rating?: boolean;
}) {
  const badge = BADGE[post.status];
  const actions = actionsFor(post.status);
  const [editing, setEditing] = useState(false);
  /** Edit on X or LinkedIn was clicked: the card asks whether the time moved there. */
  const [away, setAway] = useState(false);
  const onPlatform = post.status === "scheduled";
  const canEdit = Boolean(onEdit) && isEditable(post.status) && !onPlatform;

  return (
    <article
      aria-label={`${PLATFORM_LABEL[post.platform]} post at ${romeTime(post.publishAt)}, ${badge.label}`}
      className={cardCls}
    >
      <div className="flex items-center justify-between gap-2 text-sm text-text-dim">
        <div className="flex min-w-0 items-center gap-2">
          <span className={platformPillCls}>{PLATFORM_TAG[post.platform]}</span>
          <span className="shrink-0 font-medium text-text">{romeTime(post.publishAt)}</span>
          {post.ideaTitle && <span className="min-w-0 truncate" data-tip={post.ideaTitle}>{post.ideaTitle}</span>}
        </div>
        <StatusBadge status={post.status} />
      </div>

      <PostText post={post} />
      {post.sourceUrl && <SourceLink url={post.sourceUrl} />}
      {editing && onEdit && (
        <ScheduleEditDialog post={post} now={now} onSave={(changes) => onEdit(post, changes)} onClose={() => setEditing(false)} />
      )}

      {post.status === "scheduled" && (
        <p className="text-xs text-text-dim">Scheduled on {PLATFORM_LABEL[post.platform]}: it goes out by itself.</p>
      )}
      {post.status === "failed" && (
        <p className="text-xs text-danger">{post.error ?? "The due email could not be sent."}</p>
      )}
      {post.status === "emailed" && (
        <p className="text-xs text-text-dim">
          Email sent{post.emailedAt ? ` · ${formatRomeSlot(post.emailedAt, now)}` : ""} — post it from the email, then mark it here.
        </p>
      )}
      {(post.status === "posted_manually" || post.status === "published") && post.publishedAt && (
        <p className="text-xs text-text-dim">Posted · {formatRomeSlot(post.publishedAt, now)}</p>
      )}
      {onRate && isOutStatus(post.status) && (
        <RateRow outcome={post.outcome ?? null} disabled={rating} onRate={(next) => onRate(post, next)} />
      )}

      {(actions.length > 0 || post.publishedUrl) && (
        <div className="flex flex-wrap items-center gap-2">
          {canEdit && (
            <button type="button" onClick={() => setEditing(true)} disabled={busy !== null} className={pillCls}>
              Edit
            </button>
          )}
          {onPlatform && (
            <a href={PLATFORM_SCHEDULED_URL[post.platform]} target="_blank" rel="noopener noreferrer" onClick={() => setAway(true)}
              data-tip={post.platform === "linkedin" ? LINKEDIN_SCHEDULED_TIP : undefined} className={pillCls}>
              Edit on {PLATFORM_LABEL[post.platform]} ↗
            </a>
          )}
          {post.publishedUrl && (
            <a href={post.publishedUrl} target="_blank" rel="noreferrer" className={pillCls}>
              Open post ↗
            </a>
          )}
          {actions.map((action) => (
            <button
              key={action}
              type="button"
              onClick={() => onAction(post, action)}
              disabled={busy !== null}
              className={ACTION[action].cls}
            >
              {busy === action ? ACTION[action].busy : ACTION[action].label}
            </button>
          ))}
        </div>
      )}

      {away && onPlatform && onEdit && (
        <MovedRow post={post} now={now} onSave={(publishAt) => onEdit(post, { publishAt })} onDone={() => setAway(false)} />
      )}

      {error && <p className="text-xs text-danger">{error}</p>}
    </article>
  );
}

/**
 * After Edit on X or LinkedIn (owner, 2026-09-27: "ok mi piace, vai così"):
 * neither lets an app read the posts scheduled on it, so PostEcho can't see
 * what changed there and the card asks for the one thing its Calendar needs,
 * the time. Save is live once the time differs; saved, the row goes and the
 * Calendar moves to the post's day.
 */
export function MovedRow({ post, now, onSave, onDone }: {
  post: Pick<PlanPost, "publishAt">;
  now: string;
  /** Resolves to an error message, or null once saved. */
  onSave: (publishAt: string) => Promise<string | null>;
  onDone: () => void;
}) {
  const [when, setWhen] = useState(() => toDatetimeLocal(post.publishAt));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const at = fromDatetimeLocal(when);
  const moved = at !== null && new Date(at).getTime() !== new Date(post.publishAt).getTime();

  async function save() {
    if (busy || !at || !moved) return;
    setBusy(true);
    setError(null);
    const failure = await onSave(at);
    setBusy(false);
    if (failure) setError(failure);
    else onDone();
  }

  return (
    <form onSubmit={(e) => { e.preventDefault(); void save(); }} className="flex flex-wrap items-center gap-2 text-xs text-text-dim">
      <label className="flex items-center gap-2">
        <span>Moved it?</span>
        <input type="datetime-local" value={when} min={toDatetimeLocal(now)} onChange={(e) => { setWhen(e.target.value); setError(null); }}
          className={timeInputCls} />
      </label>
      <button type="submit" disabled={busy || !moved} className={chipCls}>{busy ? "Saving…" : "Save"}</button>
      {error && <span className="basis-full text-danger">{error}</span>}
    </form>
  );
}

/**
 * Plan's Edit, as a dialog in front of the page (owner, 2026-09-24: "se
 * clicco edit mi aspetto una finestra davanti che mi fa modificare il tutto,
 * non… infilato aprendo la card"). A native <dialog> opened with showModal():
 * it sits above everything, keeps the keyboard inside, and Esc or a click on
 * the dimmed page closes it — asking first when there are unsaved changes.
 * Inside: the time (your own clock, like Write's Schedule sheet) with the
 * platform's next free default slots, and the text that goes out. Saves only
 * what changed; an emailed or failed post is queued again, and says so.
 */
export function ScheduleEditDialog({ post, now, onSave, onClose }: {
  post: PlanPost;
  now: string;
  onSave: (changes: { publishAt?: string; text?: string }) => Promise<string | null>;
  onClose: () => void;
}) {
  const whenRef = useRef<HTMLInputElement | null>(null);
  const titleId = useId();
  const [when, setWhen] = useState(() => toDatetimeLocal(post.publishAt));
  const [text, setText] = useState(post.text);
  const [slots, setSlots] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The platform's next free default slots — every setState after an await (react-hooks/set-state-in-effect).
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(`/api/scheduled-posts/slots?platform=${post.platform}`);
        if (!res.ok) return;
        const body = await res.json();
        const list: string[] = Array.isArray(body?.slots) ? body.slots.filter((s: unknown) => typeof s === "string") : [];
        if (!cancelled) setSlots(list.slice(0, 3));
      } catch (e) {
        console.error("failed to load free slots:", e);
      }
    })();
    return () => { cancelled = true; };
  }, [post.platform]);

  const at = fromDatetimeLocal(when);
  const xOver = post.platform === "x" && text.length > X_LIMIT;
  const changes = editChanges(post, at, text);

  function requestClose() {
    if (busy) return;
    if (changes && !window.confirm("Discard your changes?")) return;
    onClose();
  }

  async function save() {
    if (busy) return;
    if (!at) { setError("Pick a date and time."); return; }
    if (!changes) { onClose(); return; }
    setBusy(true);
    setError(null);
    const failure = await onSave(changes);
    setBusy(false);
    if (failure) setError(failure);
    else onClose();
  }

  return (
    <Modal labelledBy={titleId} onRequestClose={requestClose} initialFocus={whenRef}>
      <form onSubmit={(e) => { e.preventDefault(); void save(); }} className="space-y-4 p-5">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 space-y-1">
            <h2 id={titleId} className="text-base font-semibold">Edit {PLATFORM_LABEL[post.platform]} post</h2>
            <p className="text-xs text-text-dim">
              Scheduled for {formatRomeSlot(post.publishAt, now)}
              {post.ideaTitle ? ` · ${post.ideaTitle}` : ""}
            </p>
          </div>
          <button type="button" onClick={requestClose} disabled={busy} aria-label="Close"
            className="shrink-0 rounded-full border border-border px-2.5 py-0.5 text-sm text-text-dim hover:text-text disabled:opacity-50">
            ×
          </button>
        </div>

        <div className="space-y-2">
          <label className="block space-y-1.5">
            <span className="text-xs text-text-dim">When</span>
            <input ref={whenRef} type="datetime-local" value={when} min={toDatetimeLocal(now)} onChange={(e) => { setWhen(e.target.value); setError(null); }}
              className={inputCls} />
          </label>
          {slots.length > 0 && (
            <div className="flex flex-wrap items-center gap-1">
              <span className="text-xs text-text-dim">Free:</span>
              {slots.map((iso) => (
                <button key={iso} type="button" onClick={() => setWhen(toDatetimeLocal(iso))} className={chipCls} data-tip={new Date(iso).toLocaleString()}>
                  {formatRomeSlot(iso, now)}
                </button>
              ))}
            </div>
          )}
        </div>

        <label className="block space-y-1.5">
          <span className="flex items-center justify-between text-xs text-text-dim">
            <span>Text</span>
            {post.platform === "x" && <span className={xOver ? "text-danger" : ""}>{text.length}/{X_LIMIT}</span>}
          </span>
          <textarea value={text} onChange={(e) => { setText(e.target.value); setError(null); }} rows={post.platform === "x" ? 6 : 12}
            className={inputCls} />
        </label>

        {post.status === "emailed" && (
          <p className="text-xs text-text-dim">The email already went out. Saving queues it again, and a new email comes at the new time.</p>
        )}
        {post.status === "failed" && <p className="text-xs text-text-dim">Saving queues it again for the new time.</p>}
        {error && <p className="text-sm text-danger">{error}</p>}

        <div className="flex flex-wrap items-center justify-end gap-2 border-t border-border pt-4">
          <button type="button" onClick={requestClose} disabled={busy} className={pillCls}>Cancel</button>
          <button type="submit" disabled={busy || xOver || !text.trim()} className={primaryPillCls}>{busy ? "Saving…" : "Save changes"}</button>
        </div>
      </form>
    </Modal>
  );
}

/**
 * A post waiting for its vote in Plan's To rate list (rate-list.tsx): the platform, the day
 * and time it went out, what it said, and "How did it do?".
 */
export function RateCard({ post, rating = false, error = null, onRate }: {
  post: PlanPost;
  rating?: boolean;
  error?: string | null;
  onRate: (post: PlanPost, outcome: PlanOutcome | null) => void;
}) {
  const slot = slotLabel(post.publishAt);
  return (
    <article aria-label={`${PLATFORM_LABEL[post.platform]} post from ${slot}, to rate`} className={cardCls}>
      <div className="flex min-w-0 items-center gap-2 text-sm text-text-dim">
        <span className={platformPillCls}>{PLATFORM_TAG[post.platform]}</span>
        <span className="shrink-0 font-medium text-text">{slot}</span>
        {post.ideaTitle && <span className="min-w-0 truncate" data-tip={post.ideaTitle}>{post.ideaTitle}</span>}
      </div>
      <PostText post={post} />
      <RateRow outcome={post.outcome ?? null} disabled={rating} onRate={(next) => onRate(post, next)} />
      {error && <p className="text-xs text-danger">{error}</p>}
    </article>
  );
}
