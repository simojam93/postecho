import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb } from "@/test/db";
import { drafts, ideas, kv, scheduledPosts } from "@/db/schema";
import { listArchivedPosts, listPostsInProgress } from "@/lib/drafts";
import { listToRate } from "@/lib/schedule";
import { DEMO_IDS, seedDemo } from "@/lib/demo-seed";

const now = new Date("2026-09-28T07:00:00Z");

describe("the sample data (npm run demo)", () => {
  it("fills every screen: Trends, a video's 12 posts, posts in Write, the week in Calendar, the archive", async () => {
    const db = await createTestDb();
    await seedDemo(db as never, now);
    const all = await db.select().from(ideas);

    const trends = all.filter((i) => i.source === "scout");
    expect(trends.length).toBeGreaterThanOrEqual(9);
    expect(trends.every((i) => i.status === "new" && typeof i.meta.rank === "number" && i.meta.topic === "design systems")).toBe(true);

    const videoPosts = all.filter((i) => i.kind === "video_idea");
    expect(videoPosts).toHaveLength(12);
    expect(videoPosts.every((i) => i.meta.format === "post" && i.meta.videoId === DEMO_IDS.video && !i.title && (i.content ?? "").length <= 280)).toBe(true);

    const takes = await db.select().from(drafts).where(eq(drafts.ideaId, DEMO_IDS.takesIdea));
    expect(takes.filter((d) => d.status === "candidate")).toHaveLength(3);
    expect(takes.every((d) => typeof (d.meta.slop as { slopScore?: unknown } | undefined)?.slopScore === "number")).toBe(true);

    const inProgress = (await listPostsInProgress(db as never)).map((p) => p.ideaId);
    expect(inProgress).toEqual(expect.arrayContaining([DEMO_IDS.takesIdea, DEMO_IDS.chosenIdea]));

    const week = await db.select().from(scheduledPosts);
    expect(week.filter((row) => row.publishAt > now).length).toBeGreaterThanOrEqual(3);
    expect((await listToRate(db as never, now)).length).toBeGreaterThanOrEqual(1);
    expect((await listArchivedPosts(db as never)).length).toBeGreaterThanOrEqual(3);

    const settings = Object.fromEntries((await db.select().from(kv)).map((row) => [row.key, row.value]));
    expect(settings.identityName).toBe("Sam Rivera");
    expect(settings.onboardedAt).toBeTruthy();
    expect(settings.seenHints).toEqual(["sources", "settings", "videos"]);
  });

  it("is invented: links on example.com or a made-up video, no real address", async () => {
    const db = await createTestDb();
    await seedDemo(db as never, now);
    const rows = await db.select().from(ideas);
    for (const row of rows) if (row.url) expect(row.url).toMatch(/^https:\/\/(example\.com\/|www\.youtube\.com\/watch\?v=demo-)/);
    expect(JSON.stringify(rows)).not.toMatch(/@forte|simone|lovera/i);
  });

  it("can run twice: the second time adds nothing", async () => {
    const db = await createTestDb();
    await seedDemo(db as never, now);
    const counts = async () => [(await db.select().from(ideas)).length, (await db.select().from(drafts)).length, (await db.select().from(scheduledPosts)).length];
    const before = await counts();
    await seedDemo(db as never, now);
    expect(await counts()).toEqual(before);
  });
});
