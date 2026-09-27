import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb } from "@/test/db";

const state: { db: Awaited<ReturnType<typeof createTestDb>> | null } = { db: null };
vi.mock("@/db", () => ({ get db() { return state.db; } }));
vi.mock("@/lib/session", async (orig) => ({ ...(await orig()), requireSession: vi.fn(async () => null) }));

const { GET, POST, PATCH, DELETE } = await import("@/app/api/references/route");

const json = (method: string, body: unknown) => new Request("http://test", { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

beforeEach(async () => {
  state.db = await createTestDb();
  const { requireSession } = await import("@/lib/session");
  vi.mocked(requireSession).mockReset().mockResolvedValue(null);
});

describe("reference material routes", () => {
  it("add, switch off, rename, remove", async () => {
    const added = await POST(json("POST", { name: " Bio ", text: " Product designer. " }));
    expect(added.status).toBe(201);
    const { item } = await added.json();
    expect(item).toMatchObject({ name: "Bio", text: "Product designer.", enabled: true });

    const off = await (await PATCH(json("PATCH", { id: item.id, enabled: false, name: "About me" }))).json();
    expect(off.items[0]).toMatchObject({ name: "About me", enabled: false });

    await DELETE(new Request(`http://test?id=${item.id}`, { method: "DELETE" }));
    expect((await (await GET()).json()).items).toEqual([]);
  });

  it("400 without a name or text, or text over 20000 characters; 404 patching a missing item", async () => {
    expect((await POST(json("POST", { name: "", text: "t" }))).status).toBe(400);
    expect((await POST(json("POST", { name: "n", text: "x".repeat(20001) }))).status).toBe(400);
    expect((await PATCH(json("PATCH", { id: "nope", enabled: true }))).status).toBe(404);
  });

  it("at most 20 items", async () => {
    for (let i = 0; i < 20; i++) await POST(json("POST", { name: `n${i}`, text: "t" }));
    const res = await POST(json("POST", { name: "one more", text: "t" }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/at most 20/);
  });
});
