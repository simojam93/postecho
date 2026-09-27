import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb } from "@/test/db";
import { drafts, ideas, scheduledPosts } from "@/db/schema";
import { setSetting } from "@/lib/settings";
import {
  addDays, cancelSchedule, createSchedule, listSchedules, markPostedManually, MIN_TIMER_DELAY_MS, parseSlot,
  slotInstants, suggestSlots, timerFireAt, updateSchedule, wallClockOf, wallClockToUtc, X_LIMIT,
  ALREADY_POSTED_NOTE, SAME_TEXT_WINDOW_MS, isScheduledOnPlatform, sourceUrlOf, isOut, listToRate, rateSchedule,
} from "@/lib/schedule";
import { markPostedById } from "@/lib/publishers/run";

const iso = (dates: Date[]) => dates.map((d) => d.toISOString());
const UNKNOWN_ID = "00000000-0000-0000-0000-000000000000";

describe("Europe/Rome wall-clock math", () => {
  it("converts CET and CEST wall clocks to UTC", () => {
    expect(wallClockToUtc({ year: 2026, month: 1, day: 15, hour: 12, minute: 0 }).toISOString()).toBe("2026-01-15T11:00:00.000Z");
    expect(wallClockToUtc({ year: 2026, month: 7, day: 15, hour: 12, minute: 0 }).toISOString()).toBe("2026-07-15T10:00:00.000Z");
  });

  it("reads the wall clock across midnight: 22:30Z is already tomorrow in Rome", () => {
    expect(wallClockOf(new Date("2026-09-22T22:30:00Z"))).toMatchObject({ year: 2026, month: 9, day: 23, hour: 0, minute: 30 });
    expect(wallClockOf(new Date("2026-01-15T23:30:00Z"))).toMatchObject({ year: 2026, month: 1, day: 16, hour: 0, minute: 30 });
  });

  it("handles the spring-forward change (2026-03-29: 02:00 CET → 03:00 CEST)", () => {
    // The day before is CET (+1), the day after CEST (+2): same wall clock, UTC an hour apart.
    expect(wallClockToUtc({ year: 2026, month: 3, day: 28, hour: 17, minute: 0 }).toISOString()).toBe("2026-03-28T16:00:00.000Z");
    expect(wallClockToUtc({ year: 2026, month: 3, day: 29, hour: 17, minute: 0 }).toISOString()).toBe("2026-03-29T15:00:00.000Z");
    // 02:30 doesn't exist that night — it lands an hour later, at 03:30 CEST.
    expect(wallClockToUtc({ year: 2026, month: 3, day: 29, hour: 2, minute: 30 }).toISOString()).toBe("2026-03-29T01:30:00.000Z");
  });

  it("handles the fall-back change (2026-10-25: 03:00 CEST → 02:00 CET)", () => {
    expect(wallClockToUtc({ year: 2026, month: 10, day: 24, hour: 17, minute: 0 }).toISOString()).toBe("2026-10-24T15:00:00.000Z");
    expect(wallClockToUtc({ year: 2026, month: 10, day: 25, hour: 17, minute: 0 }).toISOString()).toBe("2026-10-25T16:00:00.000Z");
    // 02:30 happens twice that night — resolved to the later, CET occurrence.
    expect(wallClockToUtc({ year: 2026, month: 10, day: 25, hour: 2, minute: 30 }).toISOString()).toBe("2026-10-25T01:30:00.000Z");
  });

  it("addDays crosses month and year ends", () => {
    expect(addDays({ year: 2026, month: 12, day: 31, hour: 10, minute: 0 }, 1)).toEqual({ year: 2027, month: 1, day: 1, hour: 10, minute: 0 });
    expect(addDays({ year: 2026, month: 2, day: 28, hour: 0, minute: 0 }, 1)).toEqual({ year: 2026, month: 3, day: 1, hour: 0, minute: 0 });
  });

  it("parseSlot accepts HH:mm and rejects the rest", () => {
    expect(parseSlot("17:00")).toEqual({ hour: 17, minute: 0 });
    expect(parseSlot("00:30")).toEqual({ hour: 0, minute: 30 });
    expect(parseSlot("24:00")).toBeNull();
    expect(parseSlot("10:60")).toBeNull();
    expect(parseSlot("9:00")).toBeNull();
    expect(parseSlot("bogus")).toBeNull();
  });
});

describe("slotInstants", () => {
  it("lists the coming days' slots strictly after `from`, soonest first", () => {
    const from = new Date("2026-09-22T12:00:00Z"); // Tue 14:00 CEST
    expect(iso(slotInstants({ slots: ["17:00", "10:00"], from, days: 2 }))).toEqual([
      "2026-09-22T15:00:00.000Z", "2026-09-23T08:00:00.000Z", "2026-09-23T15:00:00.000Z",
    ]);
  });

  it("excludes a slot exactly at `from`", () => {
    const from = new Date("2026-09-22T15:00:00Z"); // 17:00 CEST on the dot
    expect(iso(slotInstants({ slots: ["17:00"], from, days: 1 }))).toEqual([]);
  });

  it("starts from Rome's calendar date, not UTC's, late in the evening", () => {
    const from = new Date("2026-09-22T22:30:00Z"); // already Wed 00:30 CEST
    expect(iso(slotInstants({ slots: ["10:00", "17:00"], from, days: 1 }))).toEqual([
      "2026-09-23T08:00:00.000Z", "2026-09-23T15:00:00.000Z",
    ]);
  });

  it("keeps wall-clock times across the autumn DST change (UTC shifts by an hour)", () => {
    const from = new Date("2026-10-24T06:00:00Z"); // Sat 08:00 CEST; the clocks go back Sunday night
    expect(iso(slotInstants({ slots: ["10:00", "17:00"], from, days: 2 }))).toEqual([
      "2026-10-24T08:00:00.000Z", "2026-10-24T15:00:00.000Z",
      "2026-10-25T09:00:00.000Z", "2026-10-25T16:00:00.000Z",
    ]);
  });

  it("keeps wall-clock times across the spring DST change", () => {
    const from = new Date("2026-03-28T06:00:00Z"); // Sat 07:00 CET; the clocks go forward Sunday night
    expect(iso(slotInstants({ slots: ["10:00", "17:00"], from, days: 2 }))).toEqual([
      "2026-03-28T09:00:00.000Z", "2026-03-28T16:00:00.000Z",
      "2026-03-29T08:00:00.000Z", "2026-03-29T15:00:00.000Z",
    ]);
  });

  it("ignores malformed and duplicate slots, and returns nothing for none", () => {
    const from = new Date("2026-09-22T12:00:00Z");
    // 00:30 Rome today was 22:30Z yesterday — past; 23:00 Rome is 21:00Z — future.
    expect(iso(slotInstants({ slots: ["23:00", "bogus", "23:00", "00:30"], from, days: 1 }))).toEqual(["2026-09-22T21:00:00.000Z"]);
    expect(slotInstants({ slots: [], from, days: 7 })).toEqual([]);
    expect(slotInstants({ slots: ["10:00"], from, days: 0 })).toEqual([]);
  });
});

describe("suggestSlots", () => {
  const from = new Date("2026-09-22T12:00:00Z");

  it("uses the platform's default slots from Settings, as UTC ISO strings", async () => {
    const db = await createTestDb();
    // SETTING_DEFAULTS.defaultSlots: x 10:00 / 17:00, linkedin 09:00 (Europe/Rome).
    expect(await suggestSlots(db, { platform: "x", from, days: 2 })).toEqual([
      "2026-09-22T15:00:00.000Z", "2026-09-23T08:00:00.000Z", "2026-09-23T15:00:00.000Z",
    ]);
    expect(await suggestSlots(db, { platform: "linkedin", from, days: 2 })).toEqual(["2026-09-23T07:00:00.000Z"]);
  });

  it("skips slots already taken by a non-canceled schedule for that platform", async () => {
    const db = await createTestDb();
    const [draft] = await db.insert(drafts).values({ xText: "a", linkedinText: "b" }).returning();
    await db.insert(scheduledPosts).values([
      // queued at Wed 10:00 → taken
      { draftId: draft.id, platform: "x", text: "a", publishAt: new Date("2026-09-23T08:00:00Z") },
      // emailed, 15 seconds into Wed 17:00 → still that minute, taken
      { draftId: draft.id, platform: "x", text: "a", publishAt: new Date("2026-09-23T15:00:15Z"), status: "emailed" },
      // canceled at Tue 17:00 → free again
      { draftId: draft.id, platform: "x", text: "a", publishAt: new Date("2026-09-22T15:00:00Z"), status: "canceled" },
      // another platform at Thu 10:00 → irrelevant for X
      { draftId: draft.id, platform: "linkedin", text: "b", publishAt: new Date("2026-09-24T08:00:00Z") },
    ]);
    expect(await suggestSlots(db, { platform: "x", from, days: 3 })).toEqual([
      "2026-09-22T15:00:00.000Z", "2026-09-24T08:00:00.000Z", "2026-09-24T15:00:00.000Z",
    ]);
  });

  it("honors custom slots saved in Settings and is empty for a platform with none", async () => {
    const db = await createTestDb();
    await setSetting(db, "defaultSlots", { x: ["23:00", "07:30"] });
    expect(await suggestSlots(db, { platform: "x", from, days: 2 })).toEqual([
      "2026-09-22T21:00:00.000Z", "2026-09-23T05:30:00.000Z", "2026-09-23T21:00:00.000Z",
    ]);
    expect(await suggestSlots(db, { platform: "linkedin", from, days: 2 })).toEqual([]);
  });

  it("defaults to a 7-day window starting now", async () => {
    const db = await createTestDb();
    const before = Date.now();
    const slots = await suggestSlots(db, { platform: "x" });
    // 2 slots × 7 Rome days, minus today's slots that have already passed.
    expect(slots.length).toBeGreaterThanOrEqual(12);
    expect(slots.length).toBeLessThanOrEqual(14);
    for (const slot of slots) expect(new Date(slot).getTime()).toBeGreaterThan(before);
    expect([...slots].sort()).toEqual(slots);
  });
});

describe("createSchedule", () => {
  const publishAt = new Date("2030-01-01T16:00:00Z");

  it("queues the draft's X text at publishAt and marks the draft used", async () => {
    const db = await createTestDb();
    const [draft] = await db.insert(drafts).values({ xText: "hello x", linkedinText: "hello linkedin", status: "kept" }).returning();

    const result = await createSchedule(db, { draftId: draft.id, platform: "x", publishAt });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.post).toMatchObject({
      draftId: draft.id, platform: "x", text: "hello x", status: "queued", postedBy: null, externalId: null, publishedAt: null,
    });
    expect(result.post.publishAt).toEqual(publishAt);
    expect(result.post.createdAt).toBeInstanceOf(Date);

    const [used] = await db.select().from(drafts).where(eq(drafts.id, draft.id));
    expect(used.status).toBe("used");
  });

  it("freezes the LinkedIn text for a LinkedIn schedule", async () => {
    const db = await createTestDb();
    const [draft] = await db.insert(drafts).values({ xText: "hello x", linkedinText: "hello linkedin" }).returning();
    const result = await createSchedule(db, { draftId: draft.id, platform: "linkedin", publishAt });
    expect(result).toMatchObject({ ok: true, post: { platform: "linkedin", text: "hello linkedin" } });
  });

  it("returns draft_not_found for an unknown draft", async () => {
    const db = await createTestDb();
    expect(await createSchedule(db, { draftId: UNKNOWN_ID, platform: "x", publishAt })).toMatchObject({ ok: false, code: "draft_not_found" });
    expect(await db.select().from(scheduledPosts)).toHaveLength(0);
  });

  it("returns no_text when the draft has no (or only blank) text for the platform", async () => {
    const db = await createTestDb();
    const [xOnly] = await db.insert(drafts).values({ xText: "only x", linkedinText: "   " }).returning();
    expect(await createSchedule(db, { draftId: xOnly.id, platform: "linkedin", publishAt })).toMatchObject({ ok: false, code: "no_text" });
    const [empty] = await db.insert(drafts).values({}).returning();
    expect(await createSchedule(db, { draftId: empty.id, platform: "x", publishAt })).toMatchObject({ ok: false, code: "no_text" });
    // Nothing was queued and neither draft was marked used.
    expect(await db.select().from(scheduledPosts)).toHaveLength(0);
    expect((await db.select().from(drafts)).map((d) => d.status)).toEqual(["candidate", "candidate"]);
  });

  it("caps X at 280 characters but not LinkedIn", async () => {
    const db = await createTestDb();
    const long = "x".repeat(X_LIMIT + 1);
    const [draft] = await db.insert(drafts).values({ xText: long, linkedinText: long }).returning();
    expect(await createSchedule(db, { draftId: draft.id, platform: "x", publishAt })).toMatchObject({ ok: false, code: "too_long" });
    expect(await createSchedule(db, { draftId: draft.id, platform: "linkedin", publishAt })).toMatchObject({ ok: true });

    const [exact] = await db.insert(drafts).values({ xText: "x".repeat(X_LIMIT) }).returning();
    expect(await createSchedule(db, { draftId: exact.id, platform: "x", publishAt })).toMatchObject({ ok: true });
  });

  it("rejects a publishAt in the past beyond the one-minute tolerance", async () => {
    const db = await createTestDb();
    const now = new Date("2026-09-22T12:00:00Z");
    const [draft] = await db.insert(drafts).values({ xText: "hello" }).returning();
    const at = (deltaMs: number) => new Date(now.getTime() + deltaMs);

    expect(await createSchedule(db, { draftId: draft.id, platform: "x", publishAt: at(-2 * 60_000), now })).toMatchObject({ ok: false, code: "in_past" });
    expect(await createSchedule(db, { draftId: draft.id, platform: "x", publishAt: new Date("garbage"), now })).toMatchObject({ ok: false, code: "in_past" });
    // Half a minute ago is "now" for a click that raced the clock.
    expect(await createSchedule(db, { draftId: draft.id, platform: "x", publishAt: at(-30_000), now })).toMatchObject({ ok: true });
  });

  it("refuses a second queued schedule for the same draft+platform, allows other platforms and a re-schedule after a cancel", async () => {
    const db = await createTestDb();
    const [draft] = await db.insert(drafts).values({ xText: "hello", linkedinText: "hello there" }).returning();

    const first = await createSchedule(db, { draftId: draft.id, platform: "x", publishAt });
    expect(first.ok).toBe(true);
    const again = await createSchedule(db, { draftId: draft.id, platform: "x", publishAt: new Date("2030-01-02T16:00:00Z") });
    expect(again).toMatchObject({ ok: false, code: "conflict" });
    expect(await createSchedule(db, { draftId: draft.id, platform: "linkedin", publishAt })).toMatchObject({ ok: true });

    if (!first.ok) return;
    await cancelSchedule(db, first.post.id);
    expect(await createSchedule(db, { draftId: draft.id, platform: "x", publishAt })).toMatchObject({ ok: true, post: { status: "queued" } });
    expect(await db.select().from(scheduledPosts)).toHaveLength(3);
  });
});

describe("cancelSchedule", () => {
  it("cancels a queued row, idempotently", async () => {
    const db = await createTestDb();
    const [draft] = await db.insert(drafts).values({ xText: "hello" }).returning();
    const [post] = await db.insert(scheduledPosts).values({ draftId: draft.id, platform: "x", text: "hello", publishAt: new Date("2030-01-01T16:00:00Z") }).returning();

    const canceled = await cancelSchedule(db, post.id);
    expect(canceled).toMatchObject({ id: post.id, status: "canceled" });
    const again = await cancelSchedule(db, post.id);
    expect(again).toMatchObject({ id: post.id, status: "canceled" });
    expect(await db.select().from(scheduledPosts)).toHaveLength(1);
  });

  it("returns null for an unknown id", async () => {
    const db = await createTestDb();
    expect(await cancelSchedule(db, UNKNOWN_ID)).toBeNull();
  });

  it("cancels emailed and failed rows, leaves published and posted ones unchanged", async () => {
    const db = await createTestDb();
    const [draft] = await db.insert(drafts).values({ xText: "hello" }).returning();
    // One posted row per (draft, platform) since 2026-09-24: the posted one is another draft's.
    const [other] = await db.insert(drafts).values({ xText: "hello again" }).returning();
    const publishAt = new Date("2030-01-01T16:00:00Z");
    const rows = await db.insert(scheduledPosts).values([
      { draftId: draft.id, platform: "x", text: "hello", publishAt, status: "emailed" },
      { draftId: draft.id, platform: "x", text: "hello", publishAt, status: "failed" },
      { draftId: draft.id, platform: "x", text: "hello", publishAt, status: "published" },
      // Posted, its time past: a posted_manually row still ahead is scheduled on the platform, and removable (2026-09-24).
      { draftId: other.id, platform: "x", text: "hello again", publishAt: new Date("2026-01-01T16:00:00Z"), status: "posted_manually" },
    ]).returning();
    const after = await Promise.all(rows.map((r) => cancelSchedule(db, r.id)));
    expect(after.map((r) => r?.status)).toEqual(["canceled", "canceled", "published", "posted_manually"]);
  });
});

describe("listSchedules", () => {
  it("joins each row with the draft's texts and the idea title, soonest first", async () => {
    const db = await createTestDb();
    const [idea] = await db.insert(ideas).values({ kind: "note", content: "seed", title: "A talk" }).returning();
    const [withIdea] = await db.insert(drafts).values({ ideaId: idea.id, xText: "x text", linkedinText: "li text" }).returning();
    const [orphan] = await db.insert(drafts).values({ xText: "lonely" }).returning();
    await db.insert(scheduledPosts).values([
      { draftId: withIdea.id, platform: "linkedin", text: "li text", publishAt: new Date("2030-01-03T08:00:00Z") },
      { draftId: orphan.id, platform: "x", text: "lonely", publishAt: new Date("2030-01-01T16:00:00Z") },
      { draftId: withIdea.id, platform: "x", text: "x text", publishAt: new Date("2030-01-02T16:00:00Z") },
    ]);

    const rows = await listSchedules(db);
    expect(rows.map((r) => [r.text, r.xText, r.linkedinText, r.ideaTitle])).toEqual([
      ["lonely", "lonely", null, null],
      ["x text", "x text", "li text", "A talk"],
      ["li text", "x text", "li text", "A talk"],
    ]);
    expect(rows[0]).toMatchObject({ draftId: orphan.id, platform: "x", status: "queued" });
  });

  it("filters by half-open [from, to) and by status", async () => {
    const db = await createTestDb();
    const [draft] = await db.insert(drafts).values({ xText: "hello" }).returning();
    await db.insert(scheduledPosts).values([
      { draftId: draft.id, platform: "x", text: "hello", publishAt: new Date("2030-01-01T00:00:00Z"), status: "published" },
      { draftId: draft.id, platform: "x", text: "hello", publishAt: new Date("2030-01-15T12:00:00Z") },
      { draftId: draft.id, platform: "x", text: "hello", publishAt: new Date("2030-02-01T00:00:00Z"), status: "canceled" },
    ]);
    const january = { from: new Date("2030-01-01T00:00:00Z"), to: new Date("2030-02-01T00:00:00Z") };
    expect((await listSchedules(db, january)).map((r) => r.publishAt.toISOString())).toEqual([
      "2030-01-01T00:00:00.000Z", "2030-01-15T12:00:00.000Z",
    ]);
    expect((await listSchedules(db, { from: new Date("2030-01-10T00:00:00Z") })).map((r) => r.status)).toEqual(["queued", "canceled"]);
    expect((await listSchedules(db, { to: new Date("2030-01-10T00:00:00Z") })).map((r) => r.status)).toEqual(["published"]);
    expect((await listSchedules(db, { status: "queued" })).map((r) => r.publishAt.toISOString())).toEqual(["2030-01-15T12:00:00.000Z"]);
    expect(await listSchedules(db, { ...january, status: "canceled" })).toEqual([]);
  });
});

describe("markPostedManually", () => {
  it("records a posted_manually row now and marks the draft used", async () => {
    const db = await createTestDb();
    const [draft] = await db.insert(drafts).values({ xText: "posted by hand", status: "kept" }).returning();
    const before = Date.now();

    const result = await markPostedManually(db, { draftId: draft.id });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.post).toMatchObject({ draftId: draft.id, platform: "x", text: "posted by hand", status: "posted_manually", postedBy: "manual" });
    expect(result.post.publishAt.getTime()).toBeGreaterThanOrEqual(before);
    expect(result.post.publishedAt?.getTime()).toBeGreaterThanOrEqual(before);

    const [used] = await db.select().from(drafts).where(eq(drafts.id, draft.id));
    expect(used.status).toBe("used");
  });

  it("honors an explicit publishAt", async () => {
    const db = await createTestDb();
    const [draft] = await db.insert(drafts).values({ xText: "hello" }).returning();
    const publishAt = new Date("2026-09-20T10:00:00Z");
    const result = await markPostedManually(db, { draftId: draft.id, publishAt });
    expect(result.ok && result.post.publishAt).toEqual(publishAt);
  });

  it("converts a queued X schedule of the same draft instead of adding a second row", async () => {
    const db = await createTestDb();
    const [draft] = await db.insert(drafts).values({ xText: "hello", linkedinText: "hello there" }).returning();
    const queued = await createSchedule(db, { draftId: draft.id, platform: "x", publishAt: new Date("2030-01-01T16:00:00Z") });
    const linkedin = await createSchedule(db, { draftId: draft.id, platform: "linkedin", publishAt: new Date("2030-01-01T16:00:00Z") });
    if (!queued.ok || !linkedin.ok) throw new Error("setup failed");
    await db.update(scheduledPosts).set({ externalId: "qstash-msg-1" }).where(eq(scheduledPosts.id, queued.post.id));

    const result = await markPostedManually(db, { draftId: draft.id });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Same row, now posted, with its QStash id still attached for the route to clean up.
    expect(result.post).toMatchObject({ id: queued.post.id, status: "posted_manually", postedBy: "manual", externalId: "qstash-msg-1" });
    expect(result.post.publishAt.getTime()).toBeLessThan(new Date("2030-01-01T16:00:00Z").getTime());

    const rows = await listSchedules(db);
    expect(rows.map((r) => [r.platform, r.status])).toEqual([["x", "posted_manually"], ["linkedin", "queued"]]);
  });

  it("returns typed errors for an unknown draft or missing / over-long X text", async () => {
    const db = await createTestDb();
    expect(await markPostedManually(db, { draftId: UNKNOWN_ID })).toMatchObject({ ok: false, code: "draft_not_found" });
    const [linkedinOnly] = await db.insert(drafts).values({ linkedinText: "only linkedin" }).returning();
    expect(await markPostedManually(db, { draftId: linkedinOnly.id })).toMatchObject({ ok: false, code: "no_text" });
    const [long] = await db.insert(drafts).values({ xText: "x".repeat(X_LIMIT + 1) }).returning();
    expect(await markPostedManually(db, { draftId: long.id })).toMatchObject({ ok: false, code: "too_long" });
    expect(await db.select().from(scheduledPosts)).toHaveLength(0);
  });
});

describe("the timer (P2 wiring)", () => {
  const FUTURE = new Date("2030-01-01T16:00:00.000Z");
  const DISABLED = { enabled: false as const, reason: "test" };

  function fakeQstash() {
    const scheduleMessage = vi.fn(async () => "msg_1");
    const deleteMessage = vi.fn(async () => {});
    return { qstash: { enabled: true as const, scheduleMessage, deleteMessage }, scheduleMessage, deleteMessage };
  }

  beforeEach(() => vi.stubEnv("PUBLIC_BASE_URL", "https://app.test/"));
  afterEach(() => vi.unstubAllEnvs());

  it("timerFireAt: the lead before the slot, never before now + 5s", () => {
    const now = new Date("2030-01-01T10:00:00Z");
    expect(timerFireAt(FUTURE, 5, now).toISOString()).toBe("2030-01-01T15:55:00.000Z");
    expect(timerFireAt(FUTURE, 0, now).toISOString()).toBe("2030-01-01T16:00:00.000Z");
    // Inside the lead time, or already past: right away.
    const late = new Date("2030-01-01T15:58:00Z");
    expect(timerFireAt(FUTURE, 5, late).getTime()).toBe(late.getTime() + MIN_TIMER_DELAY_MS);
    expect(timerFireAt(FUTURE, 5, new Date("2030-01-01T16:00:30Z")).getTime()).toBe(Date.UTC(2030, 0, 1, 16, 0, 35));
    expect(MIN_TIMER_DELAY_MS).toBe(5_000);
  });

  it("publishes one message per schedule — the publish url, slot − lead (default 5 min), the id as body — and stores its id", async () => {
    const db = await createTestDb();
    const { qstash, scheduleMessage } = fakeQstash();
    const [draft] = await db.insert(drafts).values({ xText: "hello", status: "kept" }).returning();
    const now = new Date("2030-01-01T10:00:00Z");

    const result = await createSchedule(db, { draftId: draft.id, platform: "x", publishAt: FUTURE, now, qstash });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.post.externalId).toBe("msg_1");
    expect(scheduleMessage).toHaveBeenCalledTimes(1);
    expect(scheduleMessage).toHaveBeenCalledWith({
      url: `https://app.test/api/publish/${result.post.id}`,
      notBeforeMs: Date.UTC(2030, 0, 1, 15, 55),
      body: { id: result.post.id },
    });
    const [stored] = await db.select().from(scheduledPosts).where(eq(scheduledPosts.id, result.post.id));
    expect(stored).toMatchObject({ externalId: "msg_1", status: "queued" });
    const [used] = await db.select().from(drafts).where(eq(drafts.id, draft.id));
    expect(used.status).toBe("used");
  });

  it("honors Settings leadTimeMinutes, falling back to the default for a bad value", async () => {
    const db = await createTestDb();
    const { qstash, scheduleMessage } = fakeQstash();
    const [draft] = await db.insert(drafts).values({ xText: "a", linkedinText: "b" }).returning();
    const now = new Date("2030-01-01T10:00:00Z");

    await setSetting(db, "leadTimeMinutes", 30);
    await createSchedule(db, { draftId: draft.id, platform: "x", publishAt: FUTURE, now, qstash });
    expect(scheduleMessage).toHaveBeenLastCalledWith(expect.objectContaining({ notBeforeMs: Date.UTC(2030, 0, 1, 15, 30) }));

    await setSetting(db, "leadTimeMinutes", -3);
    await createSchedule(db, { draftId: draft.id, platform: "linkedin", publishAt: FUTURE, now, qstash });
    expect(scheduleMessage).toHaveBeenLastCalledWith(expect.objectContaining({ notBeforeMs: Date.UTC(2030, 0, 1, 15, 55) }));
  });

  it("clamps a slot inside its lead time to now + 5s", async () => {
    const db = await createTestDb();
    const { qstash, scheduleMessage } = fakeQstash();
    const [draft] = await db.insert(drafts).values({ xText: "soon" }).returning();
    const now = new Date("2030-01-01T15:59:00Z");
    const result = await createSchedule(db, { draftId: draft.id, platform: "x", publishAt: FUTURE, now, qstash });
    expect(result.ok).toBe(true);
    expect(scheduleMessage).toHaveBeenCalledWith(expect.objectContaining({ notBeforeMs: now.getTime() + MIN_TIMER_DELAY_MS }));
  });

  it("leaves externalId null with the timer off — the schedule still works", async () => {
    const db = await createTestDb();
    const [draft] = await db.insert(drafts).values({ xText: "hello" }).returning();
    const result = await createSchedule(db, { draftId: draft.id, platform: "x", publishAt: FUTURE, qstash: DISABLED });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.post).toMatchObject({ status: "queued", externalId: null });
  });

  it("undoes the schedule when the message can't be published: row canceled, draft status restored, error propagated", async () => {
    const db = await createTestDb();
    const { qstash, scheduleMessage } = fakeQstash();
    scheduleMessage.mockRejectedValueOnce(new Error("qstash: 401 unauthorized"));
    const [draft] = await db.insert(drafts).values({ xText: "hello", status: "kept" }).returning();

    await expect(createSchedule(db, { draftId: draft.id, platform: "x", publishAt: FUTURE, qstash })).rejects.toThrow("qstash: 401 unauthorized");
    const rows = await db.select().from(scheduledPosts).where(eq(scheduledPosts.draftId, draft.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: "canceled", externalId: null, error: expect.stringContaining("timer could not be set") });
    const [restored] = await db.select().from(drafts).where(eq(drafts.id, draft.id));
    expect(restored.status).toBe("kept");
    // The slot is free again: scheduling once more works.
    expect((await createSchedule(db, { draftId: draft.id, platform: "x", publishAt: FUTURE, qstash })).ok).toBe(true);
  });

  it("cancelSchedule cancels the QStash message of a timed row, and nothing for an untimed one", async () => {
    const db = await createTestDb();
    const { qstash, deleteMessage } = fakeQstash();
    const [draft] = await db.insert(drafts).values({ xText: "a", linkedinText: "b" }).returning();
    const timed = await createSchedule(db, { draftId: draft.id, platform: "x", publishAt: FUTURE, qstash });
    const untimed = await createSchedule(db, { draftId: draft.id, platform: "linkedin", publishAt: FUTURE, qstash: DISABLED });
    if (!timed.ok || !untimed.ok) throw new Error("expected ok");

    expect((await cancelSchedule(db, timed.post.id, { qstash }))?.status).toBe("canceled");
    expect(deleteMessage).toHaveBeenCalledWith("msg_1");
    expect((await cancelSchedule(db, untimed.post.id, { qstash }))?.status).toBe("canceled");
    expect(deleteMessage).toHaveBeenCalledTimes(1);
    // Idempotent: canceling again touches nothing.
    await cancelSchedule(db, timed.post.id, { qstash });
    expect(deleteMessage).toHaveBeenCalledTimes(1);
  });

  it("cancelSchedule survives a QStash failure — the row is canceled regardless", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const db = await createTestDb();
    const { qstash, deleteMessage } = fakeQstash();
    deleteMessage.mockRejectedValueOnce(new Error("upstash down"));
    const [draft] = await db.insert(drafts).values({ xText: "a" }).returning();
    const created = await createSchedule(db, { draftId: draft.id, platform: "x", publishAt: FUTURE, qstash });
    if (!created.ok) throw new Error("expected ok");
    expect((await cancelSchedule(db, created.post.id, { qstash }))?.status).toBe("canceled");
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it("markPostedManually drops the timer of the queued row it converts", async () => {
    const db = await createTestDb();
    const { qstash, deleteMessage } = fakeQstash();
    const [draft] = await db.insert(drafts).values({ xText: "a", linkedinText: "b" }).returning();
    const created = await createSchedule(db, { draftId: draft.id, platform: "x", publishAt: FUTURE, qstash });
    if (!created.ok) throw new Error("expected ok");

    const posted = await markPostedManually(db, { draftId: draft.id, platform: "x", qstash });
    expect(posted.ok).toBe(true);
    if (!posted.ok) return;
    expect(posted.post).toMatchObject({ id: created.post.id, status: "posted_manually" });
    expect(deleteMessage).toHaveBeenCalledWith("msg_1");

    // A fresh row (nothing to convert) has no timer to drop.
    const fresh = await markPostedManually(db, { draftId: draft.id, platform: "linkedin", qstash });
    expect(fresh.ok).toBe(true);
    expect(deleteMessage).toHaveBeenCalledTimes(1);
  });
});


describe("updateSchedule — Plan's Edit (2026-09-24)", () => {
  const NOW = new Date("2030-01-01T10:00:00Z");
  const SLOT = new Date("2030-01-01T16:00:00Z");
  const LATER = new Date("2030-01-02T09:30:00Z");
  const DISABLED = { enabled: false as const, reason: "test" };

  function fakeQstash(ids = ["msg_new"]) {
    let i = 0;
    const scheduleMessage = vi.fn(async () => ids[Math.min(i++, ids.length - 1)]!);
    const deleteMessage = vi.fn(async () => {});
    return { qstash: { enabled: true as const, scheduleMessage, deleteMessage }, scheduleMessage, deleteMessage };
  }

  async function queued(db: Awaited<ReturnType<typeof createTestDb>>, over: Partial<typeof scheduledPosts.$inferInsert> = {}) {
    const [draft] = await db.insert(drafts).values({ xText: "hello", status: "used" }).returning();
    const [post] = await db.insert(scheduledPosts).values({ draftId: draft.id, platform: "x", text: "hello", publishAt: SLOT, externalId: "msg_old", ...over }).returning();
    return post;
  }

  beforeEach(() => vi.stubEnv("PUBLIC_BASE_URL", "https://app.test/"));
  afterEach(() => vi.unstubAllEnvs());

  it("a new time: a new timer first, the row moved to it, then the old timer forgotten", async () => {
    const db = await createTestDb();
    const post = await queued(db);
    const { qstash, scheduleMessage, deleteMessage } = fakeQstash();
    const result = await updateSchedule(db, post.id, { publishAt: LATER, now: NOW, qstash });
    expect(result).toMatchObject({ ok: true, post: { publishAt: LATER, externalId: "msg_new", status: "queued", text: "hello" } });
    expect(scheduleMessage).toHaveBeenCalledWith({ url: `https://app.test/api/publish/${post.id}`, notBeforeMs: Date.UTC(2030, 0, 2, 9, 25), body: { id: post.id } });
    expect(deleteMessage).toHaveBeenCalledWith("msg_old");
  });

  it("only the text: the same timer, the new text frozen on the row; X over 280 or empty is refused", async () => {
    const db = await createTestDb();
    const post = await queued(db);
    const { qstash, scheduleMessage, deleteMessage } = fakeQstash();
    expect(await updateSchedule(db, post.id, { text: "hello, edited", now: NOW, qstash })).toMatchObject({ ok: true, post: { text: "hello, edited", externalId: "msg_old" } });
    expect(scheduleMessage).not.toHaveBeenCalled();
    expect(deleteMessage).not.toHaveBeenCalled();
    expect(await updateSchedule(db, post.id, { text: "x".repeat(X_LIMIT + 1), now: NOW, qstash })).toMatchObject({ ok: false, code: "too_long" });
    expect(await updateSchedule(db, post.id, { text: "  ", now: NOW, qstash })).toMatchObject({ ok: false, code: "no_text" });
  });

  it("an emailed or failed post is queued again for its new time, its error and email time cleared", async () => {
    const db = await createTestDb();
    const emailed = await queued(db, { status: "emailed", emailedAt: new Date("2030-01-01T09:55:00Z") });
    const { qstash } = fakeQstash();
    expect(await updateSchedule(db, emailed.id, { publishAt: LATER, now: NOW, qstash })).toMatchObject({
      ok: true, post: { status: "queued", emailedAt: null, error: null, externalId: "msg_new" },
    });
    const failed = await queued(db, { status: "failed", error: "send failed" });
    expect(await updateSchedule(db, failed.id, { publishAt: LATER, now: NOW, qstash: DISABLED })).toMatchObject({
      ok: true, post: { status: "queued", error: null, externalId: null },
    });
  });

  it("refuses a time in the past, a done or canceled post, and an unknown id — touching no timer", async () => {
    const db = await createTestDb();
    const { qstash, scheduleMessage } = fakeQstash();
    const post = await queued(db);
    expect(await updateSchedule(db, post.id, { publishAt: new Date("2029-12-31T10:00:00Z"), now: NOW, qstash })).toMatchObject({ ok: false, code: "in_past" });
    // Its time before NOW: posted. One still ahead would be scheduled on the platform, and editable.
    const posted = await queued(db, { status: "posted_manually", publishAt: new Date("2029-12-31T16:00:00Z") });
    expect(await updateSchedule(db, posted.id, { publishAt: LATER, now: NOW, qstash })).toMatchObject({ ok: false, code: "not_editable" });
    const canceled = await queued(db, { status: "canceled" });
    expect(await updateSchedule(db, canceled.id, { publishAt: LATER, now: NOW, qstash })).toMatchObject({ ok: false, code: "not_editable", error: "this post was canceled" });
    expect(await updateSchedule(db, UNKNOWN_ID, { publishAt: LATER, now: NOW, qstash })).toBeNull();
    expect(scheduleMessage).not.toHaveBeenCalled();
  });

  it("queuing again while another schedule of the same post is queued: a conflict, and the new timer is dropped", async () => {
    const db = await createTestDb();
    const failed = await queued(db, { status: "failed" });
    await db.insert(scheduledPosts).values({ draftId: failed.draftId, platform: "x", text: "hello", publishAt: SLOT, status: "queued" });
    const { qstash, deleteMessage } = fakeQstash();
    expect(await updateSchedule(db, failed.id, { publishAt: LATER, now: NOW, qstash })).toMatchObject({ ok: false, code: "conflict" });
    expect(deleteMessage).toHaveBeenCalledWith("msg_new");
    const [row] = await db.select().from(scheduledPosts).where(eq(scheduledPosts.id, failed.id));
    expect(row.status).toBe("failed");
  });
});


describe("never the same post twice (2026-09-24: \"never allow double posted if it's the same post\")", () => {
  const SLOT = new Date("2030-01-01T16:00:00Z");
  const LATER = new Date("2030-01-02T16:00:00Z");

  function fakeQstash() {
    const deleteMessage = vi.fn(async () => {});
    return { qstash: { enabled: true as const, scheduleMessage: vi.fn(async () => "msg"), deleteMessage }, deleteMessage };
  }

  async function emailedPost(db: Awaited<ReturnType<typeof createTestDb>>, platform: "x" | "linkedin" = "linkedin") {
    const [draft] = await db.insert(drafts).values({ xText: "the X", linkedinText: "the LinkedIn post", status: "used" }).returning();
    const [row] = await db.insert(scheduledPosts).values({
      draftId: draft.id, platform, text: platform === "x" ? "the X" : "the LinkedIn post", publishAt: SLOT, status: "emailed", externalId: "msg_1",
    }).returning();
    return { draft, row };
  }

  const postedRows = async (db: Awaited<ReturnType<typeof createTestDb>>) =>
    (await db.select().from(scheduledPosts)).filter((r) => r.status === "posted_manually" || r.status === "published");

  it("the owner's case: Mark as posted in the email, then in the app — one posted post, the app gets it back", async () => {
    const db = await createTestDb();
    const { qstash } = fakeQstash();
    const { draft, row } = await emailedPost(db);
    expect((await markPostedById(db, row.id, { qstash }))?.status).toBe("posted_manually");
    const again = await markPostedManually(db, { draftId: draft.id, platform: "linkedin", qstash });
    expect(again).toMatchObject({ ok: true, post: { id: row.id } });
    expect(await postedRows(db)).toHaveLength(1);
  });

  it("the other way round: the app first, then the email's link — still one", async () => {
    const db = await createTestDb();
    const { qstash } = fakeQstash();
    const { draft, row } = await emailedPost(db);
    const first = await markPostedManually(db, { draftId: draft.id, platform: "linkedin", qstash });
    expect(first).toMatchObject({ ok: true, post: { id: row.id, status: "posted_manually" } });
    expect((await markPostedById(db, row.id, { qstash }))?.id).toBe(row.id);
    expect(await postedRows(db)).toHaveLength(1);
  });

  it("another schedule of the same post is set aside, its timer forgotten, and Plan doesn't list it", async () => {
    const db = await createTestDb();
    const { qstash, deleteMessage } = fakeQstash();
    const { draft, row } = await emailedPost(db);
    const [second] = await db.insert(scheduledPosts).values({ draftId: draft.id, platform: "linkedin", text: "the LinkedIn post", publishAt: LATER, externalId: "msg_2" }).returning();
    await markPostedById(db, row.id, { qstash });
    const [aside] = await db.select().from(scheduledPosts).where(eq(scheduledPosts.id, second.id));
    expect(aside).toMatchObject({ status: "canceled", error: ALREADY_POSTED_NOTE });
    expect(deleteMessage).toHaveBeenCalledWith("msg_2");
    expect((await listSchedules(db)).map((r) => r.id)).toEqual([row.id]);
    // Its own email link later: the post already out comes back, nothing is posted twice.
    expect((await markPostedById(db, second.id, { qstash }))?.id).toBe(row.id);
    expect(await postedRows(db)).toHaveLength(1);
  });

  it("the same text from a copy of the draft counts as the same post for 30 days", async () => {
    const db = await createTestDb();
    const { qstash } = fakeQstash();
    const { row } = await emailedPost(db);
    await markPostedById(db, row.id, { qstash, now: new Date() });
    const [copy] = await db.insert(drafts).values({ linkedinText: "  the LinkedIn   post ", status: "kept" }).returning();
    expect(await markPostedManually(db, { draftId: copy.id, platform: "linkedin", qstash })).toMatchObject({ ok: true, post: { id: row.id } });
    // Long after: a new post.
    await db.update(scheduledPosts).set({ publishedAt: new Date(Date.now() - SAME_TEXT_WINDOW_MS - 60_000) }).where(eq(scheduledPosts.id, row.id));
    const later = await markPostedManually(db, { draftId: copy.id, platform: "linkedin", qstash });
    expect(later.ok && later.post.id).not.toBe(row.id);
  });

  it("Schedule refuses a post that's already out", async () => {
    const db = await createTestDb();
    const { qstash } = fakeQstash();
    const { draft, row } = await emailedPost(db, "x");
    await markPostedById(db, row.id, { qstash });
    expect(await createSchedule(db, { draftId: draft.id, platform: "x", publishAt: LATER, now: SLOT, qstash })).toMatchObject({ ok: false, code: "already_posted" });
  });

  it("two marks at the same instant still make one posted post, and the database refuses a second one outright", async () => {
    const db = await createTestDb();
    const { qstash } = fakeQstash();
    const { draft, row } = await emailedPost(db);
    const [a, b] = await Promise.all([
      markPostedManually(db, { draftId: draft.id, platform: "linkedin", qstash }),
      markPostedById(db, row.id, { qstash }),
    ]);
    expect(a.ok).toBe(true);
    expect(b).not.toBeNull();
    expect(await postedRows(db)).toHaveLength(1);
    await expect(db.insert(scheduledPosts).values({ draftId: draft.id, platform: "linkedin", text: "x", publishAt: SLOT, status: "posted_manually" })).rejects.toThrow();
  });
});


describe("scheduled on the platform itself (2026-09-24: Plan keeps the posts ready on X and LinkedIn)", () => {
  function fakeQstash() {
    const scheduleMessage = vi.fn(async () => "msg");
    const deleteMessage = vi.fn(async () => {});
    return { qstash: { enabled: true as const, scheduleMessage, deleteMessage }, scheduleMessage, deleteMessage };
  }
  const inHours = (h: number) => new Date(Date.now() + h * 3_600_000);

  it("a time ahead is recorded as scheduled there: posted_manually at that time, no timer, the draft used", async () => {
    const db = await createTestDb();
    const { qstash, scheduleMessage } = fakeQstash();
    const [draft] = await db.insert(drafts).values({ xText: "ready for X", status: "kept" }).returning();
    const at = inHours(20);
    const result = await markPostedManually(db, { draftId: draft.id, platform: "x", publishAt: at, qstash });
    expect(result).toMatchObject({ ok: true, post: { status: "posted_manually", publishAt: at, publishedAt: at, postedBy: "manual", externalId: null } });
    expect(result.ok && isScheduledOnPlatform(result.post)).toBe(true);
    expect(scheduleMessage).not.toHaveBeenCalled();
    const [used] = await db.select().from(drafts).where(eq(drafts.id, draft.id));
    expect(used.status).toBe("used");
    // The same post can't be recorded or queued a second time.
    expect(await createSchedule(db, { draftId: draft.id, platform: "x", publishAt: inHours(30), qstash })).toMatchObject({ ok: false, code: "already_posted" });
  });

  it("Plan's Edit changes only the record, its time still ahead; Remove takes it off Plan", async () => {
    const db = await createTestDb();
    const { qstash, scheduleMessage } = fakeQstash();
    const [draft] = await db.insert(drafts).values({ linkedinText: "ready for LinkedIn", status: "kept" }).returning();
    const result = await markPostedManually(db, { draftId: draft.id, platform: "linkedin", publishAt: inHours(5), qstash });
    if (!result.ok) throw new Error("not recorded");
    const later = inHours(9);
    expect(await updateSchedule(db, result.post.id, { publishAt: later, text: "ready, edited", qstash })).toMatchObject({
      ok: true, post: { status: "posted_manually", publishAt: later, publishedAt: later, text: "ready, edited" },
    });
    expect(scheduleMessage).not.toHaveBeenCalled();
    expect(await updateSchedule(db, result.post.id, { publishAt: new Date(Date.now() - 60_000), qstash })).toMatchObject({ ok: false, code: "in_past" });
    expect((await cancelSchedule(db, result.post.id, { qstash }))?.status).toBe("canceled");
  });

  it("once its time has passed it's simply posted: no edit, no remove", async () => {
    const db = await createTestDb();
    const { qstash } = fakeQstash();
    const [draft] = await db.insert(drafts).values({ xText: "went out", status: "used" }).returning();
    const [row] = await db.insert(scheduledPosts).values({
      draftId: draft.id, platform: "x", text: "went out", status: "posted_manually", postedBy: "manual",
      publishAt: new Date(Date.now() - 3_600_000), publishedAt: new Date(Date.now() - 3_600_000),
    }).returning();
    expect(isScheduledOnPlatform(row)).toBe(false);
    expect(await updateSchedule(db, row.id, { publishAt: inHours(2), qstash })).toMatchObject({ ok: false, code: "not_editable" });
    expect((await cancelSchedule(db, row.id, { qstash }))?.status).toBe("posted_manually");
  });
});


describe("the source's link on each scheduled post (2026-09-25, for a first comment)", () => {
  it("prefers a discussion's article, then the idea's own link; a note has none", () => {
    expect(sourceUrlOf({ url: "https://news.ycombinator.com/item?id=41", meta: { articleUrl: "https://blog.example.com/arr" } })).toBe("https://blog.example.com/arr");
    expect(sourceUrlOf({ url: "https://x.com/levelsio/status/1", meta: {} })).toBe("https://x.com/levelsio/status/1");
    expect(sourceUrlOf({ url: null, meta: {} })).toBeNull();
    expect(sourceUrlOf({ url: "javascript:alert(1)", meta: { articleUrl: "ftp://nope" } })).toBeNull();
    expect(sourceUrlOf(null)).toBeNull();
  });

  it("listSchedules carries it with every row", async () => {
    const db = await createTestDb();
    const [idea] = await db.insert(ideas).values({ kind: "hackernews", url: "https://news.ycombinator.com/item?id=41", meta: { articleUrl: "https://blog.example.com/arr" } }).returning();
    const [draft] = await db.insert(drafts).values({ ideaId: idea.id, xText: "hi", status: "used" }).returning();
    const [loose] = await db.insert(drafts).values({ xText: "no idea", status: "used" }).returning();
    const at = new Date("2030-01-01T16:00:00Z");
    await db.insert(scheduledPosts).values([
      { draftId: draft.id, platform: "x", text: "hi", publishAt: at },
      { draftId: loose.id, platform: "x", text: "no idea", publishAt: new Date("2030-01-01T17:00:00Z") },
    ]);
    const rows = await listSchedules(db);
    expect(rows.map((r) => r.sourceUrl)).toEqual(["https://blog.example.com/arr", null]);
  });
});

describe("How did it do? (2026-09-26: \"sia se è andato bene che se è andato male\")", () => {
  const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000);
  async function outPost(db: Awaited<ReturnType<typeof createTestDb>>, over: Partial<typeof scheduledPosts.$inferInsert> = {}) {
    const [draft] = await db.insert(drafts).values({ xText: "went out", status: "used" }).returning();
    const [row] = await db.insert(scheduledPosts).values({
      draftId: draft.id, platform: "x", text: "went out", status: "posted_manually", postedBy: "manual",
      publishAt: hoursAgo(30), publishedAt: hoursAgo(30), ...over,
    }).returning();
    return row;
  }

  it("records 👍 or 👎 on a post that is out, changes it, and takes it back", async () => {
    const db = await createTestDb();
    const row = await outPost(db);
    const now = new Date();
    expect(isOut(row, now)).toBe(true);
    expect(await rateSchedule(db, row.id, "good", now)).toMatchObject({ ok: true, post: { outcome: "good", ratedAt: now } });
    expect(await rateSchedule(db, row.id, "bad", now)).toMatchObject({ ok: true, post: { outcome: "bad" } });
    expect(await rateSchedule(db, row.id, null, now)).toMatchObject({ ok: true, post: { outcome: null, ratedAt: null } });
  });

  it("refuses a post that isn't out yet, and knows nothing of an unknown id", async () => {
    const db = await createTestDb();
    const [draft] = await db.insert(drafts).values({ xText: "later", status: "kept" }).returning();
    const [queued] = await db.insert(scheduledPosts).values({
      draftId: draft.id, platform: "x", text: "later", publishAt: new Date(Date.now() + 3_600_000),
    }).returning();
    const ahead = await outPost(db, { publishAt: new Date(Date.now() + 3_600_000), publishedAt: new Date(Date.now() + 3_600_000) });
    expect(await rateSchedule(db, queued.id, "good")).toMatchObject({ ok: false, code: "not_out" });
    expect(await rateSchedule(db, ahead.id, "good")).toMatchObject({ ok: false, code: "not_out" });
    expect(await rateSchedule(db, UNKNOWN_ID, "good")).toBeNull();
  });

  it("lists the posts to rate: out 1 to 60 days, no vote yet, newest first", async () => {
    const db = await createTestDb();
    await outPost(db, { publishAt: hoursAgo(24 * 61) }); // too old
    await outPost(db, { publishAt: hoursAgo(2) }); // results not in yet
    const older = await outPost(db, { publishAt: hoursAgo(48) });
    const newer = await outPost(db, { publishAt: hoursAgo(30), status: "published", postedBy: "api" });
    await outPost(db, { publishAt: hoursAgo(40), outcome: "good", ratedAt: new Date() }); // voted
    expect((await listToRate(db)).map((r) => r.id)).toEqual([newer.id, older.id]);
  });
});
