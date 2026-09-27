import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb } from "@/test/db";
import { getSetting, setSetting } from "@/lib/settings";

const state: { db: Awaited<ReturnType<typeof createTestDb>> | null } = { db: null };
vi.mock("@/db", () => ({ get db() { return state.db; } }));
vi.mock("@/lib/session", async (orig) => ({ ...(await orig()), requireSession: vi.fn(async () => null) }));
// The live check is faked here; lib/connections.test.ts covers it.
vi.mock("@/lib/connections", async (orig) => {
  const mod = await orig<typeof import("@/lib/connections")>();
  return { ...mod, testService: vi.fn(async () => null) };
});
vi.stubEnv("SESSION_SECRET", "a-session-secret-that-is-long-enough-1234");
vi.stubEnv("AGENT_TOKEN", "agent-token-for-tests");
vi.stubEnv("YOUTUBE_API_KEY", "");

const { GET, PUT, DELETE } = await import("@/app/api/connections/route");
const { GET: agentSetup } = await import("@/app/api/connections/agent/route");
const { testService } = await import("@/lib/connections");

const put = (body: unknown) => PUT(new Request("http://test/api/connections", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }));

beforeEach(async () => {
  state.db = await createTestDb();
  vi.mocked(testService).mockReset().mockResolvedValue(null);
});

describe("/api/connections (2026-09-26)", () => {
  it("connects a key after testing it, never returns it, and takes it back out", async () => {
    await setSetting(state.db as never, "disabledSources", ["youtube"]);
    const res = await put({ service: "youtube", values: { YOUTUBE_API_KEY: "yt-key-9876" } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: { connected: true, via: "app", hint: "…9876" } });
    expect(testService).toHaveBeenCalledWith("youtube", { YOUTUBE_API_KEY: "yt-key-9876" });
    // Connecting a source turns it back on for searches.
    expect(await getSetting(state.db as never, "disabledSources")).toEqual([]);
    const all = await (await GET()).json();
    expect(all.services.youtube).toEqual({ connected: true, via: "app", hint: "…9876" });
    expect(JSON.stringify(all)).not.toContain("yt-key-9876");
    const removed = await DELETE(new Request("http://test/api/connections?service=youtube", { method: "DELETE" }));
    expect((await removed.json()).status).toEqual({ connected: false, via: null, hint: null });
  });

  it("keeps nothing when the test fails, and refuses a missing field or an unknown service", async () => {
    vi.mocked(testService).mockResolvedValueOnce("YouTube refused the key: check that you copied all of it.");
    const refused = await put({ service: "youtube", values: { YOUTUBE_API_KEY: "wrong" } });
    expect(refused.status).toBe(400);
    expect((await refused.json()).error).toMatch(/refused the key/);
    expect(await getSetting(state.db as never, "appKeys")).toEqual({});
    expect((await put({ service: "bluesky", values: { BLUESKY_IDENTIFIER: "me.bsky.social" } })).status).toBe(400);
    expect((await put({ service: "gmail", values: {} })).status).toBe(400);
  });

  it("gives the Mac agent's setup: this site's address and the agent token", async () => {
    const body = await (await agentSetup(new Request("https://postecho.example.com/api/connections/agent"))).json();
    expect(body).toEqual({ url: "https://postecho.example.com", token: "agent-token-for-tests" });
  });
});
