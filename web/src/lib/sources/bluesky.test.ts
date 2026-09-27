import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createBlueskySession,
  resetBlueskyStateForTests,
  searchBluesky,
} from "@/lib/sources/bluesky";
import type { Fetcher } from "@/lib/sources/types";

const SESSION_URL = "https://bsky.social/xrpc/com.atproto.server.createSession";
const SEARCH_URL = "https://bsky.social/xrpc/app.bsky.feed.searchPosts";

const CREDENTIALS = { identifier: "owner.bsky.social", appPassword: "aaaa-bbbb-cccc-dddd" };

function sessionBody(
  overrides: Partial<{ accessJwt: string; refreshJwt: string; did: string; handle: string }> = {},
) {
  return {
    accessJwt: overrides.accessJwt ?? "access-jwt-1",
    refreshJwt: overrides.refreshJwt ?? "refresh-jwt-1",
    did: overrides.did ?? "did:plc:owner",
    handle: overrides.handle ?? "owner.bsky.social",
  };
}

const onePostBody = {
  posts: [
    {
      uri: "at://did:plc:abc123/app.bsky.feed.post/3k2z9",
      author: { handle: "ronin.bsky.social", displayName: "Ronin" },
      record: { text: "Best methods to promote your SaaS", createdAt: "2026-09-20T10:00:00.000Z" },
      likeCount: 12,
      repostCount: 3,
      replyCount: 4,
    },
  ],
};

/** Each call consumes the next {status, body} in order; the last entry repeats for any extra calls. */
function scriptedFetcher(
  responses: Array<{ status: number; body: unknown }>,
): { fetcher: Fetcher; calls: { url: string; init?: RequestInit }[] } {
  const calls: { url: string; init?: RequestInit }[] = [];
  let i = 0;
  const fetcher: Fetcher = async (url, init) => {
    calls.push({ url, init });
    const entry = responses[Math.min(i, responses.length - 1)];
    i++;
    return {
      ok: entry.status >= 200 && entry.status < 300,
      status: entry.status,
      text: async () => (typeof entry.body === "string" ? entry.body : JSON.stringify(entry.body)),
    };
  };
  return { fetcher, calls };
}

type Reply = { status: number; body: unknown };

/**
 * Routes by endpoint and `sort` instead of by call order, because the two
 * search passes now run in parallel: an order-indexed script would hand the
 * `latest` pass whatever was meant for `top`'s retry. Each route has its own
 * queue (last entry repeats), so "401 then 200" can be scripted for one sort
 * without touching the other.
 */
function routedFetcher(routes: { session?: Reply[]; top?: Reply[]; latest?: Reply[] } = {}): {
  fetcher: Fetcher;
  calls: { url: string; init?: RequestInit }[];
} {
  const calls: { url: string; init?: RequestInit }[] = [];
  const queues: Record<string, Reply[]> = {
    session: [...(routes.session ?? [{ status: 200, body: sessionBody() }])],
    top: [...(routes.top ?? [{ status: 200, body: { posts: [] } }])],
    latest: [...(routes.latest ?? [{ status: 200, body: { posts: [] } }])],
  };
  const fetcher: Fetcher = async (url, init) => {
    calls.push({ url, init });
    const key = url === SESSION_URL ? "session" : new URL(url).searchParams.get("sort") ?? "top";
    const queue = queues[key];
    const entry = queue.length > 1 ? (queue.shift() as Reply) : queue[0];
    return {
      ok: entry.status >= 200 && entry.status < 300,
      status: entry.status,
      text: async () => (typeof entry.body === "string" ? entry.body : JSON.stringify(entry.body)),
    };
  };
  return { fetcher, calls };
}

/** A search response carrying one post per rkey, all by the same author. */
function postsBody(...rkeys: string[]) {
  return {
    posts: rkeys.map((rkey) => ({
      uri: `at://did:plc:abc123/app.bsky.feed.post/${rkey}`,
      author: { handle: "ronin.bsky.social" },
      record: { text: rkey },
    })),
  };
}

/** The `sort` of every search call, in order (session calls omitted). */
function sorts(calls: { url: string }[]): string[] {
  return calls.filter((c) => c.url !== SESSION_URL).map((c) => new URL(c.url).searchParams.get("sort") ?? "");
}

function authHeader(call: { init?: RequestInit } | undefined): string | undefined {
  return (call?.init?.headers as Record<string, string> | undefined)?.Authorization;
}

beforeEach(() => {
  resetBlueskyStateForTests();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("createBlueskySession", () => {
  it("posts identifier/password as JSON to createSession and returns accessJwt/did/handle", async () => {
    const { fetcher, calls } = scriptedFetcher([{ status: 200, body: sessionBody() }]);
    const session = await createBlueskySession({ ...CREDENTIALS, fetcher });
    expect(session).toEqual({ accessJwt: "access-jwt-1", did: "did:plc:owner", handle: "owner.bsky.social" });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(SESSION_URL);
    expect(calls[0].init?.method).toBe("POST");
    expect(JSON.parse(calls[0].init?.body as string)).toEqual({
      identifier: CREDENTIALS.identifier,
      password: CREDENTIALS.appPassword,
    });
  });

  it("passes an AbortSignal for the 8s timeout", async () => {
    const { fetcher, calls } = scriptedFetcher([{ status: 200, body: sessionBody() }]);
    await createBlueskySession({ ...CREDENTIALS, fetcher });
    expect(calls[0].init?.signal).toBeInstanceOf(AbortSignal);
  });

  it("throws an error carrying the response status on a non-2xx response, without leaking credentials", async () => {
    const { fetcher } = scriptedFetcher([
      { status: 401, body: { error: "AuthenticationRequired", message: "Invalid identifier or password" } },
    ]);
    let caught: unknown;
    try {
      await createBlueskySession({ ...CREDENTIALS, fetcher });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as { status?: number }).status).toBe(401);
    const serialized = `${(caught as Error).message} ${JSON.stringify(caught)}`;
    expect(serialized).not.toContain(CREDENTIALS.appPassword);
    expect(serialized).not.toContain(CREDENTIALS.identifier);
  });
});

describe("searchBluesky — disabled (no credentials configured)", () => {
  it("returns [] without making any fetch call", async () => {
    const fetcher = vi.fn();
    const r = await searchBluesky("saas", { fetcher });
    expect(r).toEqual([]);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("warns once per process even across multiple disabled calls", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetcher = vi.fn();
    await searchBluesky("a", { fetcher });
    await searchBluesky("b", { fetcher });
    await searchBluesky("c", { fetcher });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith("bluesky: disabled — set BLUESKY_IDENTIFIER and BLUESKY_APP_PASSWORD");
    warn.mockRestore();
  });
});

describe("searchBluesky — authenticated", () => {
  it("logs in, then sends a Bearer-authenticated GET to the bsky.social search endpoint", async () => {
    const { fetcher, calls } = scriptedFetcher([
      { status: 200, body: sessionBody({ accessJwt: "jwt-a" }) },
      { status: 200, body: onePostBody },
    ]);
    const r = await searchBluesky("saas", { fetcher, credentials: CREDENTIALS });
    // Both passes see the same single post, so the merge dedupes it to one.
    expect(r).toHaveLength(1);
    // One login, two searches — never two logins.
    expect(calls).toHaveLength(3);
    expect(calls.filter((c) => c.url === SESSION_URL)).toHaveLength(1);
    expect(calls[0].url).toBe(SESSION_URL);
    expect(calls[1].url.startsWith(SEARCH_URL)).toBe(true);
    expect(calls[2].url.startsWith(SEARCH_URL)).toBe(true);
    expect(authHeader(calls[1])).toBe("Bearer jwt-a");
    expect(authHeader(calls[2])).toBe("Bearer jwt-a");
  });

  it("parses posts into SourcePost shape (parser unchanged)", async () => {
    const { fetcher } = scriptedFetcher([{ status: 200, body: sessionBody() }, { status: 200, body: onePostBody }]);
    const r = await searchBluesky("saas", { fetcher, credentials: CREDENTIALS, now: () => 0 });
    expect(r[0]).toEqual({
      id: "at://did:plc:abc123/app.bsky.feed.post/3k2z9",
      source: "bluesky",
      url: "https://bsky.app/profile/ronin.bsky.social/post/3k2z9",
      text: "Best methods to promote your SaaS",
      author: "Ronin",
      metrics: { likes: 12, reposts: 3, replies: 4 },
      createdAt: "2026-09-20T10:00:00.000Z",
    });
  });

  it("falls back to the handle when displayName is missing", async () => {
    const body = {
      posts: [{ uri: "at://did:plc:x/app.bsky.feed.post/rk1", author: { handle: "nodisplay.bsky.social" }, record: { text: "hi" } }],
    };
    const { fetcher } = scriptedFetcher([{ status: 200, body: sessionBody() }, { status: 200, body }]);
    const r = await searchBluesky("q", { fetcher, credentials: CREDENTIALS, now: () => 0 });
    expect(r[0].author).toBe("nodisplay.bsky.social");
  });

  it("builds the search request url with encoded query, limit, and sort=top", async () => {
    const { fetcher, calls } = scriptedFetcher([
      { status: 200, body: sessionBody() },
      { status: 200, body: { posts: [] } },
    ]);
    await searchBluesky("ai audio & voice", { fetcher, credentials: CREDENTIALS, now: () => 0, limit: 10 });
    const url = new URL(calls[1].url);
    expect(url.origin + url.pathname).toBe(SEARCH_URL);
    expect(url.searchParams.get("q")).toBe("ai audio & voice");
    expect(url.searchParams.get("limit")).toBe("10");
    expect(url.searchParams.get("sort")).toBe("top");
  });

  it("defaults limit to 25", async () => {
    const { fetcher, calls } = scriptedFetcher([
      { status: 200, body: sessionBody() },
      { status: 200, body: { posts: [] } },
    ]);
    await searchBluesky("q", { fetcher, credentials: CREDENTIALS, now: () => 0 });
    expect(new URL(calls[1].url).searchParams.get("limit")).toBe("25");
  });

  it("passes an AbortSignal for the 8s timeout on the search call", async () => {
    const { fetcher, calls } = scriptedFetcher([
      { status: 200, body: sessionBody() },
      { status: 200, body: { posts: [] } },
    ]);
    await searchBluesky("q", { fetcher, credentials: CREDENTIALS, now: () => 0 });
    expect(calls[1].init?.signal).toBeInstanceOf(AbortSignal);
  });

  it("uses BLUESKY_IDENTIFIER/BLUESKY_APP_PASSWORD from env when opts.credentials is not given", async () => {
    vi.stubEnv("BLUESKY_IDENTIFIER", "env.bsky.social");
    vi.stubEnv("BLUESKY_APP_PASSWORD", "env-app-pass");
    const { fetcher, calls } = scriptedFetcher([
      { status: 200, body: sessionBody() },
      { status: 200, body: { posts: [] } },
    ]);
    await searchBluesky("q", { fetcher, now: () => 0 });
    expect(JSON.parse(calls[0].init?.body as string)).toEqual({
      identifier: "env.bsky.social",
      password: "env-app-pass",
    });
  });
});

describe("searchBluesky — session caching (90 minutes, injectable clock)", () => {
  it("reuses the cached session across calls within 90 minutes", async () => {
    const { fetcher, calls } = scriptedFetcher([
      { status: 200, body: sessionBody() },
      { status: 200, body: { posts: [] } },
      { status: 200, body: { posts: [] } },
    ]);
    let t = 0;
    const now = () => t;
    await searchBluesky("a", { fetcher, credentials: CREDENTIALS, now });
    t = 89 * 60 * 1000; // 89 minutes later — still within the 90-minute TTL
    await searchBluesky("b", { fetcher, credentials: CREDENTIALS, now });
    expect(calls.filter((c) => c.url === SESSION_URL)).toHaveLength(1);
    // Two searches per call (top + latest), both on the one cached session.
    expect(calls.filter((c) => c.url.startsWith(SEARCH_URL))).toHaveLength(4);
  });

  it("creates a fresh session once the cached one is older than 90 minutes", async () => {
    const { calls, fetcher } = scriptedFetcher([
      { status: 200, body: sessionBody() },
      { status: 200, body: { posts: [] } },
      { status: 200, body: sessionBody() },
      { status: 200, body: { posts: [] } },
    ]);
    let t = 0;
    const now = () => t;
    await searchBluesky("a", { fetcher, credentials: CREDENTIALS, now });
    t = 90 * 60 * 1000 + 1; // just past the 90-minute TTL
    await searchBluesky("b", { fetcher, credentials: CREDENTIALS, now });
    expect(calls.filter((c) => c.url === SESSION_URL)).toHaveLength(2);
  });
});

describe("searchBluesky — 401 triggers one refresh-and-retry", () => {
  it("refreshes the session once and retries the pass that got the 401, leaving the other pass alone", async () => {
    const { fetcher, calls } = routedFetcher({
      session: [{ status: 200, body: sessionBody({ accessJwt: "jwt-old" }) }, { status: 200, body: sessionBody({ accessJwt: "jwt-new" }) }],
      top: [{ status: 401, body: { error: "ExpiredToken" } }, { status: 200, body: postsBody("from-top") }],
      latest: [{ status: 200, body: postsBody("from-latest") }],
    });
    const r = await searchBluesky("q", { fetcher, credentials: CREDENTIALS, now: () => 0 });
    expect(r.map((p) => p.url)).toEqual([
      "https://bsky.app/profile/ronin.bsky.social/post/from-top",
      "https://bsky.app/profile/ronin.bsky.social/post/from-latest",
    ]);
    // login, top (401), latest (ok), re-login, top retried — and `latest`
    // is never re-issued, since it never saw a 401.
    expect(calls.filter((c) => c.url === SESSION_URL)).toHaveLength(2);
    expect(sorts(calls)).toEqual(["top", "latest", "top"]);
    expect(authHeader(calls[calls.length - 1])).toBe("Bearer jwt-new");
  });

  it("logs in only once more when BOTH passes get a 401 at the same time", async () => {
    const { fetcher, calls } = routedFetcher({
      session: [{ status: 200, body: sessionBody({ accessJwt: "jwt-old" }) }, { status: 200, body: sessionBody({ accessJwt: "jwt-new" }) }],
      top: [{ status: 401, body: {} }, { status: 200, body: postsBody("t") }],
      latest: [{ status: 401, body: {} }, { status: 200, body: postsBody("l") }],
    });
    const r = await searchBluesky("q", { fetcher, credentials: CREDENTIALS, now: () => 0 });
    expect(r).toHaveLength(2);
    // The refresh is shared: two 401s, still just one extra login.
    expect(calls.filter((c) => c.url === SESSION_URL)).toHaveLength(2);
    expect(sorts(calls)).toEqual(["top", "latest", "top", "latest"]);
  });

  it("gives up on a pass whose retry also 401s, without a third attempt", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { fetcher, calls } = routedFetcher({
      top: [{ status: 401, body: {} }],
      latest: [{ status: 200, body: postsBody("l") }],
    });
    const r = await searchBluesky("q", { fetcher, credentials: CREDENTIALS, now: () => 0 });
    // `top` is dead, but `latest` still delivers.
    expect(r.map((p) => p.id)).toEqual(["at://did:plc:abc123/app.bsky.feed.post/l"]);
    expect(sorts(calls).filter((s) => s === "top")).toHaveLength(2);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
});

describe("searchBluesky — failures degrade to []", () => {
  it("returns [] and warns on a non-ok, non-401 search response", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { fetcher } = scriptedFetcher([{ status: 200, body: sessionBody() }, { status: 500, body: "server error" }]);
    const r = await searchBluesky("q", { fetcher, credentials: CREDENTIALS, now: () => 0 });
    expect(r).toEqual([]);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("returns [] and warns when the fetcher throws", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const throwing: Fetcher = async () => {
      throw new Error("network down");
    };
    const r = await searchBluesky("q", { fetcher: throwing, credentials: CREDENTIALS, now: () => 0 });
    expect(r).toEqual([]);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("returns [] and warns when createBlueskySession itself fails (e.g. bad app password)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { fetcher } = scriptedFetcher([{ status: 401, body: { error: "AuthenticationRequired" } }]);
    const r = await searchBluesky("q", { fetcher, credentials: CREDENTIALS, now: () => 0 });
    expect(r).toEqual([]);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("returns [] on malformed json without throwing", async () => {
    const { fetcher } = scriptedFetcher([{ status: 200, body: sessionBody() }, { status: 200, body: "not json" }]);
    const r = await searchBluesky("q", { fetcher, credentials: CREDENTIALS, now: () => 0 });
    expect(r).toEqual([]);
  });

  it("returns [] when posts is missing from the response", async () => {
    const { fetcher } = scriptedFetcher([{ status: 200, body: sessionBody() }, { status: 200, body: {} }]);
    const r = await searchBluesky("q", { fetcher, credentials: CREDENTIALS, now: () => 0 });
    expect(r).toEqual([]);
  });

  it("never logs the app password or accessJwt in a warning", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
      const joined = args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ");
      expect(joined).not.toContain(CREDENTIALS.appPassword);
      expect(joined).not.toContain("jwt-secret-value");
    });
    const { fetcher } = scriptedFetcher([
      { status: 200, body: sessionBody({ accessJwt: "jwt-secret-value" }) },
      { status: 500, body: "err" },
    ]);
    await searchBluesky("q", { fetcher, credentials: CREDENTIALS, now: () => 0 });
    warn.mockRestore();
  });
});

describe("searchBluesky — top + latest passes", () => {
  it("issues the search twice, sort=top then sort=latest, on ONE session", async () => {
    const { fetcher, calls } = routedFetcher();
    await searchBluesky("ai audio & voice", { fetcher, credentials: CREDENTIALS, now: () => 0, limit: 10 });
    expect(calls.filter((c) => c.url === SESSION_URL)).toHaveLength(1);
    expect(sorts(calls)).toEqual(["top", "latest"]);
    for (const call of calls.filter((c) => c.url !== SESSION_URL)) {
      const url = new URL(call.url);
      expect(url.origin + url.pathname).toBe(SEARCH_URL);
      expect(url.searchParams.get("q")).toBe("ai audio & voice");
      expect(url.searchParams.get("limit")).toBe("10");
      expect(call.init?.signal).toBeInstanceOf(AbortSignal);
    }
  });

  it("merges both passes and dedupes the posts they share, top's order first", async () => {
    const { fetcher } = routedFetcher({
      top: [{ status: 200, body: postsBody("shared", "popular") }],
      latest: [{ status: 200, body: postsBody("shared", "fresh") }],
    });
    const r = await searchBluesky("q", { fetcher, credentials: CREDENTIALS, now: () => 0 });
    expect(r.map((p) => p.url)).toEqual([
      "https://bsky.app/profile/ronin.bsky.social/post/shared",
      "https://bsky.app/profile/ronin.bsky.social/post/popular",
      "https://bsky.app/profile/ronin.bsky.social/post/fresh",
    ]);
  });

  it("caps the MERGED result at limit", async () => {
    const body = (prefix: string) => postsBody(...Array.from({ length: 25 }, (_, i) => `${prefix}${i}`));
    const { fetcher } = routedFetcher({
      top: [{ status: 200, body: body("t") }],
      latest: [{ status: 200, body: body("l") }],
    });
    expect(await searchBluesky("q", { fetcher, credentials: CREDENTIALS, now: () => 0, limit: 50 })).toHaveLength(50);
    resetBlueskyStateForTests();
    expect(await searchBluesky("q", { fetcher, credentials: CREDENTIALS, now: () => 0, limit: 10 })).toHaveLength(10);
  });

  it("returns the surviving pass's posts when the other pass fails, warning once", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { fetcher } = routedFetcher({
      top: [{ status: 500, body: "server error" }],
      latest: [{ status: 200, body: postsBody("fresh") }],
    });
    const r = await searchBluesky("q", { fetcher, credentials: CREDENTIALS, now: () => 0 });
    expect(r.map((p) => p.id)).toEqual(["at://did:plc:abc123/app.bsky.feed.post/fresh"]);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it("returns the surviving pass's posts when the other returns malformed JSON", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { fetcher } = routedFetcher({
      top: [{ status: 200, body: postsBody("popular") }],
      latest: [{ status: 200, body: "not json" }],
    });
    const r = await searchBluesky("q", { fetcher, credentials: CREDENTIALS, now: () => 0 });
    expect(r.map((p) => p.id)).toEqual(["at://did:plc:abc123/app.bsky.feed.post/popular"]);
    warn.mockRestore();
  });

  it("returns [] with one warn only when BOTH passes fail", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { fetcher } = routedFetcher({
      top: [{ status: 500, body: "err" }],
      latest: [{ status: 502, body: "err" }],
    });
    expect(await searchBluesky("q", { fetcher, credentials: CREDENTIALS, now: () => 0 })).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
});
