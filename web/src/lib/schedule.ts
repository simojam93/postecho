import { and, asc, eq, gt, gte, inArray, lt, lte, ne, sql } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { drafts, ideas, scheduledPosts } from "@/db/schema";
import type * as schema from "@/db/schema";
import { publishWebhookUrl } from "@/lib/publishers";
import { forgetMessage, getQstash, type Qstash } from "@/lib/qstash";
import { getSetting, SETTING_DEFAULTS } from "@/lib/settings";

/**
 * Same structural db type as lib/settings.ts's SettingsDb — satisfied by the
 * neon-http production db and the PGlite test db alike, so tests pass
 * createTestDb()'s instance straight in (no `as never`).
 */
export type ScheduleDb = PgDatabase<PgQueryResultHKT, typeof schema>;

export type ScheduledPost = typeof scheduledPosts.$inferSelect;
export type Platform = ScheduledPost["platform"];
export type ScheduleStatus = ScheduledPost["status"];

/** X's hard per-post limit, counted the way the editor's counter does (string length). */
export const X_LIMIT = 280;
/** Slot math and every human-facing time in the app; the DB stores UTC. */
export const TIME_ZONE = "Europe/Rome";
/** How far in the past a `publishAt` may sit and still count as "now" — browser/server clock skew. */
export const PAST_TOLERANCE_MS = 60_000;
const DEFAULT_SLOT_DAYS = 7;
const MS_PER_MINUTE = 60_000;
/** A timer is never asked to fire in the past: when slot − lead has already passed, it fires this soon instead. */
export const MIN_TIMER_DELAY_MS = 5_000;

// ---------------------------------------------------------------------------
// Europe/Rome wall-clock math — no dependency, proven by schedule.test.ts
// (CET vs CEST, both DST changes, midnight rollover).
// ---------------------------------------------------------------------------

/** A calendar date + time of day as read on a wall clock in some time zone. */
export type WallClock = { year: number; month: number; day: number; hour: number; minute: number };

const partsFormatters = new Map<string, Intl.DateTimeFormat>();

function partsFormatter(timeZone: string): Intl.DateTimeFormat {
  let f = partsFormatters.get(timeZone);
  if (!f) {
    // hourCycle h23 (not hour12: false) so midnight reads "00", never "24".
    f = new Intl.DateTimeFormat("en-US", {
      timeZone, hourCycle: "h23",
      year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
    });
    partsFormatters.set(timeZone, f);
  }
  return f;
}

/** What a wall clock in `timeZone` shows at the instant `date`. */
export function wallClockOf(date: Date, timeZone = TIME_ZONE): WallClock & { second: number } {
  const parts = partsFormatter(timeZone).formatToParts(date);
  const get = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((p) => p.type === type)?.value ?? "0");
  return {
    year: get("year"), month: get("month"), day: get("day"),
    hour: get("hour"), minute: get("minute"), second: get("second"),
  };
}

/** `timeZone`'s UTC offset, in minutes, at the instant `utcMs` (CET = 60, CEST = 120). */
function offsetMinutesAt(utcMs: number, timeZone: string): number {
  const w = wallClockOf(new Date(utcMs), timeZone);
  const asIfUtc = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second);
  return Math.round((asIfUtc - utcMs) / MS_PER_MINUTE);
}

/**
 * The instant at which a wall clock in `timeZone` shows `wall`. Two passes:
 * guess the offset as of the naive UTC reading, then re-read it at the
 * guessed instant — the two differ only across a DST change, where the
 * second reading is the right one. A time that doesn't exist (the skipped
 * hour in spring) lands one hour later; one that exists twice (autumn)
 * resolves to the later, standard-time occurrence. Neither can happen to a
 * default slot in practice (they change at 02:00–03:00), but both are pinned
 * by tests so the behavior is a known quantity rather than an accident.
 */
export function wallClockToUtc(wall: WallClock, timeZone = TIME_ZONE): Date {
  const naive = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute);
  const firstGuess = naive - offsetMinutesAt(naive, timeZone) * MS_PER_MINUTE;
  const offset = offsetMinutesAt(firstGuess, timeZone);
  return new Date(naive - offset * MS_PER_MINUTE);
}

/** The same calendar date `days` days later (time of day kept). Pure calendar arithmetic, zone-agnostic. */
export function addDays(wall: WallClock, days: number): WallClock {
  const d = new Date(Date.UTC(wall.year, wall.month - 1, wall.day + days));
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate(), hour: wall.hour, minute: wall.minute };
}

const SLOT_RE = /^(\d{2}):(\d{2})$/;

/** Parses a Settings slot ("HH:mm"); null for anything malformed or out of range. */
export function parseSlot(slot: string): { hour: number; minute: number } | null {
  const m = SLOT_RE.exec(slot);
  if (!m) return null;
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  if (hour > 23 || minute > 59) return null;
  return { hour, minute };
}

/**
 * Pure core of suggestSlots: every instant at which one of `slots` ("HH:mm",
 * wall clock in `timeZone`) falls on one of the `days` calendar days
 * starting with the day `from` is on IN THAT ZONE, strictly after `from`,
 * ascending. Starting from `from`'s zoned date (not its UTC date) is what
 * keeps late-evening calls right: at 22:30Z it's already tomorrow in Rome.
 * Malformed and duplicate slots are ignored.
 */
export function slotInstants(
  { slots, from, days = DEFAULT_SLOT_DAYS, timeZone = TIME_ZONE }:
  { slots: string[]; from: Date; days?: number; timeZone?: string },
): Date[] {
  const times = new Map<string, { hour: number; minute: number }>();
  for (const slot of slots) {
    const parsed = parseSlot(slot);
    if (parsed) times.set(slot, parsed);
  }
  if (times.size === 0 || days <= 0) return [];

  const start = wallClockOf(from, timeZone);
  const out: Date[] = [];
  for (let d = 0; d < days; d++) {
    const date = addDays(start, d);
    for (const { hour, minute } of times.values()) {
      const at = wallClockToUtc({ ...date, hour, minute }, timeZone);
      if (at.getTime() > from.getTime()) out.push(at);
    }
  }
  return out.sort((a, b) => a.getTime() - b.getTime());
}

function minuteKey(date: Date): number {
  return Math.floor(date.getTime() / MS_PER_MINUTE);
}

/**
 * The next free default slots for `platform` (Settings `defaultSlots`, read
 * as Europe/Rome wall-clock times), as UTC ISO strings: the coming `days`
 * Rome calendar days, minus slots already in the past and minus slots that
 * already hold a non-canceled schedule for that platform (matched to the
 * minute). Empty when the platform has no default slots.
 */
export async function suggestSlots(
  db: ScheduleDb,
  { platform, from = new Date(), days = DEFAULT_SLOT_DAYS }: { platform: Platform; from?: Date; days?: number },
): Promise<string[]> {
  const defaultSlots = await getSetting(db, "defaultSlots");
  const candidates = slotInstants({ slots: defaultSlots[platform] ?? [], from, days });
  if (candidates.length === 0) return [];

  const taken = await db
    .select({ publishAt: scheduledPosts.publishAt })
    .from(scheduledPosts)
    .where(and(
      eq(scheduledPosts.platform, platform),
      ne(scheduledPosts.status, "canceled"),
      gte(scheduledPosts.publishAt, candidates[0]),
      lte(scheduledPosts.publishAt, candidates[candidates.length - 1]),
    ));
  const takenMinutes = new Set(taken.map((row) => minuteKey(row.publishAt)));

  return candidates.filter((at) => !takenMinutes.has(minuteKey(at))).map((at) => at.toISOString());
}

// ---------------------------------------------------------------------------
// The queue
// ---------------------------------------------------------------------------

export type ScheduleErrorCode = "draft_not_found" | "no_text" | "too_long" | "in_past" | "conflict" | "not_editable" | "already_posted" | "not_out";

/**
 * Validation failures come back as values, not throws, so the routes can map
 * each one to its status without parsing messages. Same `ok` discriminant as
 * lib/materialize.ts's MaterializeOutcome, plus a stable `code` for the
 * client. Real failures (the db is down) still throw → 500.
 */
export type ScheduleResult =
  | { ok: true; post: ScheduledPost }
  | { ok: false; code: ScheduleErrorCode; error: string };

/** The HTTP status each validation code maps to — shared by the routes that create rows. */
export const SCHEDULE_ERROR_HTTP_STATUS: Record<ScheduleErrorCode, 400 | 404 | 409> = {
  draft_not_found: 404,
  conflict: 409,
  no_text: 400,
  too_long: 400,
  in_past: 400,
  not_editable: 409,
  already_posted: 409,
  not_out: 409,
};

const PLATFORM_LABEL: Record<Platform, string> = { x: "X", linkedin: "LinkedIn" };

type DraftRow = typeof drafts.$inferSelect;

async function loadDraft(db: ScheduleDb, draftId: string): Promise<DraftRow | null> {
  const [draft] = await db.select().from(drafts).where(eq(drafts.id, draftId)).limit(1);
  return draft ?? null;
}

/** The draft's text for `platform`, or a typed error when it has none (or, for X, too much). */
function platformText(draft: DraftRow, platform: Platform): { ok: true; text: string } | Extract<ScheduleResult, { ok: false }> {
  const text = (platform === "x" ? draft.xText : draft.linkedinText) ?? "";
  if (text.trim().length === 0) {
    return { ok: false, code: "no_text", error: `this draft has no ${PLATFORM_LABEL[platform]} text` };
  }
  if (platform === "x" && text.length > X_LIMIT) {
    return { ok: false, code: "too_long", error: `X text is ${text.length} characters — the limit is ${X_LIMIT}` };
  }
  return { ok: true, text };
}

// ---------------------------------------------------------------------------
// Never the same post twice (owner, 2026-09-24: "never allow double posted if
// it's the same post" — Mark as posted from the email, then from the app, had
// made two posted rows). The database allows one posted row per (draft,
// platform) (db/schema.ts); these helpers make every path return the post
// that's already out instead of recording it again.
// ---------------------------------------------------------------------------

/**
 * Scheduled on the platform itself (owner, 2026-09-24: Schedule opens X's —
 * or LinkedIn's — own composer with the text, the owner schedules it there
 * and tells PostEcho when): recorded as `posted_manually` with its publishAt
 * still ahead. X or LinkedIn publishes it; PostEcho sends nothing. Until
 * then Plan shows it as scheduled and can still edit or remove the record;
 * from its time on it's simply posted. Being posted_manually, it's "out" for
 * every never-twice rule below.
 */
export function isScheduledOnPlatform(row: Pick<ScheduledPost, "status" | "publishAt">, now: Date = new Date()): boolean {
  return row.status === "posted_manually" && row.publishAt.getTime() > now.getTime();
}

/** The note on a schedule set aside because its post was already marked as posted. Plan doesn't list those (listSchedules). */
export const ALREADY_POSTED_NOTE = "already posted: the same post was marked as posted";
const POSTED_STATUSES: ScheduleStatus[] = ["posted_manually", "published"];
const PENDING_STATUSES: ScheduleStatus[] = ["queued", "emailed", "failed"];
/** How far back the same text on the same platform, from another draft, counts as the same post (a copy of the draft). */
export const SAME_TEXT_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

function sameText(a: string, b: string): boolean {
  const norm = (t: string) => t.replace(/\s+/g, " ").trim();
  return norm(a) === norm(b);
}

/**
 * The post already out for `draftId` on `platform`, if any: a posted row of
 * the same draft and platform, else one on the same platform with the same
 * text, posted in the last SAME_TEXT_WINDOW_MS. `exceptId` leaves a row out
 * (the one being marked). The earliest one wins.
 */
export async function postedAlready(
  db: ScheduleDb,
  { draftId, platform, text, exceptId, now = new Date() }:
  { draftId: string; platform: Platform; text: string; exceptId?: string; now?: Date },
): Promise<ScheduledPost | null> {
  const rows = await db
    .select()
    .from(scheduledPosts)
    .where(and(
      eq(scheduledPosts.platform, platform),
      inArray(scheduledPosts.status, POSTED_STATUSES),
      ...(exceptId ? [ne(scheduledPosts.id, exceptId)] : []),
    ))
    .orderBy(asc(scheduledPosts.publishedAt), asc(scheduledPosts.createdAt), asc(scheduledPosts.id));
  const since = now.getTime() - SAME_TEXT_WINDOW_MS;
  return rows.find((row) => row.draftId === draftId)
    ?? rows.find((row) => sameText(row.text, text) && (row.publishedAt ?? row.publishAt).getTime() >= since)
    ?? null;
}

/**
 * Every still-pending schedule (queued, emailed, failed) of `draftId` on
 * `platform` — it would email, or be marked, a post that's already out — is
 * set aside: canceled with ALREADY_POSTED_NOTE, its timer forgotten.
 */
export async function setAsidePending(
  db: ScheduleDb,
  qstash: Qstash,
  { draftId, platform, exceptId }: { draftId: string; platform: Platform; exceptId?: string },
): Promise<void> {
  const aside = await db
    .update(scheduledPosts)
    .set({ status: "canceled", error: ALREADY_POSTED_NOTE })
    .where(and(
      eq(scheduledPosts.draftId, draftId),
      eq(scheduledPosts.platform, platform),
      inArray(scheduledPosts.status, PENDING_STATUSES),
      ...(exceptId ? [ne(scheduledPosts.id, exceptId)] : []),
    ))
    .returning();
  for (const row of aside) await forgetMessage(qstash, row.externalId);
}

/**
 * Marks the draft `used` (it leaves Write's takes row — Plan owns it from
 * here). neon-http has no transactions (see db/index.ts), so if this second
 * write fails the row created just before it is best-effort canceled — the
 * same clean-up-what-you-created shape as api/videos/route.ts — and the
 * error propagates: better an honest 500 with nothing queued than a post
 * that publishes while the owner saw an error and still sees the take.
 */
async function markDraftUsedOrUndo(db: ScheduleDb, draftId: string, post: ScheduledPost): Promise<void> {
  try {
    await db.update(drafts).set({ status: "used" }).where(eq(drafts.id, draftId));
  } catch (e) {
    await db
      .update(scheduledPosts)
      .set({ status: "canceled", error: "the draft could not be marked used — schedule undone" })
      .where(eq(scheduledPosts.id, post.id))
      .catch(() => {});
    throw e;
  }
}

/**
 * When the timer for a slot fires: `leadMinutes` before `publishAt` — the
 * email needs to land with time to spare — but never before `now` +
 * MIN_TIMER_DELAY_MS: a slot scheduled inside its own lead time (or, with
 * PAST_TOLERANCE_MS, just past) fires right away rather than asking QStash
 * for an instant already gone.
 */
export function timerFireAt(publishAt: Date, leadMinutes: number, now: Date = new Date()): Date {
  const lead = publishAt.getTime() - leadMinutes * MS_PER_MINUTE;
  return new Date(Math.max(lead, now.getTime() + MIN_TIMER_DELAY_MS));
}

/** Settings leadTimeMinutes, defended against a bad kv value (negative, NaN, not a number) — the default then. */
async function leadTimeMinutes(db: ScheduleDb): Promise<number> {
  const value = await getSetting(db, "leadTimeMinutes");
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : SETTING_DEFAULTS.leadTimeMinutes;
}

/**
 * Reverses a schedule whose timer could not be set right after it was
 * created: the row is canceled with `reason` as its error and the draft
 * gets back the status it had (it was just marked used). Best effort, like
 * markDraftUsedOrUndo — the caller rethrows the original error either way.
 */
async function undoSchedule(db: ScheduleDb, post: ScheduledPost, previousDraftStatus: DraftRow["status"], reason: string): Promise<void> {
  await db.update(scheduledPosts).set({ status: "canceled", error: reason }).where(eq(scheduledPosts.id, post.id)).catch(() => {});
  await db.update(drafts).set({ status: previousDraftStatus }).where(eq(drafts.id, post.draftId)).catch(() => {});
}

/**
 * Queues `draft` for `platform` at `publishAt` (Write's Schedule → Confirm,
 * one call per platform). The draft must exist and have text for the
 * platform (≤ 280 characters for X); `publishAt` may be at most
 * PAST_TOLERANCE_MS ago. The platform text is frozen onto the row, the draft
 * becomes `used`. `conflict` when the draft already has a QUEUED schedule for
 * that platform — enforced by the partial unique index in the insert itself,
 * so two concurrent calls can't both succeed (a canceled/emailed/published
 * one doesn't block).
 *
 * Then the timer (P2): with QStash on (`qstash.enabled` — lib/qstash.ts's
 * getQstash by default, injectable for tests) one message is published to
 * POST /api/publish/[id] for `timerFireAt(publishAt, Settings
 * leadTimeMinutes)` and its id is stored on the row as `externalId`. If
 * that fails the schedule is undone (row canceled, draft status restored)
 * and the error propagates — an honest 500 rather than a queued post whose
 * email would never come. With QStash off the row stays queued with
 * `externalId` null and waits for POST /api/scheduled-posts/[id]/run
 * (Settings/Plan can say so). `now` is injectable for tests only.
 */
export async function createSchedule(
  db: ScheduleDb,
  { draftId, platform, publishAt, now = new Date(), qstash = getQstash() }:
  { draftId: string; platform: Platform; publishAt: Date; now?: Date; qstash?: Qstash },
): Promise<ScheduleResult> {
  if (Number.isNaN(publishAt.getTime()) || publishAt.getTime() < now.getTime() - PAST_TOLERANCE_MS) {
    return { ok: false, code: "in_past", error: "publishAt must be in the future" };
  }

  const draft = await loadDraft(db, draftId);
  if (!draft) return { ok: false, code: "draft_not_found", error: "draft not found" };

  const text = platformText(draft, platform);
  if (!text.ok) return text;
  if (await postedAlready(db, { draftId, platform, text: text.text, now })) {
    return { ok: false, code: "already_posted", error: `this post is already posted on ${PLATFORM_LABEL[platform]}` };
  }

  const [post] = await db
    .insert(scheduledPosts)
    .values({ draftId, platform, text: text.text, publishAt })
    // Postgres only uses a partial unique index as the ON CONFLICT arbiter
    // when the clause repeats its predicate (see api/videos/route.ts for the
    // same trick on ideas_url_unique).
    .onConflictDoNothing({ target: [scheduledPosts.draftId, scheduledPosts.platform], where: sql`status = 'queued'` })
    .returning();
  if (!post) {
    return { ok: false, code: "conflict", error: `this draft is already queued for ${PLATFORM_LABEL[platform]}` };
  }

  await markDraftUsedOrUndo(db, draftId, post);
  if (!qstash.enabled) return { ok: true, post };

  let messageId: string;
  try {
    messageId = await qstash.scheduleMessage({
      url: publishWebhookUrl(post.id),
      notBeforeMs: timerFireAt(publishAt, await leadTimeMinutes(db), now).getTime(),
      body: { id: post.id },
    });
  } catch (e) {
    await undoSchedule(db, post, draft.status, "the timer could not be set — schedule undone");
    throw e;
  }
  try {
    const [timed] = await db.update(scheduledPosts).set({ externalId: messageId }).where(eq(scheduledPosts.id, post.id)).returning();
    return { ok: true, post: timed ?? { ...post, externalId: messageId } };
  } catch (e) {
    await forgetMessage(qstash, messageId);
    await undoSchedule(db, post, draft.status, "the timer id could not be stored — schedule undone");
    throw e;
  }
}

// queued: the timer hasn't fired. emailed: the "Post on X" email went out but
// nothing was posted — spec §6.3 says such a post nags until marked or
// canceled, so canceling it must work. failed: clearing a failure off the
// calendar. published/posted_manually are done and stay as they are.
const CANCELABLE_STATUSES: ScheduleStatus[] = ["queued", "emailed", "failed"];

/**
 * Cancels a schedule (DELETE /api/scheduled-posts/:id). Idempotent: an
 * already-canceled row — or a published/posted one, which can't be undone
 * here — comes back unchanged; only an unknown id yields null. A row that
 * had a timer (`externalId`) gets its QStash message canceled too (P2 —
 * best effort, see lib/qstash.ts's forgetMessage), so the due-post email
 * for a canceled post never goes out.
 */
export async function cancelSchedule(
  db: ScheduleDb,
  id: string,
  { qstash = getQstash() }: { qstash?: Qstash } = {},
): Promise<ScheduledPost | null> {
  const [canceled] = await db
    .update(scheduledPosts)
    .set({ status: "canceled" })
    .where(and(eq(scheduledPosts.id, id), inArray(scheduledPosts.status, CANCELABLE_STATUSES)))
    .returning();
  if (canceled) {
    await forgetMessage(qstash, canceled.externalId);
    return canceled;
  }
  // Scheduled on the platform itself and not out yet: its record can leave
  // Plan (the owner deletes it on X or LinkedIn too — Plan says so).
  const [removed] = await db
    .update(scheduledPosts)
    .set({ status: "canceled" })
    .where(and(eq(scheduledPosts.id, id), eq(scheduledPosts.status, "posted_manually"), gt(scheduledPosts.publishAt, new Date())))
    .returning();
  if (removed) return removed;
  const [existing] = await db.select().from(scheduledPosts).where(eq(scheduledPosts.id, id)).limit(1);
  return existing ?? null;
}

// The rows Plan's Edit can change (owner, 2026-09-24: "in the plan part I
// need to have the opportunity to edit the scheduled posts, for example
// changing the timing"): a queued one, and an emailed or failed one, which
// saving queues again — the due email then goes out at the new time.
const EDITABLE_STATUSES: ScheduleStatus[] = ["queued", "emailed", "failed"];

/** Postgres' unique_violation, however the driver or drizzle wraps it. */
export function isUniqueViolation(e: unknown): boolean {
  const code = (x: unknown) => (typeof x === "object" && x !== null ? (x as { code?: unknown }).code : undefined);
  return code(e) === "23505" || code((e as { cause?: unknown } | null)?.cause) === "23505";
}

/**
 * Plan's Edit (PATCH /api/scheduled-posts/:id): a new time and/or text for
 * a scheduled post. Only queued, emailed and failed rows (EDITABLE_STATUSES);
 * the time must be in the future (PAST_TOLERANCE_MS), the text non-empty and,
 * for X, within 280 characters. Saving leaves the row `queued` — an emailed
 * or failed one is queued again, its error and emailedAt cleared.
 *
 * The timer moves with the time: with QStash on, a NEW message is published
 * for the new slot first — so a failure changes nothing — then the row is
 * updated with it, then the old message is forgotten (best effort; the
 * webhook also skips a delivery whose message id isn't the row's current
 * one, lib/publishers/run.ts). A row edited while its timer fired, or
 * canceled meanwhile, is `not_editable` and the new message is dropped.
 * Null for an unknown id.
 */
export async function updateSchedule(
  db: ScheduleDb,
  id: string,
  { publishAt, text, now = new Date(), qstash = getQstash() }:
  { publishAt?: Date; text?: string; now?: Date; qstash?: Qstash },
): Promise<ScheduleResult | null> {
  const [row] = await db.select().from(scheduledPosts).where(eq(scheduledPosts.id, id)).limit(1);
  if (!row) return null;
  if (isScheduledOnPlatform(row, now)) return updatePlatformSchedule(db, row, { publishAt, text, now });
  if (!EDITABLE_STATUSES.includes(row.status)) {
    return { ok: false, code: "not_editable", error: row.status === "canceled" ? "this post was canceled" : "this post is already posted" };
  }

  const at = publishAt ?? row.publishAt;
  if (Number.isNaN(at.getTime()) || at.getTime() < now.getTime() - PAST_TOLERANCE_MS) {
    return { ok: false, code: "in_past", error: "pick a time in the future" };
  }
  const nextText = text ?? row.text;
  if (nextText.trim().length === 0) return { ok: false, code: "no_text", error: `the ${PLATFORM_LABEL[row.platform]} text is empty` };
  if (row.platform === "x" && nextText.length > X_LIMIT) {
    return { ok: false, code: "too_long", error: `X text is ${nextText.length} characters — the limit is ${X_LIMIT}` };
  }

  // A queued row keeps its timer when only the text changes; a new time, or
  // a row that isn't queued any more, needs a new one.
  const retime = row.status !== "queued" || at.getTime() !== row.publishAt.getTime();
  let messageId = row.externalId;
  if (retime) {
    messageId = qstash.enabled
      ? await qstash.scheduleMessage({
        url: publishWebhookUrl(row.id),
        notBeforeMs: timerFireAt(at, await leadTimeMinutes(db), now).getTime(),
        body: { id: row.id },
      })
      : null;
  }
  const dropNewTimer = async () => {
    if (retime && messageId && messageId !== row.externalId) await forgetMessage(qstash, messageId);
  };

  let updated: ScheduledPost | undefined;
  try {
    [updated] = await db
      .update(scheduledPosts)
      .set({
        publishAt: at,
        text: nextText,
        externalId: messageId,
        ...(row.status !== "queued" ? { status: "queued" as const, error: null, emailedAt: null } : {}),
      })
      .where(and(eq(scheduledPosts.id, id), eq(scheduledPosts.status, row.status)))
      .returning();
  } catch (e) {
    await dropNewTimer();
    if (isUniqueViolation(e)) {
      return { ok: false, code: "conflict", error: `this post is already queued for ${PLATFORM_LABEL[row.platform]} at another time` };
    }
    throw e;
  }
  if (!updated) {
    await dropNewTimer();
    return { ok: false, code: "not_editable", error: "this post changed meanwhile — reload Schedule" };
  }
  if (retime && row.externalId && row.externalId !== messageId) await forgetMessage(qstash, row.externalId);
  return { ok: true, post: updated };
}

/**
 * Plan's Edit on a post scheduled on the platform itself: only PostEcho's
 * record changes — its time (still ahead) and text; nothing is timed or sent.
 * The owner changes it on X or LinkedIn too (the dialog says so).
 */
async function updatePlatformSchedule(
  db: ScheduleDb,
  row: ScheduledPost,
  { publishAt, text, now }: { publishAt?: Date; text?: string; now: Date },
): Promise<ScheduleResult> {
  const at = publishAt ?? row.publishAt;
  if (Number.isNaN(at.getTime()) || at.getTime() <= now.getTime()) {
    return { ok: false, code: "in_past", error: "pick a time in the future" };
  }
  const nextText = text ?? row.text;
  if (nextText.trim().length === 0) return { ok: false, code: "no_text", error: `the ${PLATFORM_LABEL[row.platform]} text is empty` };
  if (row.platform === "x" && nextText.length > X_LIMIT) {
    return { ok: false, code: "too_long", error: `X text is ${nextText.length} characters — the limit is ${X_LIMIT}` };
  }
  const [updated] = await db
    .update(scheduledPosts)
    .set({ publishAt: at, publishedAt: at, text: nextText })
    .where(and(eq(scheduledPosts.id, row.id), eq(scheduledPosts.status, "posted_manually")))
    .returning();
  if (!updated) return { ok: false, code: "not_editable", error: "this post changed meanwhile — reload Schedule" };
  return { ok: true, post: updated };
}

export type ScheduleListFilters = {
  /** Inclusive lower bound on publishAt. */
  from?: Date;
  /** EXCLUSIVE upper bound on publishAt — half-open ranges tile a calendar without double-counting a midnight. */
  to?: Date;
  status?: ScheduleStatus;
};

/** A queue row plus what the Plan tab renders next to it: the draft's current texts and its idea's title. */
export type ScheduleListItem = ScheduledPost & {
  xText: string | null;
  linkedinText: string | null;
  ideaTitle: string | null;
  /**
   * The source the post was written from (owner, 2026-09-25: "always with them
   * the link of the source… for adding it in the first comment"): the article
   * a discussion card links to when it has one (meta.articleUrl), else the
   * idea's own link. Null for a note or a text without one.
   */
  sourceUrl: string | null;
};

/** The link a first comment would share: a discussion's article when known, else the idea's url. */
export function sourceUrlOf(idea: { url: string | null; meta: Record<string, unknown> | null } | null): string | null {
  if (!idea) return null;
  const article = idea.meta?.articleUrl;
  if (typeof article === "string" && /^https?:\/\//.test(article)) return article;
  return idea.url && /^https?:\/\//.test(idea.url) ? idea.url : null;
}

/**
 * The queue, soonest first (GET /api/scheduled-posts): each row joined with
 * its draft's current X/LinkedIn text and the source idea's title (null for a
 * draft with no idea). The row's own `text` is the frozen copy that gets
 * published; the joined texts are what the owner sees in Write today.
 */
export async function listSchedules(db: ScheduleDb, filters: ScheduleListFilters = {}): Promise<ScheduleListItem[]> {
  const conditions = [];
  if (filters.from) conditions.push(gte(scheduledPosts.publishAt, filters.from));
  if (filters.to) conditions.push(lt(scheduledPosts.publishAt, filters.to));
  if (filters.status) conditions.push(eq(scheduledPosts.status, filters.status));
  // A schedule set aside because its post was already out isn't the owner's cancel: Plan doesn't show it.
  conditions.push(sql`not (${scheduledPosts.status} = 'canceled' and ${scheduledPosts.error} is not distinct from ${ALREADY_POSTED_NOTE})`);

  const rows = await db
    .select({
      post: scheduledPosts, xText: drafts.xText, linkedinText: drafts.linkedinText,
      ideaTitle: ideas.title, ideaUrl: ideas.url, ideaMeta: ideas.meta,
    })
    .from(scheduledPosts)
    .innerJoin(drafts, eq(drafts.id, scheduledPosts.draftId))
    .leftJoin(ideas, eq(ideas.id, drafts.ideaId))
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(asc(scheduledPosts.publishAt), asc(scheduledPosts.id));

  return rows.map((r) => ({
    ...r.post, xText: r.xText, linkedinText: r.linkedinText, ideaTitle: r.ideaTitle,
    sourceUrl: sourceUrlOf(r.ideaUrl === null && r.ideaMeta === null ? null : { url: r.ideaUrl, meta: r.ideaMeta }),
  }));
}

/**
 * Records that the owner posted the draft by hand (Write's Post now → X
 * intent → Mark as posted): a `posted_manually` row with `postedBy: manual`,
 * `publishAt` = when (default now) and `publishedAt` = now; the draft becomes
 * `used`. If that (draft, platform) already has a queued or emailed schedule,
 * the soonest such row is converted instead of adding a second one — the
 * owner posted before the slot, and leaving the row queued would email a
 * duplicate — and that row's QStash message, if it had one (`externalId`),
 * is canceled here (P2) so the due-post email for a post already posted
 * never goes out. Same typed errors as createSchedule for a missing draft /
 * missing or over-long text.
 */
export async function markPostedManually(
  db: ScheduleDb,
  { draftId, platform = "x", publishAt = new Date(), qstash = getQstash() }:
  { draftId: string; platform?: Platform; publishAt?: Date; qstash?: Qstash },
): Promise<ScheduleResult> {
  const draft = await loadDraft(db, draftId);
  if (!draft) return { ok: false, code: "draft_not_found", error: "draft not found" };

  const text = platformText(draft, platform);
  if (!text.ok) return text;

  const now = new Date();
  // A time ahead: scheduled on the platform itself, which publishes it then.
  const publishedAt = publishAt.getTime() > now.getTime() ? publishAt : now;
  const posted = { status: "posted_manually" as const, postedBy: "manual" as const, publishAt, publishedAt, error: null };

  // Already out (the email's Mark as posted came first, or a copy of the
  // draft was posted): that post is the answer, and what's still pending for
  // this draft is set aside rather than emailed or marked a second time.
  const alreadyOut = async (): Promise<ScheduleResult | null> => {
    const existing = await postedAlready(db, { draftId, platform, text: text.text, now });
    if (!existing) return null;
    await setAsidePending(db, qstash, { draftId, platform });
    await db.update(drafts).set({ status: "used" }).where(eq(drafts.id, draftId));
    return { ok: true, post: existing };
  };
  const before = await alreadyOut();
  if (before) return before;

  const [pending] = await db
    .select({ id: scheduledPosts.id })
    .from(scheduledPosts)
    .where(and(
      eq(scheduledPosts.draftId, draftId),
      eq(scheduledPosts.platform, platform),
      inArray(scheduledPosts.status, ["queued", "emailed"]),
    ))
    .orderBy(asc(scheduledPosts.publishAt), asc(scheduledPosts.id))
    .limit(1);

  let post: ScheduledPost | undefined;
  try {
    if (pending) {
      [post] = await db.update(scheduledPosts).set(posted).where(eq(scheduledPosts.id, pending.id)).returning();
      if (post) await forgetMessage(qstash, post.externalId);
    }
    if (!post) {
      [post] = await db.insert(scheduledPosts).values({ draftId, platform, text: text.text, ...posted }).returning();
    }
  } catch (e) {
    // Two marks at the same instant: the one-posted index let one through.
    if (isUniqueViolation(e)) {
      const raced = await alreadyOut();
      if (raced) return raced;
    }
    throw e;
  }

  await setAsidePending(db, qstash, { draftId, platform, exceptId: post.id });
  await markDraftUsedOrUndo(db, draftId, post);
  return { ok: true, post };
}

// ---------------------------------------------------------------------------
// How did it do? (owner, 2026-09-26)
// ---------------------------------------------------------------------------

export type Outcome = NonNullable<ScheduledPost["outcome"]>;
/** A post is worth rating once its results are in: a day after it went out… */
export const RATE_AFTER_MS = 24 * 60 * 60 * 1000;
/** …and no longer after two months. */
export const RATE_WINDOW_MS = 60 * 24 * 60 * 60 * 1000;
const TO_RATE_LIMIT = 50;

/** Out: posted or published, and its time has come — the posts Plan asks "How did it do?" about. */
export function isOut(row: Pick<ScheduledPost, "status" | "publishAt">, now: Date = new Date()): boolean {
  return (row.status === "posted_manually" || row.status === "published") && row.publishAt.getTime() <= now.getTime();
}

/**
 * Plan's "How did it do?" (owner, 2026-09-26: "il tocco in plan serve sia se il post è andato
 * bene che se è andato male"): 👍 good or 👎 bad on a post that is out, null to take the vote
 * back. lib/taste.ts learns from the votes. A post not out yet is `not_out`; null for an
 * unknown id.
 */
export async function rateSchedule(
  db: ScheduleDb,
  id: string,
  outcome: Outcome | null,
  now: Date = new Date(),
): Promise<ScheduleResult | null> {
  const [row] = await db.select().from(scheduledPosts).where(eq(scheduledPosts.id, id)).limit(1);
  if (!row) return null;
  if (!isOut(row, now)) return { ok: false, code: "not_out", error: "this post isn't out yet" };
  const [updated] = await db
    .update(scheduledPosts)
    .set({ outcome, ratedAt: outcome === null ? null : now })
    .where(eq(scheduledPosts.id, id))
    .returning();
  return { ok: true, post: updated };
}

/**
 * Plan's To rate (2026-09-26): the posts out for more than a day and at most 60 days, with no
 * vote yet, newest first — the ones worth a 👍 or 👎 now that their results are in.
 */
export async function listToRate(db: ScheduleDb, now: Date = new Date()): Promise<ScheduleListItem[]> {
  const rows = await listSchedules(db, {
    from: new Date(now.getTime() - RATE_WINDOW_MS),
    to: new Date(now.getTime() - RATE_AFTER_MS),
  });
  return rows.filter((row) => isOut(row, now) && row.outcome === null).reverse().slice(0, TO_RATE_LIMIT);
}
