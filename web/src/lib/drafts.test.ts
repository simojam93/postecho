import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb } from "@/test/db";
import { drafts, ideas, jobs, scheduledPosts } from "@/db/schema";
import { discardIdeaDrafts, listArchivedPosts, listDrafts, listPostsInProgress } from "@/lib/drafts";

describe("listDrafts", () => {
  it("returns drafts newest first", async () => {
    const db = await createTestDb();
    await db.insert(drafts).values({ xText: "first", createdAt: new Date("2020-01-01T00:00:00Z") });
    await db.insert(drafts).values({ xText: "second", createdAt: new Date("2020-01-02T00:00:00Z") });
    const rows = await listDrafts(db as never, {});
    expect(rows.map((d) => d.xText)).toEqual(["second", "first"]);
  });

  it("filters by ideaId", async () => {
    const db = await createTestDb();
    const [ideaA] = await db.insert(ideas).values({ kind: "note", content: "a" }).returning();
    const [ideaB] = await db.insert(ideas).values({ kind: "note", content: "b" }).returning();
    await db.insert(drafts).values({ ideaId: ideaA.id, xText: "for a" });
    await db.insert(drafts).values({ ideaId: ideaB.id, xText: "for b" });
    const rows = await listDrafts(db as never, { ideaId: ideaA.id });
    expect(rows).toHaveLength(1);
    expect(rows[0].xText).toBe("for a");
  });

  it("filters by status", async () => {
    const db = await createTestDb();
    await db.insert(drafts).values({ xText: "candidate one", status: "candidate" });
    await db.insert(drafts).values({ xText: "kept one", status: "kept" });
    const rows = await listDrafts(db as never, { status: "kept" });
    expect(rows).toHaveLength(1);
    expect(rows[0].xText).toBe("kept one");
  });

  it("combines ideaId and status filters", async () => {
    const db = await createTestDb();
    const [idea] = await db.insert(ideas).values({ kind: "note", content: "a" }).returning();
    await db.insert(drafts).values({ ideaId: idea.id, xText: "candidate for idea", status: "candidate" });
    await db.insert(drafts).values({ ideaId: idea.id, xText: "kept for idea", status: "kept" });
    await db.insert(drafts).values({ xText: "kept, no idea", status: "kept" });
    const rows = await listDrafts(db as never, { ideaId: idea.id, status: "kept" });
    expect(rows).toHaveLength(1);
    expect(rows[0].xText).toBe("kept for idea");
  });

  it("respects limit", async () => {
    const db = await createTestDb();
    for (let i = 0; i < 5; i++) await db.insert(drafts).values({ xText: `d${i}` });
    const rows = await listDrafts(db as never, { limit: 2 });
    expect(rows).toHaveLength(2);
  });

  it("defaults to a bounded limit when none is given", async () => {
    const db = await createTestDb();
    for (let i = 0; i < 3; i++) await db.insert(drafts).values({ xText: `d${i}` });
    const rows = await listDrafts(db as never, {});
    expect(rows).toHaveLength(3);
  });

  it("joins the idea summary when the draft has an ideaId", async () => {
    const db = await createTestDb();
    const [idea] = await db.insert(ideas)
      .values({ kind: "youtube", url: "https://youtu.be/x", title: "A talk" })
      .returning();
    await db.insert(drafts).values({ ideaId: idea.id, xText: "hi" });
    const rows = await listDrafts(db as never, {});
    expect(rows[0].idea).toMatchObject({ id: idea.id, title: "A talk", url: "https://youtu.be/x", kind: "youtube" });
  });

  it("leaves idea null when the draft has no ideaId", async () => {
    const db = await createTestDb();
    await db.insert(drafts).values({ xText: "orphan" });
    const rows = await listDrafts(db as never, {});
    expect(rows[0].idea).toBeNull();
  });

  it("surfaces the latest generate_from_video/generate_from_idea job status for the draft's idea", async () => {
    const db = await createTestDb();
    const [idea] = await db.insert(ideas).values({ kind: "note", content: "seed" }).returning();
    await db.insert(jobs).values({
      kind: "generate_from_idea", payload: { ideaId: idea.id }, status: "queued",
      createdAt: new Date("2020-01-01T00:00:00Z"),
    });
    await db.insert(jobs).values({
      kind: "generate_from_idea", payload: { ideaId: idea.id }, status: "done",
      createdAt: new Date("2020-01-02T00:00:00Z"),
    });
    await db.insert(drafts).values({ ideaId: idea.id, xText: "hi" });
    const rows = await listDrafts(db as never, {});
    expect(rows[0].latestJobStatus).toBe("done");
  });

  it("ignores revise_draft/image_prompt jobs (they key by draftId, not ideaId) when computing latestJobStatus", async () => {
    const db = await createTestDb();
    const [idea] = await db.insert(ideas).values({ kind: "note", content: "seed" }).returning();
    const [draft] = await db.insert(drafts).values({ ideaId: idea.id, xText: "hi" }).returning();
    await db.insert(jobs).values({
      kind: "generate_from_idea", payload: { ideaId: idea.id }, status: "done",
      createdAt: new Date("2020-01-01T00:00:00Z"),
    });
    await db.insert(jobs).values({
      kind: "revise_draft", payload: { draftId: draft.id }, status: "queued",
      createdAt: new Date("2020-01-02T00:00:00Z"),
    });
    const rows = await listDrafts(db as never, {});
    expect(rows[0].latestJobStatus).toBe("done");
  });

  it("reports null latestJobStatus when there is no generation job for the idea", async () => {
    const db = await createTestDb();
    const [idea] = await db.insert(ideas).values({ kind: "note", content: "seed" }).returning();
    await db.insert(drafts).values({ ideaId: idea.id, xText: "hi" });
    const rows = await listDrafts(db as never, {});
    expect(rows[0].latestJobStatus).toBeNull();
  });

  it("reports null latestJobStatus for a draft with no ideaId", async () => {
    const db = await createTestDb();
    await db.insert(drafts).values({ xText: "orphan" });
    const rows = await listDrafts(db as never, {});
    expect(rows[0].latestJobStatus).toBeNull();
  });
});

describe("listPostsInProgress", () => {
  it("returns one entry per idea that has kept or candidate drafts, with its take count and idea summary", async () => {
    const db = await createTestDb();
    const [ideaA] = await db.insert(ideas).values({ kind: "x_post", url: "https://x.com/a/status/1", title: "A" }).returning();
    const [ideaB] = await db.insert(ideas).values({ kind: "youtube", url: "https://youtu.be/b", title: "B talk" }).returning();
    await db.insert(drafts).values([
      { ideaId: ideaA.id, xText: "a1", status: "candidate" },
      { ideaId: ideaA.id, xText: "a2", status: "kept" },
      { ideaId: ideaB.id, xText: "b1", status: "candidate" },
    ]);

    const posts = await listPostsInProgress(db as never);
    expect(posts).toHaveLength(2);
    const a = posts.find((p) => p.ideaId === ideaA.id)!;
    expect(a.takeCount).toBe(2);
    expect(a.idea).toEqual({ id: ideaA.id, title: "A", url: "https://x.com/a/status/1", kind: "x_post" });
    const b = posts.find((p) => p.ideaId === ideaB.id)!;
    expect(b.takeCount).toBe(1);
    expect(b.idea).toMatchObject({ kind: "youtube", title: "B talk" });
  });

  it("ignores discarded and used drafts and leaves out ideas with nothing in progress", async () => {
    const db = await createTestDb();
    const [live] = await db.insert(ideas).values({ kind: "note", content: "live" }).returning();
    const [done] = await db.insert(ideas).values({ kind: "note", content: "done" }).returning();
    await db.insert(drafts).values([
      { ideaId: live.id, xText: "take", status: "candidate" },
      { ideaId: live.id, xText: "binned", status: "discarded" },
      { ideaId: done.id, xText: "published", status: "used" },
      { ideaId: done.id, xText: "binned too", status: "discarded" },
    ]);

    const posts = await listPostsInProgress(db as never);
    expect(posts.map((p) => p.ideaId)).toEqual([live.id]);
    expect(posts[0].takeCount).toBe(1);
  });

  it("orders posts most recently touched first (by their newest kept/candidate draft's updatedAt)", async () => {
    const db = await createTestDb();
    const [older] = await db.insert(ideas).values({ kind: "note", content: "older" }).returning();
    const [newer] = await db.insert(ideas).values({ kind: "note", content: "newer" }).returning();
    const [stale] = await db.insert(ideas).values({ kind: "note", content: "stale" }).returning();
    await db.insert(drafts).values([
      { ideaId: older.id, xText: "o", createdAt: new Date("2020-01-01T00:00:00Z"), updatedAt: new Date("2020-01-05T00:00:00Z") },
      { ideaId: newer.id, xText: "n", createdAt: new Date("2020-01-02T00:00:00Z"), updatedAt: new Date("2020-01-06T00:00:00Z") },
      // The newest row by creation, but never touched since — an edit or a
      // pick on another post outranks it.
      { ideaId: stale.id, xText: "s", createdAt: new Date("2020-01-03T00:00:00Z"), updatedAt: new Date("2020-01-03T00:00:00Z") },
    ]);

    const posts = await listPostsInProgress(db as never);
    expect(posts.map((p) => p.ideaId)).toEqual([newer.id, older.id, stale.id]);
  });

  it("reports the kept draft as chosen, or null when only candidates exist", async () => {
    const db = await createTestDb();
    const [picked] = await db.insert(ideas).values({ kind: "note", content: "picked" }).returning();
    const [unpicked] = await db.insert(ideas).values({ kind: "note", content: "unpicked" }).returning();
    await db.insert(drafts).values({ ideaId: picked.id, xText: "c", status: "candidate" });
    const [kept] = await db.insert(drafts).values({ ideaId: picked.id, xText: "k", status: "kept" }).returning();
    await db.insert(drafts).values({ ideaId: unpicked.id, xText: "c2", status: "candidate" });

    const posts = await listPostsInProgress(db as never);
    expect(posts.find((p) => p.ideaId === picked.id)?.chosenDraftId).toBe(kept.id);
    expect(posts.find((p) => p.ideaId === unpicked.id)?.chosenDraftId).toBeNull();
  });

  it("treats the most recently updated kept draft as chosen when more than one is kept", async () => {
    // Two kept drafts only exist mid-pick: the Write page keeps the new take
    // before demoting the previous one (see components/write). The most
    // recently picked — not the most recently created — wins.
    const db = await createTestDb();
    const [idea] = await db.insert(ideas).values({ kind: "note", content: "seed" }).returning();
    await db.insert(drafts).values({
      ideaId: idea.id, xText: "picked first", status: "kept",
      createdAt: new Date("2020-01-02T00:00:00Z"), updatedAt: new Date("2020-01-02T00:00:00Z"),
    });
    const [pickedLast] = await db.insert(drafts).values({
      ideaId: idea.id, xText: "picked last", status: "kept",
      createdAt: new Date("2020-01-01T00:00:00Z"), updatedAt: new Date("2020-01-03T00:00:00Z"),
    }).returning();

    const posts = await listPostsInProgress(db as never);
    expect(posts).toHaveLength(1);
    expect(posts[0].chosenDraftId).toBe(pickedLast.id);
    expect(posts[0].takeCount).toBe(2);
  });

  it("surfaces the latest generation job status for each idea", async () => {
    const db = await createTestDb();
    const [writing] = await db.insert(ideas).values({ kind: "note", content: "writing" }).returning();
    const [idle] = await db.insert(ideas).values({ kind: "note", content: "idle" }).returning();
    await db.insert(jobs).values({
      kind: "generate_from_idea", payload: { ideaId: writing.id }, status: "done",
      createdAt: new Date("2020-01-01T00:00:00Z"),
    });
    await db.insert(jobs).values({
      kind: "generate_from_idea", payload: { ideaId: writing.id }, status: "queued",
      createdAt: new Date("2020-01-02T00:00:00Z"),
    });
    await db.insert(drafts).values([
      { ideaId: writing.id, xText: "w", status: "candidate" },
      { ideaId: idle.id, xText: "i", status: "candidate" },
    ]);

    const posts = await listPostsInProgress(db as never);
    expect(posts.find((p) => p.ideaId === writing.id)?.latestJobStatus).toBe("queued");
    expect(posts.find((p) => p.ideaId === idle.id)?.latestJobStatus).toBeNull();
  });

  it("groups drafts with no idea under a single ideaId-null entry", async () => {
    const db = await createTestDb();
    const [idea] = await db.insert(ideas).values({ kind: "note", content: "seed" }).returning();
    await db.insert(drafts).values({ xText: "orphan 1", status: "candidate" });
    const [orphanKept] = await db.insert(drafts).values({ xText: "orphan 2", status: "kept" }).returning();
    await db.insert(drafts).values({ ideaId: idea.id, xText: "with idea", status: "candidate" });

    const posts = await listPostsInProgress(db as never);
    expect(posts).toHaveLength(2);
    const other = posts.find((p) => p.ideaId === null)!;
    expect(other).toEqual({ ideaId: null, idea: null, chosenDraftId: orphanKept.id, takeCount: 2, latestJobStatus: null });
  });

  it("returns an empty list when nothing is in progress", async () => {
    const db = await createTestDb();
    await db.insert(drafts).values({ xText: "gone", status: "discarded" });
    expect(await listPostsInProgress(db as never)).toEqual([]);
  });
});

describe("discardIdeaDrafts", () => {
  it("discards the idea's kept and candidate drafts and returns how many", async () => {
    const db = await createTestDb();
    const [idea] = await db.insert(ideas).values({ kind: "note", content: "seed" }).returning();
    await db.insert(drafts).values([
      { ideaId: idea.id, xText: "take 1", status: "candidate" },
      { ideaId: idea.id, xText: "take 2", status: "kept" },
      { ideaId: idea.id, xText: "take 3", status: "candidate" },
    ]);

    expect(await discardIdeaDrafts(db as never, idea.id)).toBe(3);

    const rows = await db.select().from(drafts).where(eq(drafts.ideaId, idea.id));
    expect(rows.map((d) => d.status)).toEqual(["discarded", "discarded", "discarded"]);
    expect(await listPostsInProgress(db as never)).toEqual([]);
  });

  it("leaves used and already-discarded drafts alone, and the idea itself", async () => {
    const db = await createTestDb();
    const [idea] = await db.insert(ideas).values({ kind: "note", content: "seed", status: "used" }).returning();
    await db.insert(drafts).values([
      { ideaId: idea.id, xText: "live", status: "kept" },
      { ideaId: idea.id, xText: "published", status: "used" },
      { ideaId: idea.id, xText: "binned", status: "discarded" },
    ]);

    expect(await discardIdeaDrafts(db as never, idea.id)).toBe(1);

    const rows = await db.select().from(drafts).where(eq(drafts.ideaId, idea.id));
    expect(Object.fromEntries(rows.map((d) => [d.xText, d.status]))).toEqual({
      live: "discarded", published: "used", binned: "discarded",
    });
    // The idea is not touched — it stays where it was (on Liked).
    const [unchanged] = await db.select().from(ideas).where(eq(ideas.id, idea.id));
    expect(unchanged.status).toBe("used");
  });

  it("does not touch other ideas' drafts, nor drafts with no idea", async () => {
    const db = await createTestDb();
    const [removed] = await db.insert(ideas).values({ kind: "note", content: "removed" }).returning();
    const [other] = await db.insert(ideas).values({ kind: "note", content: "other" }).returning();
    await db.insert(drafts).values([
      { ideaId: removed.id, xText: "r", status: "candidate" },
      { ideaId: other.id, xText: "o1", status: "candidate" },
      { ideaId: other.id, xText: "o2", status: "kept" },
      { xText: "orphan", status: "candidate" },
    ]);

    expect(await discardIdeaDrafts(db as never, removed.id)).toBe(1);

    const posts = await listPostsInProgress(db as never);
    expect(posts.some((p) => p.ideaId === removed.id)).toBe(false);
    expect(posts.find((p) => p.ideaId === other.id)?.takeCount).toBe(2);
    expect(posts.find((p) => p.ideaId === null)?.takeCount).toBe(1);
  });

  it("returns 0 for an idea with nothing in progress, or one that doesn't exist", async () => {
    const db = await createTestDb();
    const [idle] = await db.insert(ideas).values({ kind: "note", content: "idle" }).returning();
    await db.insert(drafts).values({ ideaId: idle.id, xText: "published", status: "used" });

    expect(await discardIdeaDrafts(db as never, idle.id)).toBe(0);
    expect(await discardIdeaDrafts(db as never, "00000000-0000-0000-0000-000000000000")).toBe(0);
  });
});

describe("Write's Archive (2026-09-27: \"una volta che scheduli un post… vanno in un archivio\")", () => {
  it("a post scheduled or posted leaves the strip, whatever takes it has left, and is in the archive with where and when", async () => {
    const db = await createTestDb();
    const [done] = await db.insert(ideas).values({ kind: "note", content: "done", title: "Done post" }).returning();
    const [open] = await db.insert(ideas).values({ kind: "note", content: "open" }).returning();
    const [used] = await db.insert(drafts).values({ ideaId: done.id, xText: "the scheduled X", status: "used" }).returning();
    await db.insert(drafts).values([
      { ideaId: done.id, xText: "a take left over", status: "candidate" },
      { ideaId: open.id, xText: "still drafting", status: "kept" },
    ]);
    await db.insert(scheduledPosts).values([
      { draftId: used.id, platform: "linkedin", text: "l", publishAt: new Date("2026-09-30T08:00:00Z"), status: "posted_manually" },
      { draftId: used.id, platform: "x", text: "the scheduled X", publishAt: new Date("2026-09-29T15:30:00Z"), status: "posted_manually" },
      { draftId: used.id, platform: "x", text: "old", publishAt: new Date("2026-09-20T10:00:00Z"), status: "canceled" },
    ]);

    expect((await listPostsInProgress(db as never)).map((p) => p.ideaId)).toEqual([open.id]);

    const archive = await listArchivedPosts(db as never);
    expect(archive).toHaveLength(1);
    expect(archive[0]).toMatchObject({ draftId: used.id, ideaId: done.id, xText: "the scheduled X", idea: { title: "Done post" } });
    expect(archive[0]!.schedules.map((row) => row.platform)).toEqual(["x", "linkedin"]);
  });

  it("leaves out a post whose every schedule was canceled, or that never had one (2026-09-27: \"togli questa dall'archivio\")", async () => {
    const db = await createTestDb();
    const [idea] = await db.insert(ideas).values({ kind: "note", content: "gone" }).returning();
    const [canceled] = await db.insert(drafts).values({ ideaId: idea.id, xText: "I built TeardownHQ", status: "used" }).returning();
    await db.insert(drafts).values({ ideaId: idea.id, xText: "never scheduled", status: "used" });
    await db.insert(scheduledPosts).values({ draftId: canceled.id, platform: "x", text: "I built TeardownHQ", publishAt: new Date("2026-09-24T10:00:00Z"), status: "canceled" });
    expect(await listArchivedPosts(db as never)).toEqual([]);
  });
});
