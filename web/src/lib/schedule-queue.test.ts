import { describe, expect, it } from "vitest";
import { proposeTimes, queueOrder } from "./schedule-queue";

// Monday 12 October 2026, 10:00 in Rome (CEST, UTC+2).
const NOW = "2026-10-12T08:00:00.000Z";
const TIMES = { x: ["09:00", "17:00"], linkedin: ["09:00"] };
const MON_17 = "2026-10-12T15:00:00.000Z";
const TUE_09 = "2026-10-13T07:00:00.000Z";
const TUE_17 = "2026-10-13T15:00:00.000Z";
const WED_09 = "2026-10-14T07:00:00.000Z";

describe("proposed times for the ready posts (schedule in a row, 2026-10-10)", () => {
  it("the first free posting times from now on, one post per slot, in the order they were made ready", () => {
    const times = proposeTimes({
      posts: [{ id: "a", platforms: ["x"] }, { id: "b", platforms: ["x"] }, { id: "c", platforms: ["x"] }],
      postingTimes: TIMES, taken: [], now: NOW,
    });
    // Monday 09:00 has passed.
    expect(times).toEqual({ a: MON_17, b: TUE_09, c: TUE_17 });
  });

  it("skips a slot taken by a post already scheduled at that time on that platform, not on the other one", () => {
    const times = proposeTimes({
      posts: [{ id: "a", platforms: ["x"] }, { id: "b", platforms: ["linkedin"] }],
      postingTimes: TIMES,
      taken: [
        { platform: "x", publishAt: MON_17 },
        { platform: "linkedin", publishAt: TUE_09 },
      ],
      now: NOW,
    });
    // a: Tuesday 09:00 is taken on LinkedIn only, so free for X. b: LinkedIn's Tuesday 09:00 is taken twice over.
    expect(times).toEqual({ a: TUE_09, b: WED_09 });
  });

  it("a canceled post takes no slot", () => {
    const times = proposeTimes({
      posts: [{ id: "a", platforms: ["x"] }],
      postingTimes: TIMES, taken: [{ platform: "x", publishAt: MON_17, status: "canceled" }], now: NOW,
    });
    expect(times).toEqual({ a: MON_17 });
  });

  it("a post on both platforms gets a slot free on both, and another ready post takes a slot whatever its platform", () => {
    const times = proposeTimes({
      posts: [{ id: "a", platforms: ["linkedin"] }, { id: "b", platforms: ["x", "linkedin"] }, { id: "c", platforms: ["x"] }],
      postingTimes: TIMES, taken: [{ platform: "linkedin", publishAt: MON_17 }], now: NOW,
    });
    // a: LinkedIn's first 09:00. b: Monday 17:00 is taken on LinkedIn, Tuesday 09:00 by a. c: Monday 17:00 is free on X.
    expect(times).toEqual({ a: TUE_09, b: TUE_17, c: MON_17 });
  });

  it("a changed time stays put and moves no other post", () => {
    const posts = [{ id: "a", platforms: ["x" as const] }, { id: "b", platforms: ["x" as const] }, { id: "c", platforms: ["x" as const] }];
    const changed = proposeTimes({ posts, postingTimes: TIMES, taken: [], now: NOW, overrides: { b: MON_17 } });
    expect(changed).toEqual({ a: MON_17, b: MON_17, c: TUE_17 });
  });

  it("with no posting times set, the next full hours", () => {
    const times = proposeTimes({
      posts: [{ id: "a", platforms: ["x"] }, { id: "b", platforms: ["linkedin"] }],
      postingTimes: {}, taken: [{ platform: "x", publishAt: "2026-10-12T09:00:00.000Z" }], now: "2026-10-12T08:20:00.000Z",
    });
    expect(times).toEqual({ a: "2026-10-12T10:00:00.000Z", b: "2026-10-12T09:00:00.000Z" });
  });

  it("the rows follow their times: changing one reorders the list", () => {
    const posts = [{ id: "a" }, { id: "b" }, { id: "c" }];
    expect(queueOrder(posts, { a: TUE_17, b: MON_17, c: TUE_09 }).map((p) => p.id)).toEqual(["b", "c", "a"]);
    // Same time: the order they were made ready. No time yet: last.
    expect(queueOrder(posts, { a: MON_17, b: null, c: MON_17 }).map((p) => p.id)).toEqual(["a", "c", "b"]);
  });
});
