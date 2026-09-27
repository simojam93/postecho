import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb } from "@/test/db";
import { ideas } from "@/db/schema";

const state: { db: Awaited<ReturnType<typeof createTestDb>> | null } = { db: null };
vi.mock("@/db", () => ({ get db() { return state.db; } }));
vi.mock("@/lib/session", async (orig) => ({
  ...(await orig()),
  requireSession: vi.fn(async () => null),
}));

const { POST } = await import("@/app/api/ideas/clear/route");

beforeEach(async () => {
  state.db = await createTestDb();
  const { requireSession } = await import("@/lib/session");
  const mock = requireSession as unknown as ReturnType<typeof vi.fn>;
  mock.mockReset();
  mock.mockResolvedValue(null);
});

type IdeaRow = typeof ideas.$inferInsert;

/** A scouted, still-`new`, bluesky result under "ai audio" unless overridden — the exact shape Trends renders. */
function row(urlSuffix: string, over: Partial<IdeaRow> = {}): IdeaRow {
  return {
    url: `https://example.com/${urlSuffix}`,
    kind: "bluesky",
    content: "text",
    source: "scout",
    status: "new",
    meta: { topic: "ai audio", score: 80 },
    ...over,
  };
}

async function statusByUrl(): Promise<Record<string, string>> {
  const rows = await state.db!.select().from(ideas);
  return Object.fromEntries(rows.map((r) => [r.url!.replace("https://example.com/", ""), r.status]));
}

describe("POST /api/ideas/clear", () => {
  it("archives every new scout result — any kind, any topic — and reports the count", async () => {
    await state.db!.insert(ideas).values([
      row("b1"),
      row("h1", { kind: "hackernews", meta: { topic: "indie saas", score: 70 } }),
      row("g1", { kind: "github", meta: {} }),
    ]);
    const res = await POST();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ archived: 3 });
    expect(await statusByUrl()).toEqual({ b1: "archived", h1: "archived", g1: "archived" });
  });

  it("leaves kept, used and dismissed scout ideas alone — Liked survives Clear all", async () => {
    await state.db!.insert(ideas).values([
      row("n1"),
      row("k1", { status: "kept" }),
      row("u1", { status: "used" }),
      row("d1", { status: "dismissed" }),
      row("a1", { status: "archived" }),
    ]);
    const res = await POST();
    expect(await res.json()).toEqual({ archived: 1 });
    expect(await statusByUrl()).toEqual({ n1: "archived", k1: "kept", u1: "used", d1: "dismissed", a1: "archived" });
  });

  // M3.5 U1 (owner direction, 2026-09-23: "YT come source lo voglio comunque
  // vedere nella pagina trends"): a scouted youtube result is a Trends result
  // like any other kind, so Clear all archives it too. Pasted videos are
  // `source: "manual"` (Videos), and so are seeds/notes — none of them scout
  // rows, so none of them are touched.
  it("archives scouted youtube results too (they're Trends now) — pasted videos and manual seeds/notes stay", async () => {
    await state.db!.insert(ideas).values([
      row("n1"),
      row("yt-scout", { kind: "youtube" }),
      row("yt-manual", { kind: "youtube", source: "manual", meta: {} }),
      row("seed", { kind: "x_post", source: "manual", meta: {} }),
      row("note", { kind: "note", source: "manual", meta: {} }),
    ]);
    const res = await POST();
    expect(await res.json()).toEqual({ archived: 2 });
    expect(await statusByUrl()).toEqual({
      n1: "archived", "yt-scout": "archived", "yt-manual": "new", seed: "new", note: "new",
    });
  });

  it("is a no-op 200 with archived: 0 when Trends is already empty", async () => {
    const res = await POST();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ archived: 0 });
  });

  it("401s when the session is denied", async () => {
    const { requireSession } = await import("@/lib/session");
    (requireSession as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      Response.json({ error: "unauthorized" }, { status: 401 }),
    );
    await state.db!.insert(ideas).values([row("n1")]);
    const res = await POST();
    expect(res.status).toBe(401);
    // Nothing archived on a denied request.
    expect(await statusByUrl()).toEqual({ n1: "new" });
  });
});
