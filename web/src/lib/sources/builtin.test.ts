import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/sources/hackernews", () => ({ searchHackerNews: vi.fn() }));
vi.mock("@/lib/sources/bluesky", () => ({
  searchBluesky: vi.fn(),
  blueskyCredentialsFromEnv: vi.fn(),
}));

const { hackernews, bluesky } = await import("@/lib/sources/builtin");
const { searchHackerNews } = await import("@/lib/sources/hackernews");
const { searchBluesky } = await import("@/lib/sources/bluesky");

// Next.js's global.d.ts augments NodeJS.ProcessEnv with a required NODE_ENV
// field, so a plain `{}`/`{ KEY: "value" }` literal doesn't structurally
// satisfy it — mirrors registry.test.ts's own testEnv helper.
function testEnv(overrides: Partial<NodeJS.ProcessEnv> = {}): NodeJS.ProcessEnv {
  return { NODE_ENV: "test", ...overrides };
}

function sourcePost(overrides: Partial<{
  id: string; source: "bluesky" | "hackernews"; url: string; text: string;
  author: string | null; metrics: { likes?: number; reposts?: number; replies?: number };
  createdAt: string | null;
}> = {}) {
  return {
    id: "id-1",
    source: "hackernews" as const,
    url: "https://example.com/1",
    text: "hello world",
    author: "some author",
    metrics: { likes: 3 },
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("hackernews (SourceAdapter wrapper around searchHackerNews)", () => {
  it("has the documented name/label/tag and no requiredEnv", () => {
    expect(hackernews.name).toBe("hackernews");
    expect(hackernews.label).toBe("Hacker News");
    expect(hackernews.tag).toBe("HN");
    expect(hackernews.requiredEnv ?? []).toEqual([]);
  });

  it("delegates to searchHackerNews with the query and fetcher/limit, mapping SourcePost -> AdapterPost", async () => {
    vi.mocked(searchHackerNews).mockResolvedValueOnce([sourcePost()]);
    const fetcher = vi.fn();
    const r = await hackernews.search("ai audio", { fetcher, limit: 10 });
    expect(searchHackerNews).toHaveBeenCalledWith("ai audio", { fetcher, limit: 10 });
    expect(r).toEqual({
      posts: [{
        id: "id-1", url: "https://example.com/1", text: "hello world", title: null,
        author: "some author", metrics: { likes: 3 }, createdAt: "2026-01-01T00:00:00.000Z",
      }],
      status: "ok",
    });
  });

  it("returns status ok with no posts when searchHackerNews finds nothing", async () => {
    vi.mocked(searchHackerNews).mockResolvedValueOnce([]);
    const r = await hackernews.search("q", { fetcher: vi.fn() });
    expect(r).toEqual({ posts: [], status: "ok" });
  });

  it("degrades to status error (never throws) if searchHackerNews unexpectedly rejects", async () => {
    vi.mocked(searchHackerNews).mockRejectedValueOnce(new Error("boom"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const r = await hackernews.search("q", { fetcher: vi.fn() });
    expect(r.status).toBe("error");
    expect(r.posts).toEqual([]);
    warn.mockRestore();
  });
});

describe("bluesky (SourceAdapter wrapper around searchBluesky)", () => {
  it("has the documented name/label/tag and requiredEnv for BLUESKY_IDENTIFIER/BLUESKY_APP_PASSWORD", () => {
    expect(bluesky.name).toBe("bluesky");
    expect(bluesky.label).toBe("Bluesky");
    expect(bluesky.tag).toBe("BSKY");
    expect(bluesky.requiredEnv).toEqual(["BLUESKY_IDENTIFIER", "BLUESKY_APP_PASSWORD"]);
  });

  it("is disabled (no call to searchBluesky) when required env is missing", async () => {
    const r = await bluesky.search("q", { fetcher: vi.fn(), env: testEnv() });
    expect(r).toEqual({ posts: [], status: "disabled", note: "set BLUESKY_IDENTIFIER, BLUESKY_APP_PASSWORD" });
    expect(searchBluesky).not.toHaveBeenCalled();
  });

  it("is disabled when only one of the two required env vars is set", async () => {
    const r = await bluesky.search("q", { fetcher: vi.fn(), env: testEnv({ BLUESKY_IDENTIFIER: "me" }) });
    expect(r.status).toBe("disabled");
    expect(searchBluesky).not.toHaveBeenCalled();
  });

  it("delegates to searchBluesky and maps SourcePost -> AdapterPost when required env is present", async () => {
    vi.mocked(searchBluesky).mockResolvedValueOnce([
      sourcePost({ id: "b1", source: "bluesky", url: "https://bsky.app/1" }),
    ]);
    const fetcher = vi.fn();
    const env = testEnv({ BLUESKY_IDENTIFIER: "me.bsky.social", BLUESKY_APP_PASSWORD: "app-pass" });
    const r = await bluesky.search("q", { fetcher, limit: 5, env });
    // It logs in with the credentials of the env it was given (the app's keys or the deployment's, 2026-09-26).
    expect(searchBluesky).toHaveBeenCalledWith("q", { fetcher, limit: 5, credentials: { identifier: "me.bsky.social", appPassword: "app-pass" } });
    expect(r).toEqual({
      posts: [{
        id: "b1", url: "https://bsky.app/1", text: "hello world", title: null,
        author: "some author", metrics: { likes: 3 }, createdAt: "2026-01-01T00:00:00.000Z",
      }],
      status: "ok",
    });
  });

  it("falls back to process.env when opts.env is omitted", async () => {
    vi.stubEnv("BLUESKY_IDENTIFIER", "me.bsky.social");
    vi.stubEnv("BLUESKY_APP_PASSWORD", "app-pass");
    vi.mocked(searchBluesky).mockResolvedValueOnce([]);
    const r = await bluesky.search("q", { fetcher: vi.fn() });
    expect(r.status).toBe("ok");
    expect(searchBluesky).toHaveBeenCalled();
    vi.unstubAllEnvs();
  });

  it("degrades to status error (never throws) if searchBluesky unexpectedly rejects", async () => {
    vi.mocked(searchBluesky).mockRejectedValueOnce(new Error("boom"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const env = testEnv({ BLUESKY_IDENTIFIER: "me.bsky.social", BLUESKY_APP_PASSWORD: "app-pass" });
    const r = await bluesky.search("q", { fetcher: vi.fn(), env });
    expect(r.status).toBe("error");
    expect(r.posts).toEqual([]);
    warn.mockRestore();
  });
});
