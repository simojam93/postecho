import { describe, expect, it, vi } from "vitest";
import { x, xPostsPerSearch, xSearchQuery } from "@/lib/sources/x";
import type { Fetcher, SourcePost } from "@/lib/sources/types";

function testEnv(overrides: Partial<NodeJS.ProcessEnv> = {}): NodeJS.ProcessEnv {
  return { NODE_ENV: "test", ...overrides };
}
const ENV = testEnv({ X_BEARER_TOKEN: "token-abc", X_POSTS_PER_SEARCH: "20" });

function spyFetcher(responses: Array<{ status: number; body: unknown }>): { fetcher: Fetcher; calls: { url: string; init?: RequestInit }[] } {
  const calls: { url: string; init?: RequestInit }[] = [];
  let i = 0;
  const fetcher: Fetcher = async (url, init) => {
    calls.push({ url, init });
    const r = responses[Math.min(i++, responses.length - 1)];
    return { ok: r.status >= 200 && r.status < 300, status: r.status, text: async () => JSON.stringify(r.body) };
  };
  return { fetcher, calls };
}

const tweets = {
  data: [
    {
      id: "1840000000000000001",
      text: "Computer use agents are finally clicking the right buttons. The trick was…",
      note_tweet: { text: "Computer use agents are finally clicking the right buttons. The trick was a smaller action space and a screenshot diff." },
      author_id: "111",
      created_at: "2026-09-23T10:00:00.000Z",
      public_metrics: { like_count: 120, retweet_count: 10, quote_count: 5, reply_count: 8 },
    },
    { id: "1840000000000000002", text: "Agents that use a browser need undo.", author_id: "222" },
    { id: "not-a-number", text: "dropped" },
    { id: "1840000000000000003", text: "   " },
  ],
  meta: { result_count: 4 },
};

describe("xSearchQuery", () => {
  it("keeps the words only, so nothing typed becomes an X operator, and asks for original English posts", () => {
    expect(xSearchQuery("computer use agents")).toBe("computer use agents -is:retweet -is:reply lang:en");
    expect(xSearchQuery("from:elon OR -spam \"agents\"")).toBe("from elon or spam agents -is:retweet -is:reply lang:en");
    expect(xSearchQuery("  ?! ")).toBeNull();
  });
});

describe("xPostsPerSearch", () => {
  it("defaults to 20 and stays within what the API accepts", () => {
    expect(xPostsPerSearch(testEnv())).toBe(20);
    expect(xPostsPerSearch(testEnv({ X_POSTS_PER_SEARCH: "5" }))).toBe(10);
    expect(xPostsPerSearch(testEnv({ X_POSTS_PER_SEARCH: "500" }))).toBe(100);
    expect(xPostsPerSearch(testEnv({ X_POSTS_PER_SEARCH: "35" }))).toBe(35);
  });
});

describe("x.search", () => {
  it("is off without a key, and never calls X then", async () => {
    const { fetcher, calls } = spyFetcher([{ status: 200, body: tweets }]);
    const r = await x.search("agents", { fetcher, env: testEnv() });
    expect(r.status).toBe("disabled");
    expect(calls).toHaveLength(0);
  });

  it("reads recent search with the owner's key, at most `limit` posts, relevance-sorted", async () => {
    const { fetcher, calls } = spyFetcher([{ status: 200, body: tweets }]);
    await x.search("computer use agents", { fetcher, env: ENV, limit: 14 });
    expect(calls).toHaveLength(1);
    const url = new URL(calls[0].url);
    expect(url.origin + url.pathname).toBe("https://api.x.com/2/tweets/search/recent");
    expect(url.searchParams.get("query")).toBe("computer use agents -is:retweet -is:reply lang:en");
    expect(url.searchParams.get("max_results")).toBe("14");
    expect(url.searchParams.get("sort_order")).toBe("relevancy");
    expect(url.searchParams.get("tweet.fields")).toBe("created_at,public_metrics,author_id,note_tweet");
    expect(url.searchParams.has("expansions")).toBe(false); // authors are looked up after the pick, not per search
    expect((calls[0].init?.headers as Record<string, string>).Authorization).toBe("Bearer token-abc");
  });

  it("never asks for fewer than 10 or more than 100 (the API's own bounds)", async () => {
    const { fetcher, calls } = spyFetcher([{ status: 200, body: { data: [] } }]);
    await x.search("a b", { fetcher, env: ENV, limit: 3 });
    await x.search("a b", { fetcher, env: ENV, limit: 400 });
    expect(calls.map((c) => new URL(c.url).searchParams.get("max_results"))).toEqual(["10", "100"]);
  });

  it("maps posts: the long text when there is one, metrics, the author-less permalink, the author id for later", async () => {
    const { fetcher } = spyFetcher([{ status: 200, body: tweets }]);
    const r = await x.search("agents", { fetcher, env: ENV });
    expect(r.status).toBe("ok");
    expect(r.posts).toHaveLength(2);
    expect(r.posts[0]).toEqual({
      id: "1840000000000000001",
      url: "https://x.com/i/status/1840000000000000001",
      text: "Computer use agents are finally clicking the right buttons. The trick was a smaller action space and a screenshot diff.",
      title: null,
      author: null,
      authorId: "111",
      metrics: { likes: 120, reposts: 15, replies: 8 },
      createdAt: "2026-09-23T10:00:00.000Z",
    });
    expect(r.posts[1].metrics).toEqual({ likes: undefined, reposts: undefined, replies: undefined });
  });

  it("a refused key or spent credits come back as an error the owner can act on", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    for (const [status, text] of [[401, "rejected the key"], [402, "payment"], [403, "refused"], [429, "too many requests"]] as const) {
      const { fetcher } = spyFetcher([{ status, body: { title: "x" } }]);
      const r = await x.search("agents", { fetcher, env: ENV });
      expect(r.status).toBe("error");
      expect(r.note).toContain(text);
    }
    warn.mockRestore();
  });
});

describe("x.finalizePicked", () => {
  const picked: SourcePost[] = [
    { id: "x_post:1840000000000000001", source: "x_post", url: "https://x.com/i/status/1840000000000000001", text: "a", author: null, authorId: "111", metrics: {}, createdAt: null },
    { id: "x_post:1840000000000000002", source: "x_post", url: "https://x.com/i/status/1840000000000000002", text: "b", author: null, authorId: "222", metrics: {}, createdAt: null },
    { id: "x_post:1840000000000000004", source: "x_post", url: "https://x.com/i/status/1840000000000000004", text: "c", author: null, authorId: "111", metrics: {}, createdAt: null },
  ];

  it("looks every distinct author up in one call and gives the posts their @handle and canonical url", async () => {
    const { fetcher, calls } = spyFetcher([{ status: 200, body: { data: [{ id: "111", username: "karpathy", name: "Andrej" }, { id: "222", username: "bad handle!" }] } }]);
    const out = await x.finalizePicked!(picked, { fetcher, env: ENV });
    expect(calls).toHaveLength(1);
    const url = new URL(calls[0].url);
    expect(url.pathname).toBe("/2/users");
    expect(url.searchParams.get("ids")).toBe("111,222");
    expect(out[0]).toMatchObject({ author: "@karpathy", url: "https://x.com/karpathy/status/1840000000000000001" });
    expect(out[1]).toMatchObject({ author: null, url: "https://x.com/i/status/1840000000000000002" }); // an invalid username is not trusted
    expect(out[2]).toMatchObject({ author: "@karpathy", url: "https://x.com/karpathy/status/1840000000000000004" });
  });

  it("leaves the posts as they were when the lookup fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { fetcher } = spyFetcher([{ status: 429, body: {} }]);
    expect(await x.finalizePicked!(picked, { fetcher, env: ENV })).toEqual(picked);
    warn.mockRestore();
  });
});
