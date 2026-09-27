import { describe, expect, it, vi } from "vitest";
import { searchHackerNews } from "@/lib/sources/hackernews";
import type { Fetcher } from "@/lib/sources/types";

function fakeFetch(status: number, body: string): Fetcher {
  return async () => ({ ok: status >= 200 && status < 300, status, text: async () => body });
}

function spyFetcher(status: number, body: string): { fetcher: Fetcher; calls: { url: string; init?: RequestInit }[] } {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetcher: Fetcher = async (url, init) => {
    calls.push({ url, init });
    return { ok: status >= 200 && status < 300, status, text: async () => body };
  };
  return { fetcher, calls };
}

const SEARCH = "https://hn.algolia.com/api/v1/search";
const BY_DATE = "https://hn.algolia.com/api/v1/search_by_date";

/**
 * A fetcher that answers per-endpoint rather than one canned response for
 * every call — `pick` sees the parsed url and returns that request's
 * status+body. What the two-endpoint tests need: the point is that relevance
 * and recency return different hits.
 */
function routedFetcher(pick: (url: URL) => { status: number; body: string }): {
  fetcher: Fetcher;
  calls: { url: string; init?: RequestInit }[];
} {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetcher: Fetcher = async (url, init) => {
    calls.push({ url, init });
    const { status, body } = pick(new URL(url));
    return { ok: status >= 200 && status < 300, status, text: async () => body };
  };
  return { fetcher, calls };
}

function hits(...objectIDs: string[]): string {
  return JSON.stringify({ hits: objectIDs.map((objectID) => ({ objectID, title: `story ${objectID}`, points: 1, num_comments: 0, author: "a", created_at: null })) });
}

/** True for the recency endpoint, false for the relevance one. */
function byDate(url: URL): boolean {
  return url.pathname.endsWith("/search_by_date");
}

const oneHit = JSON.stringify({
  hits: [
    {
      objectID: "44123456",
      title: "Show HN: I built a stem separator",
      url: "https://example.com/stem-separator",
      story_text: "<p>It runs <b>locally</b> and is free.</p>",
      points: 88,
      num_comments: 21,
      author: "audiodev",
      created_at: "2026-09-19T08:00:00.000Z",
    },
  ],
});

describe("searchHackerNews", () => {
  it("parses hits into SourcePost shape, linking to the HN item page", async () => {
    const r = await searchHackerNews("audio", { fetcher: fakeFetch(200, oneHit) });
    expect(r).toHaveLength(1);
    expect(r[0]).toEqual({
      id: "44123456",
      source: "hackernews",
      url: "https://news.ycombinator.com/item?id=44123456",
      text: "Show HN: I built a stem separator — It runs locally and is free.",
      author: "audiodev",
      metrics: { likes: 88, replies: 21 },
      createdAt: "2026-09-19T08:00:00.000Z",
    });
  });

  it("uses just the title when story_text is absent", async () => {
    const body = JSON.stringify({
      hits: [{ objectID: "1", title: "Just a link", url: "https://x.com", points: 1, num_comments: 0, author: "a", created_at: "2026-01-01T00:00:00.000Z" }],
    });
    const r = await searchHackerNews("q", { fetcher: fakeFetch(200, body) });
    expect(r[0].text).toBe("Just a link");
  });

  it("truncates story_text to 300 chars after stripping tags", async () => {
    const long = "<p>" + "a".repeat(400) + "</p>";
    const body = JSON.stringify({
      hits: [{ objectID: "1", title: "T", story_text: long, points: 1, num_comments: 0, author: "a", created_at: null }],
    });
    const r = await searchHackerNews("q", { fetcher: fakeFetch(200, body) });
    expect(r[0].text).toBe("T — " + "a".repeat(300));
  });

  it("builds the request url with encoded query, tags=story, and hitsPerPage", async () => {
    const { fetcher, calls } = spyFetcher(200, JSON.stringify({ hits: [] }));
    await searchHackerNews("ai & audio", { fetcher, limit: 10 });
    const url = new URL(calls[0].url);
    expect(url.origin + url.pathname).toBe("https://hn.algolia.com/api/v1/search");
    expect(url.searchParams.get("query")).toBe("ai & audio");
    expect(url.searchParams.get("tags")).toBe("story");
    expect(url.searchParams.get("hitsPerPage")).toBe("10");
  });

  it("defaults limit to 25", async () => {
    const { fetcher, calls } = spyFetcher(200, JSON.stringify({ hits: [] }));
    await searchHackerNews("q", { fetcher });
    expect(new URL(calls[0].url).searchParams.get("hitsPerPage")).toBe("25");
  });

  it("passes an AbortSignal for the 8s timeout", async () => {
    const { fetcher, calls } = spyFetcher(200, JSON.stringify({ hits: [] }));
    await searchHackerNews("q", { fetcher });
    expect(calls[0].init?.signal).toBeInstanceOf(AbortSignal);
  });

  it("maps points/num_comments to likes/replies metrics with no reposts key", async () => {
    const r = await searchHackerNews("audio", { fetcher: fakeFetch(200, oneHit) });
    expect(r[0].metrics).toEqual({ likes: 88, replies: 21 });
  });

  describe("entity decoding (title and story_text)", () => {
    it("decodes html entities in the title, including generic hex and decimal numeric forms", async () => {
      const body = JSON.stringify({
        hits: [{
          objectID: "1",
          title: "Show HN: I&#x27;m building a URL shortener &#8217;for real&#8217; at /a&#x2F;b",
          points: 1, num_comments: 0, author: "a", created_at: null,
        }],
      });
      const r = await searchHackerNews("q", { fetcher: fakeFetch(200, body) });
      expect(r[0].text).toBe("Show HN: I'm building a URL shortener ’for real’ at /a/b");
    });

    it("decodes html entities in story_text alongside stripping tags", async () => {
      const body = JSON.stringify({
        hits: [{
          objectID: "1",
          title: "T",
          story_text: "<p>It&#x27;s free&#x2F;open source &amp; fun</p>",
          points: 1, num_comments: 0, author: "a", created_at: null,
        }],
      });
      const r = await searchHackerNews("q", { fetcher: fakeFetch(200, body) });
      expect(r[0].text).toBe("T — It's free/open source & fun");
    });
  });

  it("returns [] and warns once on a non-ok response", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const r = await searchHackerNews("q", { fetcher: fakeFetch(500, "server error") });
    expect(r).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it("returns [] and warns once when the fetcher throws", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const throwing: Fetcher = async () => { throw new Error("network down"); };
    const r = await searchHackerNews("q", { fetcher: throwing });
    expect(r).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it("returns [] when hits is missing from the response", async () => {
    const r = await searchHackerNews("q", { fetcher: fakeFetch(200, JSON.stringify({})) });
    expect(r).toEqual([]);
  });
});

describe("searchHackerNews — relevance + recency endpoints", () => {
  it("queries both /search and /search_by_date, relevance first, with identical params", async () => {
    const { fetcher, calls } = routedFetcher(() => ({ status: 200, body: hits() }));
    await searchHackerNews("ai & audio", { fetcher, limit: 10 });
    expect(calls).toHaveLength(2);
    expect(calls.map((c) => new URL(c.url).origin + new URL(c.url).pathname)).toEqual([SEARCH, BY_DATE]);
    for (const call of calls) {
      const url = new URL(call.url);
      expect(url.searchParams.get("query")).toBe("ai & audio");
      expect(url.searchParams.get("tags")).toBe("story");
      expect(url.searchParams.get("hitsPerPage")).toBe("10");
      expect(call.init?.signal).toBeInstanceOf(AbortSignal);
    }
  });

  it("merges both endpoints' hits and dedupes by objectID, relevance order first", async () => {
    const { fetcher } = routedFetcher((url) => ({
      status: 200,
      body: byDate(url) ? hits("shared", "fresh") : hits("shared", "popular"),
    }));
    const r = await searchHackerNews("q", { fetcher });
    expect(r.map((p) => p.id)).toEqual(["shared", "popular", "fresh"]);
    expect(r.map((p) => p.url)).toEqual([
      "https://news.ycombinator.com/item?id=shared",
      "https://news.ycombinator.com/item?id=popular",
      "https://news.ycombinator.com/item?id=fresh",
    ]);
  });

  it("caps the MERGED result at limit", async () => {
    const { fetcher } = routedFetcher((url) => ({
      status: 200,
      body: hits(...Array.from({ length: 25 }, (_, i) => `${byDate(url) ? "d" : "s"}${i}`)),
    }));
    expect(await searchHackerNews("q", { fetcher, limit: 50 })).toHaveLength(50);
    expect(await searchHackerNews("q", { fetcher, limit: 10 })).toHaveLength(10);
  });

  it("keeps the relevance endpoint's hits when only search_by_date fails, warning once", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { fetcher } = routedFetcher((url) => (byDate(url) ? { status: 500, body: "boom" } : { status: 200, body: hits("a", "b") }));
    const r = await searchHackerNews("q", { fetcher });
    expect(r.map((p) => p.id)).toEqual(["a", "b"]);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it("keeps the recency endpoint's hits when only /search fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { fetcher } = routedFetcher((url) => (byDate(url) ? { status: 200, body: hits("fresh") } : { status: 429, body: "rate limited" }));
    const r = await searchHackerNews("q", { fetcher });
    expect(r.map((p) => p.id)).toEqual(["fresh"]);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it("keeps the other endpoint's hits when one endpoint returns malformed JSON", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { fetcher } = routedFetcher((url) => (byDate(url) ? { status: 200, body: "not json" } : { status: 200, body: hits("a") }));
    const r = await searchHackerNews("q", { fetcher });
    expect(r.map((p) => p.id)).toEqual(["a"]);
    warn.mockRestore();
  });

  it("returns [] with one warn when BOTH endpoints fail", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { fetcher } = routedFetcher(() => ({ status: 503, body: "down" }));
    expect(await searchHackerNews("q", { fetcher })).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
});
