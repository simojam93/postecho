import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb } from "@/test/db";
import { ideas } from "@/db/schema";

const state: { db: Awaited<ReturnType<typeof createTestDb>> | null } = { db: null };
vi.mock("@/db", () => ({ get db() { return state.db; } }));
vi.mock("@/lib/session", async (orig) => ({ ...(await orig()), requireSession: vi.fn(async () => null) }));

const { GET, POST, DELETE } = await import("@/app/api/style-inspiration/route");
const { getSetting } = await import("@/lib/settings");

const post = (body: unknown) => POST(new Request("http://test", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }));

beforeEach(async () => {
  state.db = await createTestDb();
  const { requireSession } = await import("@/lib/session");
  vi.mocked(requireSession).mockReset().mockResolvedValue(null);
});

describe("style inspiration routes", () => {
  it("POST adds a card's post once, with its author, link, kind and Jev's score; newest first", async () => {
    const [a] = await state.db!.insert(ideas).values({ url: "https://bsky.app/p/1", kind: "bluesky", source: "scout", content: "a post I like", author: "someone", meta: { aiStyle: { slopScore: 22, verdict: "human" } } }).returning();
    const [b] = await state.db!.insert(ideas).values({ url: "https://bsky.app/p/2", kind: "bluesky", source: "scout", content: "another", meta: {} }).returning();
    expect((await post({ ideaId: a.id })).status).toBe(201);
    const again = await post({ ideaId: a.id });
    expect(again.status).toBe(200);
    expect((await again.json()).existing).toBe(true);
    await post({ ideaId: b.id });
    const items = await getSetting(state.db as never, "styleInspiration");
    expect(items.map((i) => i.ideaId)).toEqual([b.id, a.id]);
    expect(items[1]).toMatchObject({ text: "a post I like", author: "someone", url: "https://bsky.app/p/1", kind: "bluesky", slopScore: 22 });
    expect((await (await GET()).json()).items).toHaveLength(2);
  });

  it("404 for an unknown idea, 400 for one without text or a bad body", async () => {
    expect((await post({ ideaId: "5c1d6b3e-1111-4222-8333-444455556666" })).status).toBe(404);
    const [empty] = await state.db!.insert(ideas).values({ kind: "youtube", url: "https://youtu.be/x", content: null, title: null }).returning();
    expect((await post({ ideaId: empty.id })).status).toBe(400);
    expect((await post({ nope: 1 })).status).toBe(400);
  });

  it("DELETE by item id or by idea id", async () => {
    const [a] = await state.db!.insert(ideas).values({ kind: "bluesky", url: "https://bsky.app/p/3", content: "x" }).returning();
    const [b] = await state.db!.insert(ideas).values({ kind: "bluesky", url: "https://bsky.app/p/4", content: "y" }).returning();
    const { item } = await (await post({ ideaId: a.id })).json();
    await post({ ideaId: b.id });
    await DELETE(new Request(`http://test?id=${item.id}`, { method: "DELETE" }));
    await DELETE(new Request(`http://test?ideaId=${b.id}`, { method: "DELETE" }));
    expect(await getSetting(state.db as never, "styleInspiration")).toEqual([]);
    expect((await DELETE(new Request("http://test", { method: "DELETE" }))).status).toBe(400);
  });
});
