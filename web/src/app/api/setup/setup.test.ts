import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb } from "@/test/db";

const state: { db: Awaited<ReturnType<typeof createTestDb>> | null } = { db: null };
vi.mock("@/db", () => ({ get db() { return state.db; } }));
vi.mock("@/lib/session", async (orig) => ({
  ...(await orig()),
  requireSession: vi.fn(async () => null),
}));

const { GET, POST } = await import("@/app/api/setup/route");

beforeEach(async () => {
  state.db = await createTestDb();
  const { requireSession } = await import("@/lib/session");
  const mock = requireSession as unknown as ReturnType<typeof vi.fn>;
  mock.mockReset();
  mock.mockResolvedValue(null);
});

describe("GET/POST /api/setup (the welcome, 2026-09-26)", () => {
  it("reports what's connected, then remembers the welcome was done", async () => {
    const before = await (await GET()).json();
    expect(before.status).toMatchObject({ onboardedAt: null, agent: { online: false } });
    const done = await POST();
    expect(done.status).toBe(200);
    const { onboardedAt } = await done.json();
    expect(typeof onboardedAt).toBe("string");
    expect((await (await GET()).json()).status.onboardedAt).toBe(onboardedAt);
  });

  it("remembers a tab's closed hint, and forgets them all when the welcome is shown again (2026-09-27)", async () => {
    const hint = (body: unknown) => POST(new Request("http://x/api/setup", { method: "POST", body: JSON.stringify(body) }));
    expect(await (await hint({ hint: "sources" })).json()).toEqual({ seenHints: ["sources"] });
    expect(await (await hint({ hint: "settings" })).json()).toEqual({ seenHints: ["sources", "settings"] });
    expect(await (await hint({ hint: "sources" })).json()).toEqual({ seenHints: ["sources", "settings"] });
    // The Videos tab's first-time window (2026-09-27).
    expect(await (await hint({ hint: "videos" })).json()).toEqual({ seenHints: ["sources", "settings", "videos"] });
    expect(await (await hint({ resetHints: true })).json()).toEqual({ seenHints: [] });
    // An unknown hint (or one retired, like Write's old pill) is no hint: the call still means the welcome is done.
    expect(await (await hint({ hint: "write" })).json()).toHaveProperty("onboardedAt");
  });

  it("needs a session", async () => {
    const { requireSession } = await import("@/lib/session");
    (requireSession as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(Response.json({ error: "unauthorized" }, { status: 401 }));
    expect((await GET()).status).toBe(401);
  });
});
