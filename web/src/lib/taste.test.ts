import { describe, expect, it } from "vitest";
import { createTestDb } from "@/test/db";
import { drafts, ideas, scheduledPosts } from "@/db/schema";
import { kindCountsOf, loadRatedIdeas, loadTasteExamples } from "@/lib/taste";

/** `minutesAgo` before "now", so higher values are older. */
function at(minutesAgo: number): Date {
  return new Date(Date.now() - minutesAgo * 60_000);
}

describe("loadTasteExamples", () => {
  it("returns empty kept/skipped when there are no ideas", async () => {
    const db = await createTestDb();
    expect(await loadTasteExamples(db as never)).toEqual({ kept: [], skipped: [] });
  });

  it("collects content from used ideas as kept, and dismissed ideas as skipped", async () => {
    const db = await createTestDb();
    await db.insert(ideas).values([
      { kind: "note", content: "a kept idea", status: "used", createdAt: at(1) },
      { kind: "note", content: "a skipped idea", status: "dismissed", createdAt: at(1) },
    ]);
    const r = await loadTasteExamples(db as never);
    expect(r.kept).toEqual(["a kept idea"]);
    expect(r.skipped).toEqual(["a skipped idea"]);
  });

  // ♥ keep (M1.5 search-results UX round): status "kept" is a second,
  // equally positive taste signal alongside "used" — both feed the same
  // `kept` bucket Jev receives (see lib/scout-run.ts's judgePosts call).
  it("also collects content from 'kept' (♥) ideas as kept, interleaved with 'used' ones by recency", async () => {
    const db = await createTestDb();
    await db.insert(ideas).values([
      { kind: "note", content: "used one", status: "used", createdAt: at(3) },
      { kind: "note", content: "hearted one", status: "kept", createdAt: at(2) },
      { kind: "note", content: "used two", status: "used", createdAt: at(1) },
    ]);
    const r = await loadTasteExamples(db as never);
    expect(r.kept).toEqual(["used two", "hearted one", "used one"]);
  });

  it("ignores ideas that are still new or archived (neither kept nor skipped)", async () => {
    const db = await createTestDb();
    await db.insert(ideas).values([
      { kind: "note", content: "archived one", status: "archived", createdAt: at(1) },
      { kind: "note", content: "new one", status: "new", createdAt: at(1) },
    ]);
    const r = await loadTasteExamples(db as never);
    expect(r.kept).toEqual([]);
    expect(r.skipped).toEqual([]);
  });

  it("ignores youtube-kind ideas even when used/dismissed (video titles aren't taste signals)", async () => {
    const db = await createTestDb();
    await db.insert(ideas).values([
      { kind: "youtube", content: "a video title", status: "used", createdAt: at(1) },
      { kind: "note", content: "a real kept note", status: "used", createdAt: at(2) },
    ]);
    const r = await loadTasteExamples(db as never);
    expect(r.kept).toEqual(["a real kept note"]);
  });

  it("ignores ideas with null content", async () => {
    const db = await createTestDb();
    await db.insert(ideas).values([
      { kind: "x_post", content: null, status: "used", createdAt: at(1) },
      { kind: "note", content: "has content", status: "used", createdAt: at(2) },
    ]);
    const r = await loadTasteExamples(db as never);
    expect(r.kept).toEqual(["has content"]);
  });

  it("orders most-recent-first and caps at 15", async () => {
    const db = await createTestDb();
    // idea 0 is oldest (17 min ago), idea 16 is most recent (1 min ago).
    await db.insert(ideas).values(
      Array.from({ length: 17 }, (_, i) => ({
        kind: "note" as const,
        content: `kept ${i}`,
        status: "used" as const,
        createdAt: at(17 - i),
      })),
    );
    const r = await loadTasteExamples(db as never);
    expect(r.kept).toHaveLength(15);
    expect(r.kept[0]).toBe("kept 16");
    expect(r.kept[14]).toBe("kept 2");
  });

  it("trims content to 400 characters", async () => {
    const db = await createTestDb();
    const longContent = "x".repeat(500);
    await db.insert(ideas).values([{ kind: "note", content: longContent, status: "used", createdAt: at(1) }]);
    const r = await loadTasteExamples(db as never);
    expect(r.kept[0]).toHaveLength(400);
    expect(r.kept[0]).toBe("x".repeat(400));
  });
});

describe("votes in Plan (2026-09-26)", () => {
  type Db = Awaited<ReturnType<typeof createTestDb>>;
  /** An idea whose posts got these votes, the vote `votedMinutesAgo` ago. */
  async function ratedIdea(db: Db, content: string, outcomes: Array<"good" | "bad">, votedMinutesAgo: number, over: Partial<typeof ideas.$inferInsert> = {}) {
    const [idea] = await db.insert(ideas).values({ kind: "devto", content, status: "used", createdAt: at(500), ...over }).returning();
    for (const [i, outcome] of outcomes.entries()) {
      const [draft] = await db.insert(drafts).values({ ideaId: idea.id, xText: `${content} ${i}`, status: "used" }).returning();
      await db.insert(scheduledPosts).values({
        draftId: draft.id, platform: i % 2 === 0 ? "x" : "linkedin", text: `${content} ${i}`, status: "posted_manually",
        postedBy: "manual", publishAt: at(1000), publishedAt: at(1000), outcome, ratedAt: at(votedMinutesAgo),
      });
    }
    return idea;
  }

  it("a 👍 idea leads the kept examples and a 👎 one the skipped ones, before ♥, Use and Skip", async () => {
    const db = await createTestDb();
    await db.insert(ideas).values([
      { kind: "note", content: "used recently", status: "used", createdAt: at(1) },
      { kind: "note", content: "dismissed recently", status: "dismissed", createdAt: at(1) },
    ]);
    await ratedIdea(db, "did well", ["good"], 10);
    await ratedIdea(db, "didn't land", ["bad"], 20);
    const r = await loadTasteExamples(db as never);
    expect(r.kept).toEqual(["did well", "used recently"]);
    expect(r.skipped).toEqual(["didn't land", "dismissed recently"]);
  });

  it("good on one platform and bad on the other counts as good; the newest vote comes first", async () => {
    const db = await createTestDb();
    await ratedIdea(db, "older win", ["good"], 60);
    await ratedIdea(db, "split", ["good", "bad"], 5);
    const rated = await loadRatedIdeas(db as never);
    expect(rated.map((r) => [r.content, r.outcome])).toEqual([["split", "good"], ["older win", "good"]]);
    expect((await loadTasteExamples(db as never)).skipped).toEqual([]);
  });

  it("leaves YouTube ideas out of the votes too", async () => {
    const db = await createTestDb();
    await ratedIdea(db, "a video title", ["good"], 5, { kind: "youtube" });
    expect(await loadRatedIdeas(db as never)).toEqual([]);
  });

  it("counts the votes per kind, over ideas whose kind is one of the five", async () => {
    const db = await createTestDb();
    await ratedIdea(db, "s", ["good"], 5, { meta: { postKind: "story" } });
    await ratedIdea(db, "o", ["bad"], 6, { meta: { postKind: "opinion" } });
    await ratedIdea(db, "x", ["good"], 7, { meta: { postKind: "other" } });
    await ratedIdea(db, "none", ["good"], 8);
    const counts = kindCountsOf(await loadRatedIdeas(db as never));
    expect(counts.story).toEqual({ good: 1, bad: 0 });
    expect(counts.opinion).toEqual({ good: 0, bad: 1 });
    expect(counts.problem).toEqual({ good: 0, bad: 0 });
  });
});
