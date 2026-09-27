import { describe, expect, it } from "vitest";
import {
  actionsFor,
  dayDots,
  dayKeyOf,
  dayLabel,
  dayRows,
  freeSlots,
  gridRangeUtc,
  groupByDay,
  inMonth,
  monthLabel,
  monthMatrix,
  monthOf,
  parseSlot,
  romeTime,
  romeToUtc,
  shiftDay,
  slotLabel,
  statusSummary,
  summaryLabel,
  type PlanPost,
} from "./plan-calendar";
import { isOutStatus, displayStatus as displayStatusOf, actionsFor as actionsOf, dotStatus as dotOf, statusSummary as summaryOf, summaryLabel as labelOf } from "./plan-calendar";

// Rome 2026: CEST (UTC+2) from Sun 29 Mar 02:00 to Sun 25 Oct 03:00, CET (UTC+1) otherwise.

let seq = 0;
function post(overrides: Partial<PlanPost> & { publishAt: string }): PlanPost {
  seq += 1;
  return {
    id: `post-${seq}`, draftId: `draft-${seq}`, platform: "x", text: `text ${seq}`, status: "queued",
    publishedUrl: null, error: null, emailedAt: null, publishedAt: null, ideaTitle: null,
    ...overrides,
  };
}

describe("dayKeyOf — Rome day bucketing", () => {
  it("rolls to the next Rome day at 22:00Z in summer and 23:00Z in winter", () => {
    expect(dayKeyOf("2026-09-22T21:59:00.000Z")).toBe("2026-09-22"); // 23:59 CEST
    expect(dayKeyOf("2026-09-22T22:00:00.000Z")).toBe("2026-09-23"); // 00:00 CEST
    expect(dayKeyOf("2026-09-22T22:30:00.000Z")).toBe("2026-09-23");
    expect(dayKeyOf("2026-01-15T22:59:00.000Z")).toBe("2026-01-15"); // 23:59 CET
    expect(dayKeyOf("2026-01-15T23:00:00.000Z")).toBe("2026-01-16"); // 00:00 CET
  });

  it("buckets correctly across both DST changes", () => {
    expect(dayKeyOf("2026-03-28T23:00:00.000Z")).toBe("2026-03-29"); // midnight into the spring-forward day (still CET)
    expect(dayKeyOf("2026-03-29T21:59:00.000Z")).toBe("2026-03-29"); // 23:59 CEST that evening
    expect(dayKeyOf("2026-03-29T22:00:00.000Z")).toBe("2026-03-30");
    expect(dayKeyOf("2026-10-25T22:59:00.000Z")).toBe("2026-10-25"); // 23:59 CET on the fall-back day
    expect(dayKeyOf("2026-10-25T23:00:00.000Z")).toBe("2026-10-26");
  });

  it("accepts a Date too", () => {
    expect(dayKeyOf(new Date("2026-09-22T12:00:00Z"))).toBe("2026-09-22");
  });
});

describe("romeTime", () => {
  it("reads the Rome wall clock, midnight as 00:00", () => {
    expect(romeTime("2026-09-22T15:00:00Z")).toBe("17:00"); // CEST
    expect(romeTime("2026-01-15T16:05:00Z")).toBe("17:05"); // CET
    expect(romeTime("2026-09-22T22:00:00Z")).toBe("00:00");
  });
});

describe("slotLabel — the Archive card's original slot", () => {
  it("spells the Rome weekday, day, month and time, rolling the day over at Rome midnight", () => {
    expect(slotLabel("2026-09-22T15:00:00Z")).toBe("Tue 22 Sept · 17:00"); // CEST; en-GB abbreviates as formatRomeSlot does
    expect(slotLabel("2026-01-15T16:05:00Z")).toBe("Thu 15 Jan · 17:05"); // CET
    expect(slotLabel("2026-09-22T22:00:00Z")).toBe("Wed 23 Sept · 00:00"); // 22:00Z is already Wednesday in Rome
    expect(slotLabel(new Date("2026-10-25T09:00:00Z"))).toBe("Sun 25 Oct · 10:00"); // the fall-back day, CET again
  });
});

describe("romeToUtc", () => {
  it("applies CET before and CEST after the spring change", () => {
    expect(romeToUtc({ year: 2026, month: 3, day: 28, hour: 10, minute: 0 }).toISOString()).toBe("2026-03-28T09:00:00.000Z");
    expect(romeToUtc({ year: 2026, month: 3, day: 29, hour: 10, minute: 0 }).toISOString()).toBe("2026-03-29T08:00:00.000Z");
  });

  it("applies CEST before and CET after the autumn change", () => {
    expect(romeToUtc({ year: 2026, month: 10, day: 24, hour: 10, minute: 0 }).toISOString()).toBe("2026-10-24T08:00:00.000Z");
    expect(romeToUtc({ year: 2026, month: 10, day: 25, hour: 10, minute: 0 }).toISOString()).toBe("2026-10-25T09:00:00.000Z");
  });

  it("puts Rome midnight on the previous UTC day", () => {
    expect(romeToUtc({ year: 2026, month: 9, day: 23, hour: 0, minute: 0 }).toISOString()).toBe("2026-09-22T22:00:00.000Z");
    expect(romeToUtc({ year: 2026, month: 1, day: 16, hour: 0, minute: 0 }).toISOString()).toBe("2026-01-15T23:00:00.000Z");
  });

  it("pins the skipped and repeated hours the same way as lib/schedule.ts", () => {
    // 02:30 doesn't exist on 29 Mar — lands one hour later (03:30 CEST).
    expect(romeToUtc({ year: 2026, month: 3, day: 29, hour: 2, minute: 30 }).toISOString()).toBe("2026-03-29T01:30:00.000Z");
    // 02:30 happens twice on 25 Oct — the later, standard-time one.
    expect(romeToUtc({ year: 2026, month: 10, day: 25, hour: 2, minute: 30 }).toISOString()).toBe("2026-10-25T01:30:00.000Z");
  });

  it("round-trips through dayKeyOf/romeTime", () => {
    const at = romeToUtc({ year: 2026, month: 10, day: 25, hour: 17, minute: 0 });
    expect(dayKeyOf(at)).toBe("2026-10-25");
    expect(romeTime(at)).toBe("17:00");
  });
});

describe("monthMatrix — Monday first", () => {
  it("is exactly four full weeks for a 28-day February starting on a Monday", () => {
    const weeks = monthMatrix({ year: 2027, month: 2 });
    expect(weeks).toHaveLength(4);
    expect(weeks[0][0]).toEqual({ key: "2027-02-01", day: 1, inMonth: true });
    expect(weeks[3][6]).toEqual({ key: "2027-02-28", day: 28, inMonth: true });
    expect(weeks.flat().every((c) => c.inMonth)).toBe(true);
  });

  it("needs six weeks for a 30-day month starting on a Sunday, padded with the neighbours", () => {
    const weeks = monthMatrix({ year: 2026, month: 11 });
    expect(weeks).toHaveLength(6);
    expect(weeks[0][0]).toEqual({ key: "2026-10-26", day: 26, inMonth: false });
    expect(weeks[0][5]).toEqual({ key: "2026-10-31", day: 31, inMonth: false });
    expect(weeks[0][6]).toEqual({ key: "2026-11-01", day: 1, inMonth: true });
    expect(weeks[5][0]).toEqual({ key: "2026-11-30", day: 30, inMonth: true });
    expect(weeks[5][6]).toEqual({ key: "2026-12-06", day: 6, inMonth: false });
  });

  it("needs six weeks for a 31-day month starting on a Sunday", () => {
    const weeks = monthMatrix({ year: 2026, month: 3 });
    expect(weeks).toHaveLength(6);
    expect(weeks[0][0].key).toBe("2026-02-23");
    expect(weeks[0][6].key).toBe("2026-03-01");
    expect(weeks[5][6].key).toBe("2026-04-05");
  });

  it("starts the September 2026 grid on Monday 31 August and ends it on Sunday 4 October", () => {
    const weeks = monthMatrix({ year: 2026, month: 9 });
    expect(weeks).toHaveLength(5);
    expect(weeks[0].map((c) => c.key)).toEqual([
      "2026-08-31", "2026-09-01", "2026-09-02", "2026-09-03", "2026-09-04", "2026-09-05", "2026-09-06",
    ]);
    expect(weeks[0][0].inMonth).toBe(false);
    expect(weeks[4][6]).toEqual({ key: "2026-10-04", day: 4, inMonth: false });
  });

  it("always yields rows of seven strictly increasing days, with one in-month cell per day of the month", () => {
    const cases: [number, number, number][] = [[2026, 1, 31], [2026, 2, 28], [2026, 6, 30], [2028, 2, 29], [2026, 12, 31]];
    for (const [year, month, days] of cases) {
      const weeks = monthMatrix({ year, month });
      expect(weeks.every((w) => w.length === 7)).toBe(true);
      const keys = weeks.flat().map((c) => c.key);
      for (let i = 1; i < keys.length; i++) expect(keys[i] > keys[i - 1]).toBe(true);
      expect(weeks.flat().filter((c) => c.inMonth)).toHaveLength(days);
    }
  });
});

describe("month keys and labels", () => {
  it("shifts across year boundaries", () => {
    expect(shiftDay("2026-09-30", 1)).toBe("2026-10-01");
    expect(shiftDay("2026-01-01", -1)).toBe("2025-12-31");
    expect(shiftDay("2028-02-28", 1)).toBe("2028-02-29");
    expect(shiftDay("2026-10-25", 1)).toBe("2026-10-26"); // the night clocks go back in Rome
  });

  it("derives a month from a day key", () => {
    expect(monthOf("2026-09-22")).toEqual({ year: 2026, month: 9 });
  });

  it("tells whether an instant falls in a month by its Rome day", () => {
    const september = { year: 2026, month: 9 };
    expect(inMonth("2026-08-31T22:00:00.000Z", september)).toBe(true);  // Tue 1 Sept 00:00 CEST
    expect(inMonth("2026-08-31T21:59:00.000Z", september)).toBe(false); // still Mon 31 Aug in Rome
    expect(inMonth("2026-09-30T21:59:00.000Z", september)).toBe(true);  // Wed 30 Sept 23:59 CEST
    expect(inMonth("2026-09-30T22:00:00.000Z", september)).toBe(false); // Thu 1 Oct 00:00 CEST
    expect(inMonth(new Date("2026-09-15T12:00:00Z"), september)).toBe(true);
  });

  it("labels months and days in English without locale punctuation", () => {
    expect(monthLabel({ year: 2026, month: 9 })).toBe("September 2026");
    expect(monthLabel({ year: 2027, month: 1 })).toBe("January 2027");
    expect(dayLabel("2026-09-22")).toBe("Tuesday 22 September");
    expect(dayLabel("2027-02-01")).toBe("Monday 1 February");
  });
});

describe("gridRangeUtc — the fetch window", () => {
  it("covers the whole September grid, Rome midnight to Rome midnight, half-open", () => {
    const { from, to } = gridRangeUtc({ year: 2026, month: 9 });
    expect(from.toISOString()).toBe("2026-08-30T22:00:00.000Z"); // Mon 31 Aug 00:00 CEST
    expect(to.toISOString()).toBe("2026-10-04T22:00:00.000Z");   // Mon 5 Oct 00:00 CEST
  });

  it("uses the right offset on each side of a DST change inside the grid", () => {
    const october = gridRangeUtc({ year: 2026, month: 10 });
    expect(october.from.toISOString()).toBe("2026-09-27T22:00:00.000Z"); // Mon 28 Sep 00:00 CEST
    expect(october.to.toISOString()).toBe("2026-11-01T23:00:00.000Z");   // Mon 2 Nov 00:00 CET
    const november = gridRangeUtc({ year: 2026, month: 11 });
    expect(november.from.toISOString()).toBe("2026-10-25T23:00:00.000Z"); // Mon 26 Oct 00:00 CET
    expect(november.to.toISOString()).toBe("2026-12-06T23:00:00.000Z");   // Mon 7 Dec 00:00 CET
  });

  it("tiles: one month's `to` is at or after the next month's `from`, never leaving a gap", () => {
    for (let month = 1; month <= 12; month++) {
      const a = gridRangeUtc({ year: 2026, month });
      const b = gridRangeUtc(month === 12 ? { year: 2027, month: 1 } : { year: 2026, month: month + 1 });
      expect(a.to.getTime()).toBeGreaterThanOrEqual(b.from.getTime());
    }
  });
});

describe("groupByDay", () => {
  it("buckets by Rome day and keeps the API's order within a day", () => {
    const late = post({ publishAt: "2026-09-22T21:59:00.000Z" });
    const midnight = post({ publishAt: "2026-09-22T22:00:00.000Z" });
    const morning = post({ publishAt: "2026-09-23T08:00:00.000Z" });
    const byDay = groupByDay([late, midnight, morning]);
    expect(byDay.get("2026-09-22")).toEqual([late]);
    expect(byDay.get("2026-09-23")).toEqual([midnight, morning]);
    expect(byDay.size).toBe(2);
  });

  it("is empty for an empty list", () => {
    expect(groupByDay([]).size).toBe(0);
  });
});

describe("dayDots", () => {
  it("shows up to three dots in time order, hides canceled rows, and counts the overflow", () => {
    const posts = [
      post({ publishAt: "2026-09-23T07:00:00Z", status: "queued" }),
      post({ publishAt: "2026-09-23T08:00:00Z", status: "canceled" }),
      post({ publishAt: "2026-09-23T09:00:00Z", status: "emailed" }),
      post({ publishAt: "2026-09-23T10:00:00Z", status: "posted_manually" }),
      post({ publishAt: "2026-09-23T11:00:00Z", status: "failed" }),
    ];
    expect(dayDots(posts)).toEqual({ dots: ["queued", "emailed", "posted"], overflow: 1 });
  });

  it("maps published to posted and shows nothing for canceled-only days", () => {
    expect(dayDots([post({ publishAt: "2026-09-23T07:00:00Z", status: "published" })])).toEqual({ dots: ["posted"], overflow: 0 });
    expect(dayDots([post({ publishAt: "2026-09-23T07:00:00Z", status: "canceled" })])).toEqual({ dots: [], overflow: 0 });
    expect(dayDots([])).toEqual({ dots: [], overflow: 0 });
  });
});

describe("statusSummary / summaryLabel", () => {
  it("counts posted_manually and published together and omits canceled", () => {
    const posts = [
      ...[1, 2, 3].map(() => post({ publishAt: "2026-09-23T07:00:00Z", status: "queued" })),
      post({ publishAt: "2026-09-23T07:00:00Z", status: "emailed" }),
      ...[1, 2, 3].map(() => post({ publishAt: "2026-09-23T07:00:00Z", status: "posted_manually" })),
      post({ publishAt: "2026-09-23T07:00:00Z", status: "published" }),
      post({ publishAt: "2026-09-23T07:00:00Z", status: "canceled" }),
      post({ publishAt: "2026-09-23T07:00:00Z", status: "canceled" }),
    ];
    const summary = statusSummary(posts);
    expect(summary).toEqual({ scheduled: 0, queued: 3, emailed: 1, posted: 4, failed: 0 });
    expect(summaryLabel(summary)).toBe("3 queued · 1 emailed · 4 posted");
  });

  it("is null when there is nothing but canceled rows (the empty state)", () => {
    expect(summaryLabel(statusSummary([]))).toBeNull();
    expect(summaryLabel(statusSummary([post({ publishAt: "2026-09-23T07:00:00Z", status: "canceled" })]))).toBeNull();
    expect(summaryLabel(statusSummary([post({ publishAt: "2026-09-23T07:00:00Z", status: "failed" })]))).toBe("1 failed");
  });
});

describe("parseSlot", () => {
  it("accepts HH:mm only", () => {
    expect(parseSlot("10:00")).toEqual({ hour: 10, minute: 0 });
    expect(parseSlot("23:59")).toEqual({ hour: 23, minute: 59 });
    for (const bad of ["9:00", "24:00", "10:60", "abc", "", "10:00:00"]) expect(parseSlot(bad)).toBeNull();
  });
});

describe("freeSlots", () => {
  const defaultSlots = { x: ["10:00", "17:00"], linkedin: ["09:00"] };
  const now = "2026-09-22T12:00:00Z";

  it("lists the day's default slots as Rome wall-clock instants, minus the ones a post already takes", () => {
    const taken = post({ platform: "x", publishAt: "2026-09-23T08:00:00.000Z" }); // 10:00 CEST
    const free = freeSlots({ day: "2026-09-23", defaultSlots, posts: [taken], now });
    expect(free).toEqual([
      { kind: "free", platform: "x", at: "2026-09-23T15:00:00.000Z", time: "17:00" },
      { kind: "free", platform: "linkedin", at: "2026-09-23T07:00:00.000Z", time: "09:00" },
    ]);
  });

  it("frees a slot whose only post is canceled, and matches taken slots to the minute", () => {
    const canceled = post({ platform: "x", publishAt: "2026-09-23T08:00:00.000Z", status: "canceled" });
    expect(freeSlots({ day: "2026-09-23", defaultSlots, posts: [canceled], now }).map((s) => s.time)).toEqual(["10:00", "17:00", "09:00"]);
    const offByThirtySeconds = post({ platform: "x", publishAt: "2026-09-23T08:00:30.000Z" });
    expect(freeSlots({ day: "2026-09-23", defaultSlots, posts: [offByThirtySeconds], now }).map((s) => s.time)).toEqual(["17:00", "09:00"]);
  });

  it("is per platform: a LinkedIn post at 09:00 leaves X's 09:00 free", () => {
    const li = post({ platform: "linkedin", publishAt: "2026-09-23T07:00:00.000Z" });
    const free = freeSlots({ day: "2026-09-23", defaultSlots: { x: ["09:00"], linkedin: ["09:00"] }, posts: [li], now });
    expect(free).toEqual([{ kind: "free", platform: "x", at: "2026-09-23T07:00:00.000Z", time: "09:00" }]);
  });

  it("hides slots already in the past (today at 14:00 Rome: only 17:00 is left)", () => {
    expect(freeSlots({ day: "2026-09-22", defaultSlots, posts: [], now }).map((s) => s.time)).toEqual(["17:00"]);
    // A whole day in the past has no free slots at all; a day in the future has all of them.
    expect(freeSlots({ day: "2026-09-21", defaultSlots, posts: [], now })).toEqual([]);
    expect(freeSlots({ day: "2026-09-24", defaultSlots, posts: [], now })).toHaveLength(3);
  });

  it("ignores malformed and duplicate slots and platforms with none", () => {
    const free = freeSlots({ day: "2026-09-23", defaultSlots: { x: ["25:00", "abc", "10:00", "10:00", "9:00"] }, posts: [], now });
    expect(free).toEqual([{ kind: "free", platform: "x", at: "2026-09-23T08:00:00.000Z", time: "10:00" }]);
    expect(freeSlots({ day: "2026-09-23", defaultSlots: {}, posts: [], now })).toEqual([]);
  });

  it("uses the right offset on either side of the spring DST change", () => {
    const slots = { x: ["10:00"] };
    expect(freeSlots({ day: "2026-03-28", defaultSlots: slots, posts: [], now: "2026-03-01T00:00:00Z" })[0].at).toBe("2026-03-28T09:00:00.000Z");
    expect(freeSlots({ day: "2026-03-29", defaultSlots: slots, posts: [], now: "2026-03-01T00:00:00Z" })[0].at).toBe("2026-03-29T08:00:00.000Z");
  });
});

describe("dayRows", () => {
  const now = "2026-09-22T12:00:00Z";

  it("interleaves posts and free slots in time order", () => {
    const noon = post({ platform: "x", publishAt: "2026-09-23T10:00:00.000Z" }); // 12:00 CEST, not a default slot
    const rows = dayRows({ day: "2026-09-23", posts: [noon], defaultSlots: { x: ["10:00", "17:00"], linkedin: ["09:00"] }, now });
    expect(rows.map((r) => (r.kind === "free" ? `free ${r.platform} ${r.time}` : `post ${r.post.platform} ${romeTime(r.post.publishAt)}`))).toEqual([
      "free linkedin 09:00",
      "free x 10:00",
      "post x 12:00",
      "free x 17:00",
    ]);
  });

  it("hides canceled posts — they're the Archive's — and frees their slot again", () => {
    const canceledLi = post({ platform: "linkedin", publishAt: "2026-09-23T08:00:00.000Z", status: "canceled" });
    const rows = dayRows({ day: "2026-09-23", posts: [canceledLi], defaultSlots: { x: ["10:00"], linkedin: ["10:00"] }, now });
    expect(rows.map((r) => `${r.kind} ${r.kind === "free" ? r.platform : r.post.platform}`)).toEqual([
      "free x",        // 10:00 — X's slot is untouched by a LinkedIn post
      "free linkedin", // 10:00 — freed again, since its only post is canceled
    ]);
    // A past day whose only post was canceled shows nothing at all.
    const pastCanceled = post({ publishAt: "2026-09-01T08:00:00.000Z", status: "canceled" });
    expect(dayRows({ day: "2026-09-01", posts: [pastCanceled], defaultSlots: { x: ["10:00"] }, now })).toEqual([]);
  });

  it("keeps every other status; at the same minute a post comes before a free slot, X before LinkedIn", () => {
    const li = post({ platform: "linkedin", publishAt: "2026-09-23T08:00:00.000Z", status: "posted_manually" });
    const x = post({ platform: "x", publishAt: "2026-09-23T15:00:00.000Z", status: "failed" });
    const rows = dayRows({ day: "2026-09-23", posts: [x, li], defaultSlots: { x: ["10:00", "17:00"], linkedin: ["17:00"] }, now });
    expect(rows.map((r) => (r.kind === "free" ? `free ${r.platform} ${r.time}` : `post ${r.post.platform} ${r.post.status}`))).toEqual([
      "post linkedin posted_manually", // 10:00 — before X's free slot at the same minute
      "free x 10:00",
      "post x failed",                 // 17:00 — before LinkedIn's free slot
      "free linkedin 17:00",
    ]);
    const bothAtTen = dayRows({ day: "2026-09-23", posts: [li, post({ platform: "x", publishAt: "2026-09-23T08:00:00.000Z" })], defaultSlots: {}, now });
    expect(bothAtTen.map((r) => (r.kind === "post" ? r.post.platform : r.kind))).toEqual(["x", "linkedin"]);
  });

  it("is empty for a past day with nothing scheduled", () => {
    expect(dayRows({ day: "2026-09-01", posts: [], defaultSlots: { x: ["10:00"] }, now })).toEqual([]);
  });
});

describe("actionsFor", () => {
  it("offers the human-in-the-loop actions per status", () => {
    expect(actionsFor("queued")).toEqual(["cancel"]);
    expect(actionsFor("emailed")).toEqual(["resend", "mark-posted", "cancel"]);
    expect(actionsFor("failed")).toEqual(["retry", "cancel"]);
    expect(actionsFor("posted_manually")).toEqual([]);
    expect(actionsFor("published")).toEqual([]);
    expect(actionsFor("canceled")).toEqual([]);
  });
});


describe("posts scheduled on the platform itself (2026-09-24)", () => {
  const row = (status: "posted_manually" | "queued", publishAt: string) => ({ status, publishAt }) as const;

  it("show as scheduled until their time, then as posted", () => {
    const now = new Date("2026-09-24T12:00:00Z");
    expect(displayStatusOf(row("posted_manually", "2026-09-25T08:00:00Z"), now).status).toBe("scheduled");
    expect(displayStatusOf(row("posted_manually", "2026-09-24T08:00:00Z"), now).status).toBe("posted_manually");
    expect(displayStatusOf(row("queued", "2026-09-25T08:00:00Z"), now).status).toBe("queued");
  });

  it("have their own dot, count in the summary, and can only be removed from Plan", () => {
    expect(dotOf("scheduled")).toBe("scheduled");
    expect(actionsOf("scheduled")).toEqual(["remove"]);
    const summary = summaryOf([{ status: "scheduled" }, { status: "scheduled" }, { status: "posted_manually" }] as never);
    expect(labelOf(summary)).toBe("2 scheduled · 1 posted");
  });
});

describe("posts that are out (2026-09-26)", () => {
  it("are the published and posted ones — a post scheduled on the platform isn't out yet", () => {
    expect(isOutStatus("published")).toBe(true);
    expect(isOutStatus("posted_manually")).toBe(true);
    for (const status of ["scheduled", "queued", "emailed", "failed", "canceled"] as const) expect(isOutStatus(status)).toBe(false);
  });
});
