"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ArchiveButton } from "@/components/archive";
import { formatRomeSlot } from "@/components/write/schedule-format";
import { DayList } from "./day-list";
import { DayNav, MonthGrid } from "./month-grid";
import { PostingTimes } from "./posting-times";
import { RateList } from "./rate-list";
import {
  dayKeyOf, dayRows, displayStatus, gridRangeUtc, groupByDay, inMonth, monthLabel, monthMatrix, monthOf,
  PLATFORM_LABEL, sameMonth, shiftDay, statusSummary, summaryLabel,
  type DayKey, type MonthKey, type PlanAction, type PlanOutcome, type PlanPost,
} from "./plan-calendar";

const JSON_HEADERS = { "Content-Type": "application/json" };
/** The header's To rate toggle and Posting times: the Today pill's shape (month-grid.tsx), filled like the selected day cell while open. */
const pillCls = "rounded-full border border-border px-3 py-1 text-xs font-medium hover:text-text";

/** One fetched grid: the month it was fetched for, the Rome day and the instant it was fetched at, and the rows. */
type Loaded = { month: MonthKey; today: DayKey; now: string; posts: PlanPost[] };
type Busy = { id: string; action: PlanAction };
/** What sits beside the grid: the selected day's list, or the posts to rate. */
type View = "days" | "rate";

/** The status a card shows the instant an action is clicked; the server's truth replaces it on the refetch that follows. */
const OPTIMISTIC: Record<PlanAction, Partial<PlanPost>> = {
  cancel: { status: "canceled" },
  remove: { status: "canceled" },
  resend: { status: "emailed" },
  retry: { status: "emailed", error: null },
  "mark-posted": { status: "posted_manually" },
};

const FAILURE: Record<PlanAction, string> = {
  cancel: "Failed to cancel.",
  remove: "Failed to remove it.",
  resend: "Failed to resend the email.",
  retry: "Failed to retry.",
  "mark-posted": "Failed to mark as posted.",
};

/**
 * The API call behind each action (all session-authed, see
 * api/scheduled-posts/**): cancel → DELETE /:id; resend and retry → POST
 * /:id/run, which sends (or re-sends) the due email now; mark-posted → POST
 * /mark-posted { draftId, platform }, which converts this row (lib/schedule.ts's
 * markPostedManually) — both platforms are human-in-the-loop, so it applies
 * to LinkedIn as much as to X.
 */
function request(post: PlanPost, action: PlanAction): Promise<Response> {
  switch (action) {
    case "cancel":
    case "remove":
      return fetch(`/api/scheduled-posts/${post.id}`, { method: "DELETE" });
    case "resend":
    case "retry":
      return fetch(`/api/scheduled-posts/${post.id}/run`, { method: "POST" });
    case "mark-posted":
      return fetch("/api/scheduled-posts/mark-posted", {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({ draftId: post.draftId, platform: post.platform }),
      });
  }
}

async function errorOf(res: Response, fallback: string): Promise<string> {
  const body = await res.json().catch(() => null);
  return typeof body?.error === "string" ? body.error : fallback;
}

/**
 * Plan (M3 plan, task P5): a Europe/Rome month grid of the queue and, for
 * the selected day, the free default slots and the scheduled posts with
 * their human-in-the-loop actions. Same "one client component owns the
 * page's state" shape as (authed)/page.tsx.
 *
 * Data: one GET /api/scheduled-posts per visible month — the whole grid's
 * range, adjacent-month cells included (plan-calendar.ts's gridRangeUtc) —
 * refetched after every action; GET /api/settings once, for
 * `defaultSlots`. Actions flip the card's status optimistically, then the
 * refetch brings the server's truth back; a failure shows inline on the
 * card. The wall clock is read only inside the load effect and the Today
 * handler, never in render (react-hooks/purity — see settings/page.tsx).
 *
 * Canceled rows leave the days (owner feedback 2026-09-23). The header's
 * **Archive (N)**, far right, is Write's (components/archive.tsx, owner
 * 2026-09-27: "entrambi devono portarti alla pagina"): the posts scheduled
 * or posted, in a window; See in Calendar shows the day here.
 */
export function PlanView({ initialDay }: { initialDay?: DayKey } = {}) {
  // null = the month today falls in, resolved when the grid loads.
  // `initialDay` (Plan's ?day=) opens that day and its month; otherwise today's, once loaded.
  const [monthKey, setMonthKey] = useState<MonthKey | null>(initialDay ? monthOf(initialDay) : null);
  // null = today (of the latest load).
  const [selected, setSelected] = useState<DayKey | null>(initialDay ?? null);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [defaultSlots, setDefaultSlots] = useState<Record<string, string[]>>({});
  // Posting times, edited here since the Publishing tab went (2026-09-27).
  const [editingTimes, setEditingTimes] = useState(false);
  const [busy, setBusy] = useState<Busy | null>(null);
  const [cardErrors, setCardErrors] = useState<Record<string, string>>({});
  const [view, setView] = useState<View>("days");
  // Posts out for more than a day with no vote yet, from any month (the header's To rate pill).
  const [toRate, setToRate] = useState<PlanPost[]>([]);
  // The post whose vote is being saved.
  const [rating, setRating] = useState<string | null>(null);

  // The grid. Every setState here happens after an await — the accepted
  // pattern for react-hooks/set-state-in-effect (see create/page.tsx).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const now = new Date();
      const today = dayKeyOf(now);
      const month = monthKey ?? monthOf(today);
      const { from, to } = gridRangeUtc(month);
      try {
        const res = await fetch(
          `/api/scheduled-posts?from=${encodeURIComponent(from.toISOString())}&to=${encodeURIComponent(to.toISOString())}`,
        );
        if (!res.ok) throw new Error(`scheduled-posts ${res.status}`);
        const body = await res.json();
        if (cancelled) return;
        const posts: PlanPost[] = Array.isArray(body?.posts) ? body.posts : [];
        setLoaded({ month, today, now: now.toISOString(), posts: posts.map((post) => displayStatus(post, now)) });
        setLoadError(null);
      } catch (e) {
        if (cancelled) return;
        console.error("failed to load the calendar:", e);
        // Keep what's on screen if it's this month's (a refetch after an
        // action failed); otherwise show the month empty rather than nothing.
        setLoaded((current) => (current && sameMonth(current.month, month)
          ? current
          : { month, today, now: now.toISOString(), posts: [] }));
        setLoadError("Failed to load the calendar.");
      }
    })();
    return () => { cancelled = true; };
  }, [monthKey, refreshKey]);

  // Default slots for the free-slot rows — optional: without them the day
  // list just shows the scheduled posts.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/settings");
        if (!res.ok) return;
        const body = await res.json();
        const slots = body?.settings?.defaultSlots;
        if (!cancelled && slots && typeof slots === "object") setDefaultSlots(slots as Record<string, string[]>);
      } catch (e) {
        console.error("failed to load default slots:", e);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // The posts to rate, fetched again with the grid (refreshKey). Optional: without them there's no pill.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/scheduled-posts?toRate=1");
        if (!res.ok) return;
        const body = await res.json();
        if (!cancelled) setToRate(Array.isArray(body?.posts) ? body.posts : []);
      } catch (e) {
        console.error("failed to load the posts to rate:", e);
      }
    })();
    return () => { cancelled = true; };
  }, [refreshKey]);

  /** Shows `day`'s list, the grid following it into its month. */
  function jumpTo(day: DayKey) {
    setMonthKey(monthOf(day));
    setSelected(day);
    setView("days");
  }

  /** ‹ ›: the day before or after the one shown. */
  function showDay(from: DayKey, delta: number) {
    jumpTo(shiftDay(from, delta));
  }

  /** Today: read the clock here (midnight may have passed since the load), then jump. */
  function goToday() {
    const today = dayKeyOf(new Date());
    setMonthKey(monthOf(today));
    setSelected(today);
  }

  /** A day in the grid: show it — leaving To rate if open, where the click would otherwise change nothing visible. */
  function selectDay(day: DayKey) {
    setSelected(day);
    setView("days");
  }

  async function act(post: PlanPost, action: PlanAction) {
    if (busy || !loaded) return;
    if (action === "cancel") {
      const when = formatRomeSlot(post.publishAt, loaded.now);
      if (!window.confirm(`Cancel the ${PLATFORM_LABEL[post.platform]} post scheduled for ${when}? It leaves the queue.`)) return;
    }
    if (action === "remove") {
      const label = PLATFORM_LABEL[post.platform];
      if (!window.confirm(`Remove this ${label} post from your Calendar? It stays scheduled on ${label} until you delete it there.`)) return;
    }
    setBusy({ id: post.id, action });
    setCardErrors((current) => {
      const next = { ...current };
      delete next[post.id];
      return next;
    });
    setLoaded((current) => (current
      ? { ...current, posts: current.posts.map((p) => (p.id === post.id ? { ...p, ...OPTIMISTIC[action] } : p)) }
      : current));
    try {
      const res = await request(post, action);
      if (!res.ok) {
        const message = await errorOf(res, FAILURE[action]);
        setCardErrors((current) => ({ ...current, [post.id]: message }));
      }
    } catch (e) {
      console.error(`plan: ${action} failed:`, e);
      setCardErrors((current) => ({ ...current, [post.id]: FAILURE[action] }));
    } finally {
      setBusy(null);
      setRefreshKey((k) => k + 1);
    }
  }

  /**
   * Plan's Edit (2026-09-24): PATCH /api/scheduled-posts/:id with what
   * changed, then the calendar refetches and moves to the day the post is on
   * now. Resolves to the error to show in the card, or null once saved.
   */
  async function edit(post: PlanPost, changes: { publishAt?: string; text?: string }): Promise<string | null> {
    try {
      const res = await fetch(`/api/scheduled-posts/${post.id}`, { method: "PATCH", headers: JSON_HEADERS, body: JSON.stringify(changes) });
      if (!res.ok) return await errorOf(res, "Failed to save the changes.");
      const body = await res.json().catch(() => null);
      const at = typeof body?.post?.publishAt === "string" ? body.post.publishAt : changes.publishAt;
      if (at) jumpTo(dayKeyOf(new Date(at)));
      return null;
    } catch (e) {
      console.error("plan: edit failed:", e);
      return "Network error: nothing was saved.";
    } finally {
      setRefreshKey((k) => k + 1);
    }
  }

  /**
   * Plan's vote (2026-09-26): PATCH /api/scheduled-posts/:id { outcome }, shown at once — on
   * the card, and off the To rate list — then the server's truth comes back with the refetch.
   */
  async function rate(post: PlanPost, outcome: PlanOutcome | null) {
    if (rating) return;
    setRating(post.id);
    setCardErrors((current) => {
      const next = { ...current };
      delete next[post.id];
      return next;
    });
    setLoaded((current) => (current
      ? { ...current, posts: current.posts.map((p) => (p.id === post.id ? { ...p, outcome } : p)) }
      : current));
    if (outcome !== null) setToRate((current) => current.filter((p) => p.id !== post.id));
    try {
      const res = await fetch(`/api/scheduled-posts/${post.id}`, { method: "PATCH", headers: JSON_HEADERS, body: JSON.stringify({ outcome }) });
      if (!res.ok) {
        const message = await errorOf(res, "Failed to save the vote.");
        setCardErrors((current) => ({ ...current, [post.id]: message }));
      }
    } catch (e) {
      console.error("plan: vote failed:", e);
      setCardErrors((current) => ({ ...current, [post.id]: "Network error: the vote wasn't saved." }));
    } finally {
      setRating(null);
      setRefreshKey((k) => k + 1);
    }
  }

  if (!loaded) {
    return (
      <div className="space-y-6">
        <h1 className="text-lg font-bold tracking-tight">Calendar</h1>
        {loadError
          ? <p className="text-sm text-danger">{loadError}</p>
          : <p className="text-sm text-text-dim">Loading…</p>}
      </div>
    );
  }

  const { month, today, now, posts } = loaded;
  const weeks = monthMatrix(month);
  const postsByDay = groupByDay(posts);
  // The header counts the month itself, not the adjacent cells the fetch also covers.
  const summary = summaryLabel(statusSummary(posts.filter((p) => inMonth(p.publishAt, month))));
  const day = selected ?? today;
  const rows = dayRows({ day, posts: postsByDay.get(day) ?? [], defaultSlots, now });

  return (
    <div className="space-y-6">
      {editingTimes && <PostingTimes slots={defaultSlots} onSaved={setDefaultSlots} onClose={() => setEditingTimes(false)} />}
      <header className="space-y-1">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <h1 className="text-lg font-bold tracking-tight">Calendar</h1>
          <span className="text-sm text-text-dim">{monthLabel(month)}</span>
          <DayNav
            onPrev={() => showDay(day, -1)}
            onNext={() => showDay(day, 1)}
            onToday={goToday}
          />
          {/* Far right (owner, 2026-09-27: "today, poi frecce e tutto a dx archive"). */}
          <div className="ml-auto flex items-center gap-2">
            {(toRate.length > 0 || view === "rate") && (
              <button
                type="button"
                onClick={() => setView((current) => (current === "rate" ? "days" : "rate"))}
                aria-pressed={view === "rate"}
                data-tip="Tell PostEcho how your latest posts did"
                className={`${pillCls} ${view === "rate" ? "bg-surface-2 text-text" : "text-text-dim"}`}
              >
                To rate ({toRate.length})
              </button>
            )}
            <ArchiveButton refreshKey={refreshKey} onSeeDay={jumpTo} />
          </div>
        </div>
        <p className="text-sm text-text-dim">
          {summary ?? (
            <>
              Nothing scheduled — pick a post in{" "}
              <Link href="/create" className="underline hover:text-text">Compose</Link> and press Schedule.
            </>
          )}
        </p>
        {loadError && <p className="text-sm text-danger">{loadError}</p>}
      </header>

      {/* Phone: the grid full width, the day list beneath. From lg up (the
          authed layout leaves ~500px at md — too little for two columns):
          the grid fixed at 360px on the left, the day list taking the rest. */}
      <div className="grid gap-6 lg:grid-cols-[360px_minmax(0,1fr)] lg:items-start">
        <div className="w-full max-w-md lg:max-w-none">
          <MonthGrid weeks={weeks} today={today} selected={day} postsByDay={postsByDay} onSelect={selectDay} />
          {/* Under the grid (owner, 2026-09-27: "l'avrei messo sotto il calendario, tanto in calendar hai solo un posto dove vedi il lavoro fatto e quello che avviene"). */}
          <button type="button" onClick={() => setEditingTimes(true)} data-tip="The times Schedule suggests"
            className={`${pillCls} mt-3 text-text-dim`}>
            Posting times
          </button>
        </div>
        {view === "rate"
          ? <RateList posts={toRate} rating={rating} errors={cardErrors} onRate={rate} onBack={() => setView("days")} />
          : (
            <DayList
              day={day}
              isToday={day === today}
              rows={rows}
              now={now}
              busy={busy}
              errors={cardErrors}
              onAction={act}
              onEdit={edit}
              rating={rating}
              onRate={rate}
            />
          )}
      </div>
    </div>
  );
}
