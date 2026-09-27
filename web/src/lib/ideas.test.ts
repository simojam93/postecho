import { describe, expect, it, vi } from "vitest";
import { createTestDb } from "@/test/db";
import { ideas } from "@/db/schema";

const fakeEnrich = { kind: "x_post" as const, title: "t", content: "c", author: "a", meta: {} };
vi.mock("@/lib/enrich", async (orig) => ({
  ...(await orig()),
  enrich: vi.fn(async () => fakeEnrich),
}));

const { saveIdeaFromInput } = await import("@/lib/ideas");

describe("saveIdeaFromInput", () => {
  it("creates a note from text", async () => {
    const db = await createTestDb();
    const r = await saveIdeaFromInput(db as never, { text: "an idea" });
    expect(r.existing).toBe(false);
    expect(r.idea.kind).toBe("note");
    expect(r.idea.content).toBe("an idea");
  });

  describe("note dedupe (M1.5 search-results UX round)", () => {
    it("reuses an existing note with identical trimmed content, case-insensitively", async () => {
      const db = await createTestDb();
      const first = await saveIdeaFromInput(db as never, { text: "Ship the voice cloning demo" });
      const second = await saveIdeaFromInput(db as never, { text: "  ship the VOICE CLONING demo  " });
      expect(second.existing).toBe(true);
      expect(second.idea.id).toBe(first.idea.id);
      const rows = await db.select().from(ideas);
      expect(rows).toHaveLength(1);
    });

    it("stores the trimmed text on first insert", async () => {
      const db = await createTestDb();
      const r = await saveIdeaFromInput(db as never, { text: "  an idea with padding  " });
      expect(r.idea.content).toBe("an idea with padding");
    });

    it("does not dedupe two genuinely different notes", async () => {
      const db = await createTestDb();
      const a = await saveIdeaFromInput(db as never, { text: "idea one" });
      const b = await saveIdeaFromInput(db as never, { text: "idea two" });
      expect(a.existing).toBe(false);
      expect(b.existing).toBe(false);
      const rows = await db.select().from(ideas);
      expect(rows).toHaveLength(2);
    });

    it("does not dedupe a note against a non-note idea with matching content", async () => {
      const db = await createTestDb();
      await db.insert(ideas).values({ kind: "x_post", content: "same text", url: "https://x.com/a/status/1" });
      const r = await saveIdeaFromInput(db as never, { text: "same text" });
      expect(r.existing).toBe(false);
      const rows = await db.select().from(ideas);
      expect(rows).toHaveLength(2);
    });
  });

  it("creates an enriched idea from a url", async () => {
    const db = await createTestDb();
    const r = await saveIdeaFromInput(db as never, { url: "https://x.com/a/status/1" });
    expect(r.existing).toBe(false);
    expect(r.idea.kind).toBe("x_post");
    expect(r.idea.author).toBe("a");
  });

  it("dedupes by url, returning the existing row with existing:true", async () => {
    const db = await createTestDb();
    const first = await saveIdeaFromInput(db as never, { url: "https://x.com/a/status/dup" });
    const second = await saveIdeaFromInput(db as never, { url: "https://x.com/a/status/dup" });
    expect(second.existing).toBe(true);
    expect(second.idea.id).toBe(first.idea.id);
    const rows = await db.select().from(ideas);
    expect(rows).toHaveLength(1);
  });

  it("merges source and meta onto the enriched idea (scout provenance)", async () => {
    const db = await createTestDb();
    const r = await saveIdeaFromInput(db as never, {
      url: "https://x.com/a/status/2",
      source: "scout",
      meta: { score: 87, topic: "ai audio" },
    });
    expect(r.idea.source).toBe("scout");
    expect((r.idea.meta as { score?: number }).score).toBe(87);
    expect((r.idea.meta as { topic?: string }).topic).toBe("ai audio");
  });

  it("defaults source to manual when not provided", async () => {
    const db = await createTestDb();
    const r = await saveIdeaFromInput(db as never, { url: "https://x.com/a/status/3" });
    expect(r.idea.source).toBe("manual");
  });

  it("throws when neither url nor text is provided", async () => {
    const db = await createTestDb();
    await expect(saveIdeaFromInput(db as never, {})).rejects.toThrow();
  });

  it("backfills a titleless url seed when the same url is saved again with a readable enrichment", async () => {
    const db = await createTestDb();
    const url = "https://example.com/essay.html";
    const blank = { kind: "article" as const, title: null, content: null, author: null, meta: {} };
    const first = await saveIdeaFromInput(db as never, { url, enriched: blank });
    expect(first.existing).toBe(false);
    expect(first.idea.title).toBeNull();

    const read = { kind: "article" as const, title: "Do Things that Don't Scale", content: "An essay.", author: null, meta: {} };
    const second = await saveIdeaFromInput(db as never, { url, enriched: read });
    expect(second.existing).toBe(true);
    expect(second.idea.id).toBe(first.idea.id);
    expect(second.idea.title).toBe("Do Things that Don't Scale");
    expect(second.idea.content).toBe("An essay.");

    // Values already present are never overwritten.
    const other = { ...read, title: "Different", content: "Other" };
    const third = await saveIdeaFromInput(db as never, { url, enriched: other });
    expect(third.idea.title).toBe("Do Things that Don't Scale");
  });
});
