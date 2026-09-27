/**
 * Pure calendar math for the Plan tab (M3 plan, task P5) — no React, no
 * fetch, unit-tested in plan-calendar.test.ts. Everything the owner sees is
 * Europe/Rome wall clock (spec: "timezone handled once — Europe/Rome
 * display, UTC storage"); GET /api/scheduled-posts speaks UTC instants.
 *
 * The two Rome wall-clock primitives below (romeWallClock, romeToUtc) mirror
 * lib/schedule.ts's wallClockOf / wallClockToUtc, which schedule.test.ts
 * proves across both DST changes and midnight. They're re-implemented rather
 * than imported because lib/schedule.ts pulls drizzle and the db schema into
 * whatever imports it — fine on the server, not in a client bundle. The
 * zone itself comes from the Write helpers so the client has one source.
 */
import { TIME_ZONE } from "@/components/write/schedule-format";

export type PlanPlatform = "x" | "linkedin";
/** schedule_status as db/schema.ts spells it — single-l "canceled"; `published` is reserved for the optional API path. */
// "scheduled" is derived, never stored (2026-09-24): a post the owner
// scheduled on X or LinkedIn itself — posted_manually with its time still
// ahead (lib/schedule.ts's isScheduledOnPlatform); see displayStatus.
export type PlanStatus = "queued" | "emailed" | "published" | "posted_manually" | "failed" | "canceled" | "scheduled";
/** Plan's vote on a post that is out (2026-09-26: "sia se è andato bene che se è andato male") — lib/schedule.ts's rateSchedule. */
export type PlanOutcome = "good" | "bad";

/**
 * One queue row as GET /api/scheduled-posts returns it (lib/schedule.ts's
 * ScheduleListItem, timestamps serialized as ISO strings). Only the fields
 * the Plan tab reads are typed; the rest ride along untyped.
 */
export type PlanPost = {
  id: string;
  draftId: string;
  platform: PlanPlatform;
  /** The platform text frozen at scheduling time — what the email carries. */
  text: string;
  /** UTC ISO. */
  publishAt: string;
  status: PlanStatus;
  publishedUrl: string | null;
  error: string | null;
  emailedAt: string | null;
  publishedAt: string | null;
  ideaTitle: string | null;
  /** The source's link, for a first comment (lib/schedule.ts's sourceUrlOf); absent on older payloads. */
  sourceUrl?: string | null;
  /** The owner's vote on how it did; null or absent until they vote. */
  outcome?: PlanOutcome | null;
};

export const PLATFORM_LABEL: Record<PlanPlatform, string> = { x: "X", linkedin: "LinkedIn" };
/** The short pill form on cards and slot rows. */
export const PLATFORM_TAG: Record<PlanPlatform, string> = { x: "X", linkedin: "LI" };
const PLATFORMS: PlanPlatform[] = ["x", "linkedin"];

/** "YYYY-MM-DD" as read on a Europe/Rome wall clock — sorts lexicographically = chronologically. */
export type DayKey = string;
/** A calendar month; `month` is 1–12. */
export type MonthKey = { year: number; month: number };

const MS_PER_MINUTE = 60_000;
const pad2 = (n: number) => String(n).padStart(2, "0");

// ---------------------------------------------------------------------------
// Europe/Rome wall clock
// ---------------------------------------------------------------------------

export type WallClock = { year: number; month: number; day: number; hour: number; minute: number };

// hourCycle h23 (not hour12: false) so midnight reads "00", never "24".
const romeParts = new Intl.DateTimeFormat("en-US", {
  timeZone: TIME_ZONE, hourCycle: "h23",
  year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
});

/** What a wall clock in Rome shows at `instant`. */
export function romeWallClock(instant: Date | string): WallClock & { second: number } {
  const parts = romeParts.formatToParts(new Date(instant));
  const get = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((p) => p.type === type)?.value ?? "0");
  return {
    year: get("year"), month: get("month"), day: get("day"),
    hour: get("hour"), minute: get("minute"), second: get("second"),
  };
}

/** Rome's UTC offset, in minutes, at the instant `utcMs` (CET = 60, CEST = 120). */
function romeOffsetMinutesAt(utcMs: number): number {
  const w = romeWallClock(new Date(utcMs));
  const asIfUtc = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second);
  return Math.round((asIfUtc - utcMs) / MS_PER_MINUTE);
}

/**
 * The instant at which a Rome wall clock shows `wall` — the same two-pass
 * offset read as lib/schedule.ts's wallClockToUtc: a time in the skipped
 * spring hour lands one hour later, a repeated autumn time resolves to the
 * later (standard-time) occurrence.
 */
export function romeToUtc(wall: WallClock): Date {
  const naive = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute);
  const firstGuess = naive - romeOffsetMinutesAt(naive) * MS_PER_MINUTE;
  const offset = romeOffsetMinutesAt(firstGuess);
  return new Date(naive - offset * MS_PER_MINUTE);
}

/** "HH:mm" as read in Rome at `instant` — the time shown on a day-list row. */
export function romeTime(instant: Date | string): string {
  const w = romeWallClock(instant);
  return `${pad2(w.hour)}:${pad2(w.minute)}`;
}

// ---------------------------------------------------------------------------
// Day and month keys
// ---------------------------------------------------------------------------

export function dayKey(year: number, month: number, day: number): DayKey {
  return `${year}-${pad2(month)}-${pad2(day)}`;
}

/** The Rome calendar day `instant` falls on — how posts are bucketed into cells. */
export function dayKeyOf(instant: Date | string): DayKey {
  const w = romeWallClock(instant);
  return dayKey(w.year, w.month, w.day);
}

export function parseDayKey(key: DayKey): { year: number; month: number; day: number } {
  const [year, month, day] = key.split("-").map(Number);
  return { year, month, day };
}

/** The day `delta` days from `key`, across months and years (calendar days, so no clock or DST involved). */
export function shiftDay(key: DayKey, delta: number): DayKey {
  const { year, month, day } = parseDayKey(key);
  const moved = addDays(year, month, day, delta);
  return dayKey(moved.year, moved.month, moved.day);
}

export function monthOf(key: DayKey): MonthKey {
  const { year, month } = parseDayKey(key);
  return { year, month };
}

export function sameMonth(a: MonthKey, b: MonthKey): boolean {
  return a.year === b.year && a.month === b.month;
}

/** Whether `instant` falls on a Rome day of `month` — the month itself, not the adjacent cells its grid also shows. */
export function inMonth(instant: Date | string, month: MonthKey): boolean {
  return sameMonth(monthOf(dayKeyOf(instant)), month);
}

/** Pure calendar arithmetic on a date (no zone involved): `days` days later. */
function addDays(year: number, month: number, day: number, days: number): { year: number; month: number; day: number } {
  const d = new Date(Date.UTC(year, month - 1, day + days));
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

// Labels are composed from parts, not `format()`, so locale punctuation can't
// creep in; the zone is UTC because a DayKey/MonthKey is a calendar date, not
// an instant — formatting Date.UTC(y, m, d) in UTC reads back exactly y/m/d.
const monthLabelParts = new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", month: "long", year: "numeric" });
const dayLabelParts = new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", weekday: "long", day: "numeric", month: "long" });

function part(parts: Intl.DateTimeFormatPart[], type: Intl.DateTimeFormatPartTypes): string {
  return parts.find((p) => p.type === type)?.value ?? "";
}

/** "September 2026". */
export function monthLabel({ year, month }: MonthKey): string {
  const parts = monthLabelParts.formatToParts(new Date(Date.UTC(year, month - 1, 1)));
  return `${part(parts, "month")} ${part(parts, "year")}`;
}

/** "Tuesday 22 September". */
export function dayLabel(key: DayKey): string {
  const { year, month, day } = parseDayKey(key);
  const parts = dayLabelParts.formatToParts(new Date(Date.UTC(year, month - 1, day)));
  return `${part(parts, "weekday")} ${part(parts, "day")} ${part(parts, "month")}`;
}

// An Archive card's slot is an instant, so this one reads the Rome zone (same locale as formatRomeSlot).
const slotLabelParts = new Intl.DateTimeFormat("en-GB", { timeZone: TIME_ZONE, weekday: "short", day: "numeric", month: "short" });

/** "Tue 22 Sept · 17:00" (Europe/Rome) — the original slot on an Archive card, whose list spans the month. */
export function slotLabel(instant: Date | string): string {
  const parts = slotLabelParts.formatToParts(new Date(instant));
  return `${part(parts, "weekday")} ${part(parts, "day")} ${part(parts, "month")} · ${romeTime(instant)}`;
}

// ---------------------------------------------------------------------------
// The month grid
// ---------------------------------------------------------------------------

export type DayCell = { key: DayKey; day: number; inMonth: boolean };

/**
 * The month as full Monday-first weeks: the leading cells belong to the
 * previous month and the trailing ones to the next (`inMonth: false`), so
 * every row has seven cells. Four rows for a 28-day February starting on a
 * Monday, six for a 30/31-day month starting on a Sunday.
 */
export function monthMatrix({ year, month }: MonthKey): DayCell[][] {
  const first = new Date(Date.UTC(year, month - 1, 1));
  const lead = (first.getUTCDay() + 6) % 7; // 0 = Monday … 6 = Sunday
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const total = Math.ceil((lead + daysInMonth) / 7) * 7;

  const weeks: DayCell[][] = [];
  for (let i = 0; i < total; i++) {
    const d = addDays(year, month, 1, i - lead);
    if (i % 7 === 0) weeks.push([]);
    weeks[weeks.length - 1].push({
      key: dayKey(d.year, d.month, d.day),
      day: d.day,
      inMonth: d.year === year && d.month === month,
    });
  }
  return weeks;
}

/**
 * The half-open UTC range covering every cell of `month`'s grid — Rome
 * midnight of the first cell up to (excluding) Rome midnight after the last —
 * i.e. GET /api/scheduled-posts's `from`/`to`. A superset of the month, so the
 * adjacent-month cells get their dots from the same single fetch; the month
 * summary filters by `inMonth` instead.
 */
export function gridRangeUtc(month: MonthKey): { from: Date; to: Date } {
  const weeks = monthMatrix(month);
  const first = parseDayKey(weeks[0][0].key);
  const last = parseDayKey(weeks[weeks.length - 1][6].key);
  const afterLast = addDays(last.year, last.month, last.day, 1);
  return {
    from: romeToUtc({ ...first, hour: 0, minute: 0 }),
    to: romeToUtc({ ...afterLast, hour: 0, minute: 0 }),
  };
}

/** Posts keyed by the Rome day they publish on, each bucket in the API's (time) order. */
export function groupByDay(posts: PlanPost[]): Map<DayKey, PlanPost[]> {
  const byDay = new Map<DayKey, PlanPost[]>();
  for (const post of posts) {
    const key = dayKeyOf(post.publishAt);
    const bucket = byDay.get(key);
    if (bucket) bucket.push(post); else byDay.set(key, [post]);
  }
  return byDay;
}

// ---------------------------------------------------------------------------
// Status → colour, dots, summary
// ---------------------------------------------------------------------------

/**
 * What Plan shows for a row, read once when the calendar loads (so render
 * stays pure): a post scheduled on the platform itself — posted_manually with
 * its time still ahead — is "scheduled"; everything else is its own status.
 */
export function displayStatus<T extends Pick<PlanPost, "status" | "publishAt">>(post: T, now: Date): T {
  return post.status === "posted_manually" && new Date(post.publishAt).getTime() > now.getTime()
    ? { ...post, status: "scheduled" as const }
    : post;
}

/** Out — published or posted, its time come (a post still ahead reads "scheduled", see displayStatus): Plan asks how it did. */
export function isOutStatus(status: PlanStatus): boolean {
  return status === "published" || status === "posted_manually";
}

/** The colours a day cell can show; canceled rows are hidden from the grid. */
export type DotStatus = "scheduled" | "queued" | "emailed" | "posted" | "failed";
export const MAX_DOTS = 3;

export function dotStatus(status: PlanStatus): DotStatus | null {
  switch (status) {
    case "scheduled": return "scheduled";
    case "queued": return "queued";
    case "emailed": return "emailed";
    case "published":
    case "posted_manually": return "posted";
    case "failed": return "failed";
    case "canceled": return null;
  }
}

/** Up to `max` dots in time order, plus how many more non-canceled posts the day holds ("+N"). */
export function dayDots(posts: PlanPost[], max = MAX_DOTS): { dots: DotStatus[]; overflow: number } {
  const visible: DotStatus[] = [];
  for (const post of posts) {
    const dot = dotStatus(post.status);
    if (dot) visible.push(dot);
  }
  return { dots: visible.slice(0, max), overflow: Math.max(0, visible.length - max) };
}

export type StatusSummary = { scheduled: number; queued: number; emailed: number; posted: number; failed: number };

/** Counts for the header strip: published and posted_manually both count as posted; canceled is left out. */
export function statusSummary(posts: PlanPost[]): StatusSummary {
  const summary: StatusSummary = { scheduled: 0, queued: 0, emailed: 0, posted: 0, failed: 0 };
  for (const post of posts) {
    const dot = dotStatus(post.status);
    if (dot) summary[dot] += 1;
  }
  return summary;
}

/** "2 scheduled · 1 emailed · 4 posted" — zero counts omitted; null when there is nothing to say (the empty state). */
export function summaryLabel(summary: StatusSummary): string | null {
  const parts = (["scheduled", "queued", "emailed", "posted", "failed"] as const)
    .filter((k) => summary[k] > 0)
    .map((k) => `${summary[k]} ${k}`);
  return parts.length > 0 ? parts.join(" · ") : null;
}

// ---------------------------------------------------------------------------
// The day list: free default slots + scheduled posts, in time order
// ---------------------------------------------------------------------------

/** A Settings default slot on the selected day that nothing is scheduled in yet. */
export type FreeSlot = {
  kind: "free";
  platform: PlanPlatform;
  /** The slot as a UTC ISO instant — what `/create?slot=` carries. */
  at: string;
  /** "HH:mm" in Rome, as Settings spells it. */
  time: string;
};
export type PostRow = { kind: "post"; post: PlanPost };
export type DayRow = FreeSlot | PostRow;

const SLOT_RE = /^(\d{2}):(\d{2})$/;

/** Parses a Settings slot ("HH:mm"); null for anything malformed or out of range — same rule as lib/schedule.ts's parseSlot. */
export function parseSlot(slot: string): { hour: number; minute: number } | null {
  const m = SLOT_RE.exec(slot);
  if (!m) return null;
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  if (hour > 23 || minute > 59) return null;
  return { hour, minute };
}

function minuteKey(instant: Date | string): number {
  return Math.floor(new Date(instant).getTime() / MS_PER_MINUTE);
}

/**
 * The default slots (Settings `defaultSlots`, per platform, Rome wall clock)
 * of `day` that are still free: strictly after `now` — a past slot can't be
 * scheduled — and not already holding a non-canceled post of that platform
 * at the same minute (the same "taken" rule as lib/schedule.ts's
 * suggestSlots). Malformed and duplicate slots are ignored. `posts` may be
 * the whole loaded range; only same-minute matches count.
 */
export function freeSlots(
  { day, defaultSlots, posts, now }:
  { day: DayKey; defaultSlots: Record<string, string[]>; posts: PlanPost[]; now: Date | string },
): FreeSlot[] {
  const nowMs = new Date(now).getTime();
  const date = parseDayKey(day);
  const taken = new Map<PlanPlatform, Set<number>>();
  for (const post of posts) {
    if (post.status === "canceled") continue;
    const set = taken.get(post.platform) ?? new Set<number>();
    set.add(minuteKey(post.publishAt));
    taken.set(post.platform, set);
  }

  const out: FreeSlot[] = [];
  for (const platform of PLATFORMS) {
    const seen = new Set<string>();
    for (const slot of defaultSlots[platform] ?? []) {
      const parsed = parseSlot(slot);
      if (!parsed || seen.has(slot)) continue;
      seen.add(slot);
      const at = romeToUtc({ ...date, ...parsed });
      if (at.getTime() <= nowMs) continue;
      if (taken.get(platform)?.has(minuteKey(at))) continue;
      out.push({ kind: "free", platform, at: at.toISOString(), time: `${pad2(parsed.hour)}:${pad2(parsed.minute)}` });
    }
  }
  return out;
}

function rowInstant(row: DayRow): number {
  return new Date(row.kind === "free" ? row.at : row.post.publishAt).getTime();
}

/**
 * What the day list renders for `day`, soonest first: its scheduled posts
 * — every status but canceled, which leave the days (owner feedback
 * 2026-09-23) and only free their slot here —
 * interleaved with the still-free default slots. At the same minute a post
 * comes before a free slot, X before LinkedIn.
 */
export function dayRows(
  { day, posts, defaultSlots, now }:
  { day: DayKey; posts: PlanPost[]; defaultSlots: Record<string, string[]>; now: Date | string },
): DayRow[] {
  const rows: DayRow[] = [
    ...posts.filter((post) => post.status !== "canceled").map((post): PostRow => ({ kind: "post", post })),
    ...freeSlots({ day, defaultSlots, posts, now }),
  ];
  return rows.sort((a, b) => {
    const byTime = rowInstant(a) - rowInstant(b);
    if (byTime !== 0) return byTime;
    if (a.kind !== b.kind) return a.kind === "post" ? -1 : 1;
    const pa = a.kind === "free" ? a.platform : a.post.platform;
    const pb = b.kind === "free" ? b.platform : b.post.platform;
    return PLATFORMS.indexOf(pa) - PLATFORMS.indexOf(pb);
  });
}

// ---------------------------------------------------------------------------
// Actions per status (both platforms are human-in-the-loop — M3 goal)
// ---------------------------------------------------------------------------

/**
 * cancel → DELETE /api/scheduled-posts/:id · resend, retry → POST
 * /api/scheduled-posts/:id/run (sends the due email now) · mark-posted →
 * POST /api/scheduled-posts/mark-posted { draftId, platform }.
 */
// "remove": a post scheduled on the platform itself leaves Plan (it stays on X or LinkedIn until deleted there).
export type PlanAction = "cancel" | "resend" | "retry" | "mark-posted" | "remove";

/** Which actions a card offers. Done rows (posted/published/canceled) offer none — "Open post" is a link, not an action. */
export function actionsFor(status: PlanStatus): PlanAction[] {
  switch (status) {
    case "scheduled": return ["remove"];
    case "queued": return ["cancel"];
    case "emailed": return ["resend", "mark-posted", "cancel"];
    case "failed": return ["retry", "cancel"];
    case "published":
    case "posted_manually":
    case "canceled": return [];
  }
}
