"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { SlopBadge, type SlopResult } from "@/components/slop-badge";
import { composerUrl as linkedinComposerUrl } from "@/lib/publishers/linkedin";
import type { Voice } from "@/lib/voice";
import { CREATE_LINKEDIN, EditChat, UPDATE_LINKEDIN, useEditRequests, WRITE_X } from "./edit-chat";
import { persistedSlop, PLATFORM_LABEL } from "./post-state";
import { openComposer, ScheduleDialog, type ScheduleTarget } from "./schedule-dialog";
import { formatRomeSlot, xIntentUrl } from "./schedule-format";
import { TagTools, type TextSelection } from "./tag-tools";
import type { Draft, Platform } from "./types";

const X_LIMIT = 280;
const JSON_HEADERS = { "Content-Type": "application/json" };

/** The inline sheet under the actions row (Post now; Schedule is a window, schedule-dialog.tsx). */
type Sheet = "post-now";

const textareaCls =
  "w-full rounded-lg border border-border bg-surface-2 px-3 py-2 text-sm outline-none focus:border-text-dim";
const pillCls = "rounded-full border border-border px-4 py-2 text-sm text-text-dim hover:text-text disabled:opacity-50";
const primaryPillCls = "rounded-full bg-accent px-4 py-2 text-sm font-medium text-accent-ink disabled:opacity-50";
const sheetCls = "space-y-3 rounded-lg border border-border bg-surface p-4";

async function errorOf(res: Response, fallback: string): Promise<string> {
  const body = await res.json().catch(() => null);
  return typeof body?.error === "string" ? body.error : fallback;
}

/**
 * The post itself (M2.5 plan, task W3) — shown once a take is chosen. The
 * X/LinkedIn editor from the old Create tab (task A8's draft-editor.tsx,
 * absorbed here) minus Keep, which is now **Pick this** in the takes row:
 * autosave on blur with an "Unsaved" hint, Refine, Slop check and
 * **Humanize** per platform (M3.5, task U2 — see runHumanize), ★ favorite,
 * Discard take, and — M3, plan P1 — **Schedule** and **Post now**, both
 * enabled once at least one platform has text. Every action flushes an
 * unsaved edit first (via `patchDraft`) so it's never silently lost.
 *
 * Schedule (2026-09-24) opens a window (schedule-dialog.tsx) where the owner,
 * having scheduled the post with each platform's own scheduler, tells
 * PostEcho the time; Plan keeps it as scheduled. No timer, no email. A
 * one-platform post also opens that platform's composer at once; with both,
 * the owner opens X, then LinkedIn, from the window.
 * Post now: X opens the official intent, LinkedIn its composer prefill
 * (lib/publishers/linkedin.ts — both platforms are human-in-the-loop, owner
 * decision 2026-09-22), each in a new tab and each followed by **Mark as
 * posted** for that platform (POST /api/scheduled-posts/mark-posted).
 * Both mark the draft `used` server-side, which takes it OUT of Write's
 * takes row on the next load — so, deliberately, neither calls
 * `onMutated()`: a reload would unmount this editor along with the window,
 * the "Scheduled: …" confirmation and its "See in Plan" link. The page shows
 * the truth the next time it loads this post. The autosave flush before
 * those two actions is silent (`notify: false`) for the same reason — the
 * reload it would trigger could land after the draft became used.
 *
 * Refine's status dance: the revision is materialized as `kept` with
 * `parentId` = this draft (lib/materialize.ts), so once its job is done the
 * page — via `onRefined(draft.id)` — demotes THIS draft to `candidate` and
 * reloads; the revision is then the chosen take and this editor remounts
 * on it (`key={draft.id}` at the call site), showing "v2 · back to v1".
 * "back to v1" re-picks the parent through the same two-PATCH pick as the
 * takes row (see pickTake in app/(authed)/create/page.tsx).
 */
/** Where Pick this scrolls to (app/(authed)/create/page.tsx). */
export const YOUR_POST_ID = "your-post";

export function PostEditor({ draft, chain, voice, tab, onTab, onMutated, onRefined, onPickVersion, onReady }: {
  /** The chosen take. */
  draft: Draft;
  /** The whole chain, v1 first — Edit with Claude's thread. */
  chain: Draft[];
  /** The post's voice (lib/voice.ts) — what Edit with Claude writes in and offers to switch. */
  voice: Voice;
  /** The platform tab on screen, kept by the page so a new version (which remounts this) stays on it. */
  tab: Platform;
  onTab: (tab: Platform) => void;
  /** A field (text, status, favorite) changed in place — the page refetches. */
  onMutated: () => void;
  /** The revise_draft job finished; `supersededId` is this draft, to be demoted. */
  onRefined: (supersededId: string) => Promise<void>;
  /** "back to vN-1": re-pick that version. */
  onPickVersion: (id: string) => void;
  /** Ready was saved: the post is in Schedule's list now. Without it, the page just refetches. */
  onReady?: () => void;
}) {
  const [xDraft, setXDraft] = useState(draft.xText ?? "");
  const [linkedinDraft, setLinkedinDraft] = useState(draft.linkedinText ?? "");
  // What's selected in each text, for the tag tools (tag-tools.tsx).
  const [xSelection, setXSelection] = useState<TextSelection | null>(null);
  const [linkedinSelection, setLinkedinSelection] = useState<TextSelection | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);

  // Human scores per platform (lib/human-score.ts): persisted on the draft,
  // refreshed after every saved edit (autoCheck) and on every Claude reply.
  const [slopX, setSlopX] = useState<SlopResult | null>(persistedSlop(draft, "x"));
  const [slopLinkedin, setSlopLinkedin] = useState<SlopResult | null>(persistedSlop(draft, "linkedin"));
  // LinkedIn is optional (owner, 2026-09-24: "tutto il discorso linkedin va
  // messo come eventuale… farti vedere solo X"): its editor shows once the
  // post has a LinkedIn version, or the owner chose to write one.
  const [showLinkedin, setShowLinkedin] = useState(Boolean(draft.linkedinText?.trim()));

  const [statusBusy, setStatusBusy] = useState(false);
  // Schedule's dropdown (owner, 2026-09-24: "Schedule bianco come primary e un
  // dropdown che mi fa cliccare il post now — lo faremo poco").
  const [moreOpen, setMoreOpen] = useState(false);
  const moreRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!moreOpen) return;
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent ? e.key === "Escape" : !moreRef.current?.contains(e.target as Node)) setMoreOpen(false);
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", close);
    };
  }, [moreOpen]);

  const [sheet, setSheet] = useState<Sheet | null>(null);
  // Schedule's window (2026-09-24): open, with the platform whose composer the
  // click opened and when (UTC ISO, "now" for its labels — fixed so render stays pure).
  const [scheduleWindow, setScheduleWindow] = useState<{ openedFirst: Platform | null; at: string } | null>(null);
  /** What the window recorded, per platform: the time it's scheduled for there. */
  const [scheduledOn, setScheduledOn] = useState<Array<{ platform: Platform; publishAt: string; at: string }>>([]);

  /** Which platform's composer Post now last opened — the one Mark as posted records. */
  const [intentOpened, setIntentOpened] = useState<Platform | null>(null);
  const [markBusy, setMarkBusy] = useState(false);
  const [markError, setMarkError] = useState<string | null>(null);
  const [markedPosted, setMarkedPosted] = useState<Platform[]>([]);

  const dirty = xDraft !== (draft.xText ?? "") || linkedinDraft !== (draft.linkedinText ?? "");

  /**
   * PATCHes `fields` (plus the unsaved texts when dirty). `notify: false`
   * skips the page reload that normally follows — see the component note on
   * why Schedule and Post now need that.
   */
  async function patchDraft(fields: Record<string, unknown>, { notify = true } = {}): Promise<boolean> {
    const body = dirty ? { xText: xDraft, linkedinText: linkedinDraft, ...fields } : fields;
    if (Object.keys(body).length === 0) return true;
    try {
      const res = await fetch(`/api/drafts/${draft.id}`, {
        method: "PATCH",
        headers: JSON_HEADERS,
        body: JSON.stringify(body),
      });
      if (!res.ok) { setSaveError("Failed to save."); return false; }
      setSaveError(null);
      if (notify) onMutated();
      return true;
    } catch {
      setSaveError("network error");
      return false;
    }
  }

  function saveIfDirty() {
    if (!dirty) return;
    const x = xDraft;
    const linkedin = linkedinDraft;
    const changedX = x !== (draft.xText ?? "");
    const changedLinkedin = linkedin !== (draft.linkedinText ?? "");
    void patchDraft({}).then((saved) => {
      if (!saved) return;
      if (changedX) void autoCheck("x", x);
      if (changedLinkedin) void autoCheck("linkedin", linkedin);
    });
  }

  /** A name in the X text became its @handle (tag-tools.tsx): saved at once, then re-scored. */
  function tagInX(next: string) {
    setXDraft(next);
    setXSelection(null);
    void patchDraft({ xText: next }).then((saved) => {
      if (saved) void autoCheck("x", next);
    });
  }

  async function setStatusOrFavorite(fields: { status?: "discarded" } | { favorite: boolean }) {
    if (statusBusy) return;
    setStatusBusy(true);
    try {
      await patchDraft(fields);
    } finally {
      setStatusBusy(false);
    }
  }

  /**
   * Ready / Back to Compose (PATCH { ready }, unsaved texts with it). Ready hands over to the page, which
   * moves on to the next post in progress; Back to Compose reloads, and the post is in the strip again.
   */
  async function setReady(ready: boolean) {
    if (statusBusy) return;
    setStatusBusy(true);
    try {
      if (!(await patchDraft({ ready }, { notify: false }))) return;
      if (ready && onReady) onReady(); else onMutated();
    } finally {
      setStatusBusy(false);
    }
  }

  /**
   * Re-scores a platform's text once an edit to it is saved (M3.7: the
   * per-platform Slop check buttons became this), so its human score never
   * describes an older text. Silent: without a Jev key (503) or on a failed
   * check the badge keeps its last score.
   */
  async function autoCheck(platform: Platform, text: string) {
    const set = platform === "x" ? setSlopX : setSlopLinkedin;
    if (!text.trim()) { set(null); return; }
    try {
      const res = await fetch("/api/slop-check", {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({ text, platform, draftId: draft.id }),
      });
      if (!res.ok) return;
      const body = await res.json().catch(() => null);
      if (body?.slop && typeof body.slop.slopScore === "number" && typeof body.slop.verdict === "string") {
        set({ verdict: body.slop.verdict, slopScore: body.slop.slopScore });
      }
    } catch {
      // The badge keeps its last score.
    }
  }

  // Edit with Claude's requests — the "+ Create a LinkedIn post" button is one of them.
  const chat = useEditRequests({
    draftId: draft.id,
    flush: () => patchDraft({}, { notify: false }),
    onDone: () => onRefined(draft.id),
  });

  async function removeLinkedin() {
    if (!window.confirm("Remove the LinkedIn version from this post? Earlier versions keep theirs.")) return;
    onTab("x");
    setShowLinkedin(false);
    setLinkedinDraft("");
    setSlopLinkedin(null);
    await patchDraft({ linkedinText: "" });
  }

  const xOverLimit = xDraft.length > X_LIMIT;
  const hasX = xDraft.trim().length > 0;
  const hasLinkedin = linkedinDraft.trim().length > 0;
  const canAct = hasX || hasLinkedin;

  /** Opens (or closes, when already open) the Post now sheet. */
  function toggleSheet(next: Sheet) {
    if (sheet === next) { setSheet(null); return; }
    setSheet(next);
    setMarkError(null);
  }

  /**
   * Schedule (owner, 2026-09-24: "mi apra un post con il testo dentro di X e
   * io posso schedularlo subito"): a one-platform post opens that platform's
   * own composer with the text right inside the click (popup blockers only
   * honor window.open during the user gesture), then the window where the
   * owner tells PostEcho the time they scheduled it for. With both platforms
   * the window comes first (2026-09-25: "bring in the popup in the app so that
   * I can do one after the other and then mark them as done"). The autosave
   * flush is silent: the page must not reload under the window.
   */
  function openSchedule() {
    setMoreOpen(false);
    setSheet(null);
    const only: Platform | null = hasX && !hasLinkedin ? (xOverLimit ? null : "x") : !hasX && hasLinkedin ? "linkedin" : null;
    if (only) openComposer(only, only === "x" ? xDraft : linkedinDraft);
    setScheduleWindow({ openedFirst: only, at: new Date().toISOString() });
    void patchDraft({}, { notify: false });
  }

  /**
   * Post now → X: the official intent, opened synchronously inside the click
   * (popup blockers only honor window.open during the user gesture), then the
   * autosave flush; the text in the intent is the text on screen either way.
   */
  function postNowOnX() {
    if (!hasX || xOverLimit) return;
    window.open(xIntentUrl(xDraft), "_blank", "noopener");
    setIntentOpened("x");
    setMarkError(null);
    void patchDraft({}, { notify: false });
  }

  /** Post now → LinkedIn: the composer prefill, opened the same way (synchronously, inside the click). */
  function postNowOnLinkedin() {
    if (!hasLinkedin) return;
    window.open(linkedinComposerUrl(linkedinDraft), "_blank", "noopener");
    setIntentOpened("linkedin");
    setMarkError(null);
    void patchDraft({}, { notify: false });
  }

  async function markPosted() {
    const platform = intentOpened;
    if (markBusy || !platform) return;
    setMarkBusy(true);
    setMarkError(null);
    try {
      if (!(await patchDraft({}, { notify: false }))) {
        setMarkError("Could not save your edits.");
        return;
      }
      const res = await fetch("/api/scheduled-posts/mark-posted", {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({ draftId: draft.id, platform }),
      });
      if (!res.ok) {
        setMarkError(await errorOf(res, "Failed to mark as posted."));
        return;
      }
      setMarkedPosted((current) => (current.includes(platform) ? current : [...current, platform]));
    } catch {
      setMarkError("network error");
    } finally {
      setMarkBusy(false);
    }
  }

  const scheduleTargets: ScheduleTarget[] = [
    ...(hasX ? [{ platform: "x" as const, text: xDraft }] : []),
    ...(hasLinkedin ? [{ platform: "linkedin" as const, text: linkedinDraft }] : []),
  ];

  // LinkedIn follows X (owner: "se modifica entrambi non serve update Linkedin from X"): only once
  // X was edited by hand after LinkedIn was written — a chat request already changes both.
  const xAtLinkedin = typeof draft.meta.xAtLinkedin === "string" ? draft.meta.xAtLinkedin : null;
  const linkedinBehind = hasX && hasLinkedin && xAtLinkedin !== null && xAtLinkedin.trim() !== xDraft.trim();
  const tabCls = (on: boolean) => `rounded-full px-3 py-1 text-sm ${on ? "bg-surface-2 font-medium text-text" : "text-text-dim hover:text-text"}`;
  // The tabs only once there's a LinkedIn version; until then the text is X's.
  const shown: Platform = showLinkedin ? tab : "x";

  return (
    <section id={YOUR_POST_ID} aria-label="Your post" className="flex scroll-mt-6 flex-col gap-4">
      {/* One card (owner, 2026-09-27: "lo vedo in casinato… il create linkedin post forse meno visibile"): X, and a button
          that writes the LinkedIn post from the source and the X together ("non ha senso scriverlo da soli"); once it exists,
          X and LinkedIn are tabs. */}
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="text-sm font-medium text-text-dim">Your post</h2>
        {showLinkedin ? (
          <div role="tablist" aria-label="Platform" className="flex rounded-full border border-border p-0.5">
            <button type="button" role="tab" aria-selected={shown === "x"} onClick={() => onTab("x")} className={tabCls(shown === "x")}>X</button>
            <button type="button" role="tab" aria-selected={shown === "linkedin"} onClick={() => onTab("linkedin")}
              data-tip="The LinkedIn version" className={`${tabCls(shown === "linkedin")} inline-flex items-center gap-1.5`}>
              LinkedIn
              {linkedinBehind && <span aria-label="behind your X" className="h-1.5 w-1.5 rounded-full bg-accent" />}
            </button>
          </div>
        ) : (
          <>
            <span className="rounded-full border border-border px-3 py-1 text-sm text-text">X</span>
            <button type="button" onClick={() => { onTab("linkedin"); void chat.send(CREATE_LINKEDIN); }} disabled={chat.busy || !hasX}
              data-tip={hasX ? "Write the LinkedIn post from the source and your X" : "Write the X post first"}
              className="rounded-full border border-dashed border-border px-3 py-1 text-xs text-text-dim hover:border-text-dim hover:text-text disabled:opacity-50">
              {chat.runningMode === "sync_linkedin" ? "Writing the LinkedIn post…" : "+ Create LinkedIn post"}
            </button>
          </>
        )}
        <span className="ml-auto flex items-center gap-2">
          <SlopBadge slop={shown === "x" ? slopX : slopLinkedin} />
          {shown === "x" && <span className={`text-xs tabular-nums ${xOverLimit ? "text-danger" : "text-text-dim"}`}>{xDraft.length}/{X_LIMIT}</span>}
        </span>
      </div>

      {shown === "x" ? (
        <div role="tabpanel" aria-label="X" className="space-y-1.5">
          {!hasX && hasLinkedin && (
            <button type="button" onClick={() => void chat.send(WRITE_X)} disabled={chat.busy}
              data-tip="The same point in 280 characters" className="rounded-full border border-border px-3 py-1 text-xs text-text-dim hover:text-text disabled:opacity-50">
              {chat.runningMode === "sync_x" ? "Writing the X post…" : "Write X from LinkedIn"}
            </button>
          )}
          <textarea
            value={xDraft}
            onChange={(e) => setXDraft(e.target.value)}
            onSelect={(e) => setXSelection({ start: e.currentTarget.selectionStart, end: e.currentTarget.selectionEnd })}
            onBlur={saveIfDirty}
            rows={6}
            aria-label="X text"
            className={textareaCls}
          />
          <TagTools platform="x" text={xDraft} selection={xSelection} onTag={tagInX} />
        </div>
      ) : (
        <div role="tabpanel" aria-label="LinkedIn" className="space-y-1.5">
          <textarea
            value={linkedinDraft}
            onChange={(e) => setLinkedinDraft(e.target.value)}
            onSelect={(e) => setLinkedinSelection({ start: e.currentTarget.selectionStart, end: e.currentTarget.selectionEnd })}
            onBlur={saveIfDirty}
            rows={10}
            aria-label="LinkedIn text"
            className={textareaCls}
          />
          <TagTools platform="linkedin" text={linkedinDraft} selection={linkedinSelection} />
          <div className="flex flex-wrap items-center gap-2 text-xs text-text-dim">
            {linkedinBehind && (
              <>
                <span>Your X changed since this was written.</span>
                <button type="button" onClick={() => void chat.send(UPDATE_LINKEDIN)} disabled={chat.busy}
                  data-tip="LinkedIn follows your X: same point and angle, with the source for the detail X has no room for"
                  className="rounded-full border border-border px-3 py-1 hover:text-text disabled:opacity-50">
                  {chat.runningMode === "sync_linkedin" ? "Updating…" : "Update from X"}
                </button>
              </>
            )}
            <button type="button" onClick={() => void removeLinkedin()} disabled={chat.busy} className="ml-auto hover:text-danger disabled:opacity-50">
              Remove LinkedIn
            </button>
          </div>
        </div>
      )}

      {(dirty || saveError) && (
        <p className={`text-xs ${saveError ? "text-danger" : "text-text-dim"}`}>
          {saveError ?? "Unsaved — saves when you click away"}
        </p>
      )}

      <EditChat
        draft={draft}
        chain={chain}
        voice={voice}
        xText={xDraft}
        linkedinText={linkedinDraft}
        scores={{ x: slopX, linkedin: slopLinkedin }}
        chat={chat}
        onRestore={onPickVersion}
      />

      <div className="flex flex-wrap items-center gap-2 pt-2">
        <button
          type="button"
          onClick={() => setStatusOrFavorite({ favorite: !draft.favorite })}
          disabled={statusBusy}
          data-tip={draft.favorite ? "Remove the star" : "Star this version"}
          aria-label={draft.favorite ? "Remove favorite" : "Mark favorite"}
          aria-pressed={draft.favorite}
          className={`rounded-full border px-3 py-2 text-sm disabled:opacity-50 ${
            draft.favorite ? "border-accent text-text" : "border-border text-text-dim hover:text-text"
          }`}
        >
          {draft.favorite ? "★" : "☆"}
        </button>
        <button
          type="button"
          onClick={() => setStatusOrFavorite({ status: "discarded" })}
          disabled={statusBusy}
          className="rounded-full border border-border px-4 py-2 text-sm text-text-dim hover:border-danger hover:text-danger disabled:opacity-50"
        >
          Discard
        </button>
        {/* Where it's scheduled, as a quiet pill by Schedule (2026-09-27): a click opens Schedule. */}
        {scheduledOn.length > 0 && (
          <Link href="/calendar" role="status" data-tip="See it in Schedule"
            className="ml-auto rounded-full bg-ok/10 px-3 py-1 text-xs text-ok hover:bg-ok/20">
            ✓ {scheduledOn.map((entry) => `${PLATFORM_LABEL[entry.platform]} · ${formatRomeSlot(entry.publishAt, entry.at)}`).join(", ")}
          </Link>
        )}
        {/* Ready (schedule in a row, 2026-10-10): the post leaves Compose for Schedule's list, to be scheduled with
            the others in one sitting. A ready post, opened from that list, goes back with Back to Compose. */}
        <button
          type="button"
          onClick={() => void setReady(!draft.readyAt)}
          disabled={statusBusy || (!draft.readyAt && (!canAct || xOverLimit))}
          data-tip={draft.readyAt ? undefined : !canAct ? "Write the post first" : xOverLimit ? `The X text is over ${X_LIMIT} characters` : "Line it up in Schedule with your other ready posts"}
          className={`${pillCls} ${scheduledOn.length > 0 ? "" : "ml-auto"}`}
        >
          {draft.readyAt ? "Back to Compose" : "Ready"}
        </button>
        <div ref={moreRef} className="relative flex">
          <button
            type="button"
            onClick={openSchedule}
            disabled={!canAct}
            data-tip={!canAct ? "Write the post first" : hasX && hasLinkedin ? "Schedule it on X, then LinkedIn" : `Open ${hasX ? "X" : "LinkedIn"} with the text to schedule it`}
            aria-haspopup="dialog"
            className="rounded-l-full bg-accent py-2 pl-4 pr-3 text-sm font-medium text-accent-ink disabled:opacity-50"
          >
            Schedule
          </button>
          <button
            type="button"
            onClick={() => setMoreOpen((open) => !open)}
            disabled={!canAct}
            aria-haspopup="menu"
            aria-expanded={moreOpen}
            aria-label="More ways to publish"
            className="rounded-r-full border-l border-accent-ink/20 bg-accent py-2 pl-2 pr-3 text-sm text-accent-ink disabled:opacity-50"
          >
            ▾
          </button>
          {moreOpen && (
            <div role="menu" className="absolute right-0 top-full z-10 mt-1 min-w-40 rounded-xl border border-border bg-surface-2 p-1 shadow-lg">
              <button
                type="button"
                role="menuitem"
                onClick={() => { setMoreOpen(false); toggleSheet("post-now"); }}
                className="w-full rounded-lg px-3 py-2 text-left text-sm text-text hover:bg-surface"
              >
                Post now
              </button>
            </div>
          )}
        </div>
      </div>

      {scheduleWindow && (
        <ScheduleDialog
          draftId={draft.id}
          targets={scheduleTargets}
          openedFirst={scheduleWindow.openedFirst}
          now={scheduleWindow.at}
          flush={() => patchDraft({}, { notify: false })}
          onScheduled={(platform, publishAt) => setScheduledOn((current) => [
            ...current.filter((entry) => entry.platform !== platform),
            { platform, publishAt, at: scheduleWindow.at },
          ])}
          onClose={() => setScheduleWindow(null)}
        />
      )}

      {sheet === "post-now" && (
        <div role="group" aria-label="Post now" className={sheetCls}>
          <span className="text-sm font-medium text-text-dim">Post now</span>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={postNowOnX}
              disabled={!hasX || xOverLimit}
              data-tip={!hasX ? "There's no X text" : xOverLimit ? `The X text is over ${X_LIMIT} characters` : "Open X with the text ready to post"}
              className={pillCls}
            >
              X
            </button>
            <button
              type="button"
              onClick={postNowOnLinkedin}
              disabled={!hasLinkedin}
              data-tip={hasLinkedin ? "Open LinkedIn with the text ready to post" : "There's no LinkedIn text"}
              className={pillCls}
            >
              LinkedIn
            </button>
          </div>
          {intentOpened && !markedPosted.includes(intentOpened) && (
            <div className="flex flex-wrap items-center gap-2">
              <p className="text-sm text-text-dim">Posted it on {PLATFORM_LABEL[intentOpened]}?</p>
              <button type="button" onClick={markPosted} disabled={markBusy} className={primaryPillCls}>
                {markBusy ? "Marking…" : "Mark as posted"}
              </button>
            </div>
          )}
          {markedPosted.length > 0 && (
            <p role="status" className="text-sm text-ok">
              Marked as posted: {markedPosted.map((platform) => PLATFORM_LABEL[platform]).join(", ")} ·{" "}
              <Link href="/calendar" className="underline hover:text-text">See in Schedule</Link>
            </p>
          )}
          {markError && <p className="text-sm text-danger">{markError}</p>}
        </div>
      )}
    </section>
  );
}
