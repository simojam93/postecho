import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb } from "@/test/db";

// The route reads the X key saved in Settings (lib/x-config.ts's scoutEnv) — a
// fresh in-memory db per test, never the local dev database.
const state: { db: Awaited<ReturnType<typeof createTestDb>> | null } = { db: null };
vi.mock("@/db", () => ({ get db() { return state.db; } }));
vi.mock("@/lib/session", async (orig) => ({
  ...(await orig()),
  requireSession: vi.fn(async () => null),
}));

const { GET } = await import("@/app/api/sources/route");

type SourceRow = { name: string; label: string; enabled: boolean; requiredEnv: string[] };

beforeEach(async () => {
  state.db = await createTestDb();
  const { requireSession } = await import("@/lib/session");
  const mock = requireSession as unknown as ReturnType<typeof vi.fn>;
  mock.mockReset();
  mock.mockResolvedValue(null);
  vi.unstubAllEnvs();
  // Force-cleared for every test regardless of ambient shell/.env.local
  // state, so "keyless enabled / keyed disabled" is deterministic — .env.local
  // is never auto-loaded by vitest (only by `next dev`/`next build`), but
  // stubbing explicitly makes that independent of how/where this runs.
  vi.stubEnv("BLUESKY_IDENTIFIER", "");
  vi.stubEnv("BLUESKY_APP_PASSWORD", "");
  vi.stubEnv("YOUTUBE_API_KEY", "");
  vi.stubEnv("REDDIT_CLIENT_ID", "");
  vi.stubEnv("REDDIT_CLIENT_SECRET", "");
  vi.stubEnv("PRODUCTHUNT_TOKEN", "");
  vi.stubEnv("X_BEARER_TOKEN", "");
  vi.stubEnv("SESSION_SECRET", "a-session-secret-that-is-long-enough-1234");
});

describe("GET /api/sources", () => {
  it("401s when the session is denied", async () => {
    const { requireSession } = await import("@/lib/session");
    (requireSession as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      Response.json({ error: "unauthorized" }, { status: 401 }),
    );
    const res = await GET();
    expect(res.status).toBe(401);
  });

  it("lists all eleven adapters, X first and then in ALL_ADAPTERS' order (2026-09-27), each with name/label/enabled/requiredEnv", async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    const sources: SourceRow[] = body.sources;
    expect(sources.map((s) => s.name)).toEqual([
      "x_post", "hackernews", "bluesky", "arxiv", "github", "devto", "mastodon", "lobsters", "lemmy", "youtube", "producthunt",
    ]);
  });

  it("says, per source, whether its keys are there, whether the owner disconnected it, and who holds its key (2026-09-25)", async () => {
    const { setSetting } = await import("@/lib/settings");
    await setSetting(state.db! as never, "disabledSources", ["hackernews"]);
    const rows = (await (await GET()).json()).sources as Array<SourceRow & { ready: boolean; off: boolean; keyedBy: string }>;
    const byName = (n: string) => rows.find((r) => r.name === n)!;
    expect(byName("hackernews")).toMatchObject({ enabled: false, ready: true, off: true, keyedBy: "none" });
    expect(byName("arxiv")).toMatchObject({ enabled: true, ready: true, off: false, keyedBy: "none" });
    expect(byName("bluesky")).toMatchObject({ enabled: false, ready: false, off: false, keyedBy: "server" });
    expect(byName("x_post")).toMatchObject({ keyedBy: "owner" });
  });

  it("X is off until a key is saved in Settings, then on — the key itself never in the response (2026-09-24)", async () => {
    const xRow = async () => ((await (await GET()).json()).sources as SourceRow[]).find((s) => s.name === "x_post")!;
    expect(await xRow()).toMatchObject({ name: "x_post", label: "X", enabled: false, requiredEnv: ["X_BEARER_TOKEN"] });
    const { setSetting } = await import("@/lib/settings");
    const { sealSecret } = await import("@/lib/secret-box");
    await setSetting(state.db! as never, "xBearerToken", sealSecret("AAAAAAAAAAAAAAAAAAAA-secret-bearer"));
    expect((await xRow()).enabled).toBe(true);
    expect(JSON.stringify(await (await GET()).json())).not.toContain("secret-bearer");
  });

  it("reports a keyless adapter as enabled with an empty requiredEnv", async () => {
    const res = await GET();
    const body = await res.json();
    const arxiv = (body.sources as SourceRow[]).find((s) => s.name === "arxiv")!;
    expect(arxiv).toMatchObject({ name: "arxiv", label: "arXiv", enabled: true, requiredEnv: [] });
  });

  it("reports a keyed adapter as disabled with its required env var names, when unset", async () => {
    const res = await GET();
    const body = await res.json();
    const bluesky = (body.sources as SourceRow[]).find((s) => s.name === "bluesky")!;
    expect(bluesky.enabled).toBe(false);
    expect(bluesky.requiredEnv).toEqual(["BLUESKY_IDENTIFIER", "BLUESKY_APP_PASSWORD"]);
    const producthunt = (body.sources as SourceRow[]).find((s) => s.name === "producthunt")!;
    expect(producthunt.enabled).toBe(false);
    expect(producthunt.requiredEnv).toEqual(["PRODUCTHUNT_TOKEN"]);
  });

  it("reports a keyed adapter as enabled once its env var is set", async () => {
    vi.stubEnv("YOUTUBE_API_KEY", "test-key-value");
    const res = await GET();
    const body = await res.json();
    const youtube = (body.sources as SourceRow[]).find((s) => s.name === "youtube")!;
    expect(youtube.enabled).toBe(true);
  });

  it("never includes actual env values in the response, only variable names", async () => {
    vi.stubEnv("YOUTUBE_API_KEY", "super-secret-value-should-not-leak");
    const res = await GET();
    const text = JSON.stringify(await res.json());
    expect(text).not.toContain("super-secret-value-should-not-leak");
    expect(text).toContain("YOUTUBE_API_KEY");
  });
});
