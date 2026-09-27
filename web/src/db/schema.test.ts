import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb } from "@/test/db";
import { drafts, ideas, jobs, scheduledPosts } from "@/db/schema";

describe("schema", () => {
  it("inserts and reads an idea", async () => {
    const db = await createTestDb();
    await db.insert(ideas).values({ kind: "note", content: "hello" });
    const rows = await db.select().from(ideas);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("new");
  });

  it("defaults job status to queued", async () => {
    const db = await createTestDb();
    await db.insert(jobs).values({ kind: "generate_from_video", payload: { url: "x" } });
    const rows = await db.select().from(jobs);
    expect(rows[0].status).toBe("queued");
  });

  // Regression: drizzle/0004 adds these via ALTER TYPE ... ADD VALUE inside
  // the migrator's single wrapped transaction (see PgDialect.migrate) —
  // worth pinning that Postgres/PGlite actually accepts that (the new value
  // isn't *used* in the same transaction that adds it, which is the usual
  // restriction) rather than just trusting the migration file ran.
  it("accepts the M1.5 scout idea kinds added in migration 0004", async () => {
    const db = await createTestDb();
    await db.insert(ideas).values({ kind: "bluesky", url: "https://bsky.app/profile/a/post/1", content: "hi" });
    await db.insert(ideas).values({ kind: "hackernews", url: "https://news.ycombinator.com/item?id=1", content: "hi" });
    const rows = await db.select().from(ideas);
    expect(rows.map((r) => r.kind).sort()).toEqual(["bluesky", "hackernews"]);
  });

  // Same regression shape as above, for migration 0005's "kept" idea_status
  // value (the ♥ keep taste signal — see lib/taste.ts).
  it("accepts the 'kept' idea status added in migration 0005", async () => {
    const db = await createTestDb();
    await db.insert(ideas).values({ kind: "note", content: "hi", status: "kept" });
    const rows = await db.select().from(ideas);
    expect(rows[0].status).toBe("kept");
  });

  // Same regression shape as above, for migration 0006's six new idea_kind
  // values (the seven-adapters wiring, 2026-09-22 — see lib/sources/all.ts).
  // YouTube isn't included here: it needs no new enum value (see schema.ts's
  // ideaKind comment), so it's already covered by the very first test above.
  it("accepts the six new idea kinds added in migration 0006", async () => {
    const db = await createTestDb();
    const newKinds = ["arxiv", "github", "devto", "mastodon", "reddit", "producthunt"] as const;
    for (const kind of newKinds) {
      await db.insert(ideas).values({ kind, url: `https://example.com/${kind}`, content: "hi" });
    }
    const rows = await db.select().from(ideas);
    expect(rows.map((r) => r.kind).sort()).toEqual([...newKinds].sort());
  });

  // Same regression shape as above, for migration 0008's two new idea_kind
  // values (the Lobsters + Lemmy keyless sources, 2026-09-22 — see
  // lib/sources/lobsters.ts and lemmy.ts).
  it("accepts the lobsters/lemmy idea kinds added in migration 0008", async () => {
    const db = await createTestDb();
    const newKinds = ["lobsters", "lemmy"] as const;
    for (const kind of newKinds) {
      await db.insert(ideas).values({ kind, url: `https://example.com/${kind}`, content: "hi" });
    }
    const rows = await db.select().from(ideas);
    expect(rows.map((r) => r.kind).sort()).toEqual([...newKinds].sort());
  });

  // Same regression shape as above, for migration 0007's "generate_from_idea"
  // job_kind value (M2 agent+generation — see the jobKind comment in schema.ts).
  it("accepts the 'generate_from_idea' job kind added in migration 0007", async () => {
    const db = await createTestDb();
    await db.insert(jobs).values({ kind: "generate_from_idea", payload: { ideaId: "x" } });
    const rows = await db.select().from(jobs);
    expect(rows[0].kind).toBe("generate_from_idea");
  });

  // Migration 0007 also adds drafts.jobId (nullable) and drafts.meta
  // (jsonb, default {}, not null) for the M2 result-materialization
  // idempotency check (see materialize.ts, task A3) and per-draft data like
  // slop-check results (task A5).
  it("stores a draft's jobId and meta (migration 0007)", async () => {
    const db = await createTestDb();
    const jobId = "123e4567-e89b-12d3-a456-426614174000";
    await db.insert(drafts).values({ xText: "hello", jobId, meta: { overLimit: false } });
    const rows = await db.select().from(drafts);
    expect(rows[0].jobId).toBe(jobId);
    expect(rows[0].meta).toEqual({ overLimit: false });
  });

  it("defaults a draft's meta to {} when not provided", async () => {
    const db = await createTestDb();
    await db.insert(drafts).values({ xText: "hello" });
    const rows = await db.select().from(drafts);
    expect(rows[0].meta).toEqual({});
    expect(rows[0].jobId).toBeNull();
  });

  // Migration 0009 (M3 publishing, plan P1) grows scheduled_posts additively:
  // published_url, emailed_at, created_at/updated_at (defaulted, so existing
  // rows backfill), an index on the slot and the one-queued-per-(draft,
  // platform) partial unique index behind the API's 409. The TS names
  // publishAt/externalId map onto the M1 columns scheduled_at/
  // qstash_message_id — see the scheduledPosts comment in schema.ts.
  it("stores the M3 scheduling columns with their defaults (migration 0009)", async () => {
    const db = await createTestDb();
    const [draft] = await db.insert(drafts).values({ xText: "hello" }).returning();
    const publishAt = new Date("2030-01-01T16:00:00Z");
    const [post] = await db.insert(scheduledPosts).values({
      draftId: draft.id, platform: "x", text: "hello", publishAt, updatedAt: new Date("2020-01-01T00:00:00Z"),
    }).returning();
    expect(post).toMatchObject({
      status: "queued", postedBy: null, externalId: null, platformPostId: null, publishedUrl: null,
      error: null, emailedAt: null, publishedAt: null,
    });
    expect(post.publishAt).toEqual(publishAt);
    expect(post.createdAt).toBeInstanceOf(Date);

    const emailedAt = new Date("2030-01-01T15:55:00Z");
    const [updated] = await db.update(scheduledPosts)
      .set({ status: "emailed", emailedAt, externalId: "msg_1", publishedUrl: "https://x.com/i/status/1" })
      .where(eq(scheduledPosts.id, post.id))
      .returning();
    expect(updated).toMatchObject({ status: "emailed", externalId: "msg_1", publishedUrl: "https://x.com/i/status/1" });
    expect(updated.emailedAt).toEqual(emailedAt);
    // updated_at is bumped by the column's $onUpdate.
    expect(updated.updatedAt.getTime()).toBeGreaterThan(new Date("2020-01-01T00:00:00Z").getTime());
  });

  it("allows one queued schedule per draft and platform, and any number otherwise (migration 0009)", async () => {
    const db = await createTestDb();
    const [draft] = await db.insert(drafts).values({ xText: "hello", linkedinText: "hello there" }).returning();
    const publishAt = new Date("2030-01-01T16:00:00Z");
    const row = (platform: "x" | "linkedin", status?: "queued" | "canceled" | "posted_manually") =>
      ({ draftId: draft.id, platform, text: "hello", publishAt, status });

    await db.insert(scheduledPosts).values(row("x"));
    // drizzle wraps the driver error ("Failed query: …"); the constraint name is on its cause.
    const duplicate = await db.insert(scheduledPosts).values(row("x", "queued")).then(() => null, (e: unknown) => e);
    expect(duplicate).toBeInstanceOf(Error);
    const cause = (duplicate as Error & { cause?: unknown }).cause;
    expect(String(cause instanceof Error ? cause.message : duplicate)).toMatch(/scheduled_posts_one_queued_per_draft_platform/);
    // Another platform, or another status, is fine.
    await db.insert(scheduledPosts).values([row("linkedin"), row("x", "canceled"), row("x", "posted_manually")]);
    expect(await db.select().from(scheduledPosts)).toHaveLength(4);
  });
});
