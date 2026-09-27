import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb } from "@/test/db";
import { ideas } from "@/db/schema";

const state: { db: Awaited<ReturnType<typeof createTestDb>> | null } = { db: null };
vi.mock("@/db", () => ({ get db() { return state.db; } }));
vi.mock("@/lib/session", async (orig) => ({
  ...(await orig()),
  requireSession: vi.fn(async () => null),
}));

const { GET, DELETE } = await import("@/app/api/searches/route");

beforeEach(async () => {
  state.db = await createTestDb();
  const { requireSession } = await import("@/lib/session");
  const mock = requireSession as unknown as ReturnType<typeof vi.fn>;
  mock.mockReset();
  mock.mockResolvedValue(null);
});

function scoutIdea(topic: string, createdAt: Date, urlSuffix: string) {
  return {
    kind: "bluesky" as const,
    url: `https://example.com/${urlSuffix}`,
    content: "text",
    source: "scout" as const,
    meta: { topic, score: 80, sourceName: "bluesky", metrics: {} },
    createdAt,
  };
}

describe("GET /api/searches", () => {
  it("pairs each chip with what the owner typed: the newest seed searched with it, not a ↻ re-search (2026-09-24)", async () => {
    await state.db!.insert(ideas).values(scoutIdea("computer use agents", new Date("2026-09-24T10:00:00Z"), "a"));
    await state.db!.insert(ideas).values([
      { kind: "note", source: "manual", content: "find interesting viral computer use agents", meta: { searchQuery: "computer use agents" }, createdAt: new Date("2026-09-24T09:00:00Z") },
      { kind: "note", source: "manual", content: "computer use agents", meta: { searchQuery: "computer use agents" }, createdAt: new Date("2026-09-24T11:00:00Z") },
    ]);
    await state.db!.insert(ideas).values(scoutIdea("older topic", new Date("2026-09-20T10:00:00Z"), "b"));
    const { searches } = await (await GET()).json();
    expect(searches.find((s: { query: string }) => s.query === "computer use agents").seed).toBe("find interesting viral computer use agents");
    expect(searches.find((s: { query: string }) => s.query === "older topic").seed).toBeNull();
  });

  it("returns [] when there are no scout ideas", async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    expect((await res.json()).searches).toEqual([]);
  });

  it("groups scout ideas by meta.topic with count and lastAt, ordered by lastAt desc", async () => {
    await state.db!.insert(ideas).values([
      scoutIdea("ai audio", new Date("2026-09-19T10:00:00Z"), "1"),
      scoutIdea("ai audio", new Date("2026-09-20T10:00:00Z"), "2"),
      scoutIdea("indie saas", new Date("2026-09-21T10:00:00Z"), "3"),
    ]);
    const res = await GET();
    const body = await res.json();
    expect(body.searches).toEqual([
      { query: "indie saas", count: 1, lastAt: expect.any(String), seed: null },
      { query: "ai audio", count: 2, lastAt: expect.any(String), seed: null },
    ]);
    expect(new Date(body.searches[1].lastAt).toISOString()).toBe("2026-09-20T10:00:00.000Z");
  });

  it("excludes manual (non-scout) ideas", async () => {
    await state.db!.insert(ideas).values({ kind: "note", content: "hi", source: "manual" });
    const res = await GET();
    expect((await res.json()).searches).toEqual([]);
  });

  it("drops dismissed and archived ideas from the chips (a fully-dismissed topic disappears)", async () => {
    await state.db!.insert(ideas).values([
      { ...scoutIdea("ai audio", new Date("2026-09-20T10:00:00Z"), "a1"), status: "dismissed" },
      { ...scoutIdea("ai audio", new Date("2026-09-20T11:00:00Z"), "a2"), status: "dismissed" },
      { ...scoutIdea("indie saas", new Date("2026-09-21T10:00:00Z"), "s1"), status: "new" },
      { ...scoutIdea("indie saas", new Date("2026-09-21T11:00:00Z"), "s2"), status: "archived" },
      { ...scoutIdea("indie saas", new Date("2026-09-21T12:00:00Z"), "s3"), status: "kept" },
    ]);
    const res = await GET();
    const body = await res.json();
    expect(body.searches).toEqual([{ query: "indie saas", count: 2, lastAt: expect.any(String), seed: null }]);
  });

  it("limits to the 20 most recent topics", async () => {
    const rows = Array.from({ length: 25 }, (_, i) => scoutIdea(`topic-${i}`, new Date(2026, 8, 1 + i), `${i}`));
    await state.db!.insert(ideas).values(rows);
    const res = await GET();
    const body = await res.json();
    expect(body.searches).toHaveLength(20);
    // Most recently-searched topics (highest i) win.
    expect(body.searches[0].query).toBe("topic-24");
  });

  it("401s when the session is denied", async () => {
    const { requireSession } = await import("@/lib/session");
    (requireSession as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      Response.json({ error: "unauthorized" }, { status: 401 }),
    );
    const res = await GET();
    expect(res.status).toBe(401);
  });

  describe("DELETE ?query=", () => {
    function del(query: string | null) {
      const url = query === null ? "http://test/api/searches" : `http://test/api/searches?query=${encodeURIComponent(query)}`;
      return DELETE(new Request(url, { method: "DELETE" }));
    }

    it("archives the topic's new ideas, untags kept/used ones, and the chip disappears", async () => {
      await state.db!.insert(ideas).values([
        { ...scoutIdea("ai audio", new Date("2026-09-20T10:00:00Z"), "a1"), status: "new" },
        { ...scoutIdea("ai audio", new Date("2026-09-20T11:00:00Z"), "a2"), status: "kept" },
        { ...scoutIdea("ai audio", new Date("2026-09-20T12:00:00Z"), "a3"), status: "used" },
        { ...scoutIdea("indie saas", new Date("2026-09-21T10:00:00Z"), "s1"), status: "new" },
      ]);
      const res = await del("ai audio");
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ query: "ai audio", archived: 1, untagged: 2 });

      const rows = await state.db!.select().from(ideas);
      const byUrl = Object.fromEntries(rows.map((r) => [r.url, r]));
      expect(byUrl["https://example.com/a1"].status).toBe("archived");
      expect(byUrl["https://example.com/a2"].status).toBe("kept");
      expect((byUrl["https://example.com/a2"].meta as { topic?: string }).topic).toBeUndefined();
      expect((byUrl["https://example.com/a2"].meta as { score?: number }).score).toBe(80);
      expect(byUrl["https://example.com/a3"].status).toBe("used");
      // The other topic is untouched.
      expect(byUrl["https://example.com/s1"].status).toBe("new");
      expect((byUrl["https://example.com/s1"].meta as { topic?: string }).topic).toBe("indie saas");

      const chips = (await (await GET()).json()).searches;
      expect(chips).toEqual([{ query: "indie saas", count: 1, lastAt: expect.any(String), seed: null }]);
    });

    it("400s without a query, and is a no-op 200 for an unknown topic", async () => {
      expect((await del(null)).status).toBe(400);
      expect((await del("   ")).status).toBe(400);
      const res = await del("never searched");
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ query: "never searched", archived: 0, untagged: 0 });
    });

    it("401s when the session is denied", async () => {
      const { requireSession } = await import("@/lib/session");
      (requireSession as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
        Response.json({ error: "unauthorized" }, { status: 401 }),
      );
      expect((await del("x")).status).toBe(401);
    });
  });
});
