/**
 * Proposed times for Schedule's Ready to schedule list (schedule in a row, 2026-10-10) — pure, no
 * React, no fetch, unit-tested in schedule-queue.test.ts, safe in a client bundle. The owner's posting
 * times (Settings `defaultSlots`) are Europe/Rome wall-clock times, read with plan-calendar.ts's Rome
 * wall clock (the client-safe twin of lib/schedule.ts's, proven across both DST changes) and the same
 * "taken" rule as lib/schedule.ts's suggestSlots: a non-canceled post on that platform at that minute.
 */
import { dayKeyOf, parseDayKey, parseSlot, romeToUtc, romeWallClock, shiftDay } from "@/components/plan/plan-calendar";

export type QueuePlatform = "x" | "linkedin";
export type QueuePost = { id: string; platforms: QueuePlatform[] };
/** A post already scheduled; a canceled one takes no slot. */
export type TakenSlot = { platform: QueuePlatform; publishAt: string; status?: string };

const MS_PER_MINUTE = 60_000;
/** How far ahead the posting times are searched. */
const DEFAULT_DAYS = 28;

const minuteKey = (instant: Date | string) => Math.floor(new Date(instant).getTime() / MS_PER_MINUTE);

/**
 * Every instant after `now`, soonest first, within `days` Rome days, at which one of the posting times of
 * `platforms` falls — or, when none of them has a posting time, every full hour.
 */
function candidates(platforms: QueuePlatform[], postingTimes: Record<string, string[]>, now: Date, days: number): Date[] {
  const times = new Map<string, { hour: number; minute: number }>();
  for (const platform of platforms) {
    for (const slot of postingTimes[platform] ?? []) {
      const parsed = parseSlot(slot);
      if (parsed) times.set(slot, parsed);
    }
  }
  const out: Date[] = [];
  const today = dayKeyOf(now);
  if (times.size === 0) {
    const wall = romeWallClock(now);
    for (let d = 0; d < days; d++) {
      const date = parseDayKey(shiftDay(today, d));
      for (let hour = d === 0 ? wall.hour : 0; hour < 24; hour++) out.push(romeToUtc({ ...date, hour, minute: 0 }));
    }
  } else {
    for (let d = 0; d < days; d++) {
      const date = parseDayKey(shiftDay(today, d));
      for (const time of times.values()) out.push(romeToUtc({ ...date, ...time }));
    }
  }
  return out.filter((at) => at.getTime() > now.getTime()).sort((a, b) => a.getTime() - b.getTime());
}

/**
 * Each ready post's proposed time (UTC ISO), in the order the posts come (the order they were made
 * ready): the first posting time from `now` on, of any of its platforms, that isn't taken on any of
 * them by a scheduled post and that no earlier ready post got — one post per slot. Null when nothing
 * is free within `days`. A time the owner changed (`overrides`) stays put and takes no slot from the
 * others, so changing one time moves no other post.
 */
export function proposeTimes(
  { posts, postingTimes, taken, now, overrides = {}, days = DEFAULT_DAYS }:
  {
    posts: QueuePost[];
    postingTimes: Record<string, string[]>;
    taken: TakenSlot[];
    now: Date | string;
    overrides?: Record<string, string>;
    days?: number;
  },
): Record<string, string | null> {
  const from = new Date(now);
  const takenOn = new Map<QueuePlatform, Set<number>>();
  for (const slot of taken) {
    if (slot.status === "canceled") continue;
    const set = takenOn.get(slot.platform) ?? new Set<number>();
    set.add(minuteKey(slot.publishAt));
    takenOn.set(slot.platform, set);
  }
  const given = new Set<number>();
  const out: Record<string, string | null> = {};
  for (const post of posts) {
    const free = candidates(post.platforms, postingTimes, from, days).find((at) => {
      const key = minuteKey(at);
      return !given.has(key) && post.platforms.every((platform) => !takenOn.get(platform)?.has(key));
    });
    if (free) given.add(minuteKey(free));
    out[post.id] = overrides[post.id] ?? free?.toISOString() ?? null;
  }
  return out;
}

/** The posts in the order of their times, soonest first: same time keeps their order, no time goes last. */
export function queueOrder<T extends { id: string }>(posts: T[], times: Record<string, string | null>): T[] {
  const at = (post: T) => {
    const time = times[post.id];
    return time ? new Date(time).getTime() : Number.POSITIVE_INFINITY;
  };
  return posts.map((post, index) => ({ post, index })).sort((a, b) => at(a.post) - at(b.post) || a.index - b.index).map(({ post }) => post);
}
