import { afterEach, describe, expect, it, vi } from "vitest";
import { videoDescriptionFor, youtube, youtubeVideoId } from "@/lib/sources/youtube";
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

// Next.js's global.d.ts augments NodeJS.ProcessEnv with a required NODE_ENV
// field, so a plain `{}`/`{ KEY: "value" }` literal doesn't structurally
// satisfy it — this builds a valid one for tests.
function testEnv(overrides: Partial<NodeJS.ProcessEnv> = {}): NodeJS.ProcessEnv {
  return { NODE_ENV: "test", ...overrides };
}

const ENV = testEnv({ YOUTUBE_API_KEY: "yt-key-123" });

const oneItem = JSON.stringify({
  items: [
    {
      id: { videoId: "dQw4w9WgXcQ" },
      snippet: {
        title: "How to mix a podcast",
        description: "A quick walkthrough of EQ and compression.",
        channelTitle: "Audio Academy",
        publishedAt: "2026-09-01T10:00:00Z",
      },
    },
  ],
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("youtube adapter", () => {
  it("has the expected name/label/tag and requires YOUTUBE_API_KEY", () => {
    expect(youtube.name).toBe("youtube");
    expect(youtube.label).toBe("YouTube");
    expect(youtube.tag).toBe("YT");
    expect(youtube.requiredEnv).toEqual(["YOUTUBE_API_KEY"]);
  });

  it("is disabled without YOUTUBE_API_KEY and makes no fetch call", async () => {
    const fetcher = vi.fn();
    const r = await youtube.search("audio", { fetcher, env: testEnv() });
    expect(r).toEqual({ posts: [], status: "disabled", note: "set YOUTUBE_API_KEY" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("parses items into AdapterPost shape when a key is configured", async () => {
    const r = await youtube.search("podcast mixing", { fetcher: fakeFetch(200, oneItem), env: ENV });
    expect(r.status).toBe("ok");
    expect(r.posts).toEqual([
      {
        id: "dQw4w9WgXcQ",
        url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
        text: "How to mix a podcast — A quick walkthrough of EQ and compression.",
        title: "How to mix a podcast",
        author: "Audio Academy",
        metrics: {},
        createdAt: "2026-09-01T10:00:00Z",
      },
    ]);
  });

  it("falls back to just the title when description is empty", async () => {
    const body = JSON.stringify({
      items: [{ id: { videoId: "abc" }, snippet: { title: "Title only", description: "", channelTitle: "C", publishedAt: null } }],
    });
    const r = await youtube.search("q", { fetcher: fakeFetch(200, body), env: ENV });
    expect(r.posts[0].text).toBe("Title only");
    expect(r.posts[0].createdAt).toBeNull();
  });

  it("truncates text to 600 chars", async () => {
    const body = JSON.stringify({
      items: [{ id: { videoId: "abc" }, snippet: { title: "T", description: "d".repeat(700), channelTitle: "C", publishedAt: null } }],
    });
    const r = await youtube.search("q", { fetcher: fakeFetch(200, body), env: ENV });
    expect(r.posts[0].text).toHaveLength(600);
  });

  it("dedupes items by videoId-derived url", async () => {
    const body = JSON.stringify({
      items: [
        { id: { videoId: "abc" }, snippet: { title: "One", description: "", channelTitle: "C", publishedAt: null } },
        { id: { videoId: "abc" }, snippet: { title: "Two", description: "", channelTitle: "C", publishedAt: null } },
      ],
    });
    const r = await youtube.search("q", { fetcher: fakeFetch(200, body), env: ENV });
    expect(r.posts).toHaveLength(1);
    expect(r.posts[0].title).toBe("One");
  });

  it("builds the request url with part=snippet, type=video, encoded q, order=relevance, and the key", async () => {
    const { fetcher, calls } = spyFetcher(200, JSON.stringify({ items: [] }));
    await youtube.search("ai & audio", { fetcher, limit: 10, env: ENV });
    const url = new URL(calls[0].url);
    expect(url.origin + url.pathname).toBe("https://www.googleapis.com/youtube/v3/search");
    expect(url.searchParams.get("part")).toBe("snippet");
    expect(url.searchParams.get("type")).toBe("video");
    expect(url.searchParams.get("q")).toBe("ai & audio");
    expect(url.searchParams.get("order")).toBe("relevance");
    expect(url.searchParams.get("maxResults")).toBe("10");
    expect(url.searchParams.get("key")).toBe("yt-key-123");
  });

  it("defaults maxResults to 25", async () => {
    const { fetcher, calls } = spyFetcher(200, JSON.stringify({ items: [] }));
    await youtube.search("q", { fetcher, env: ENV });
    expect(new URL(calls[0].url).searchParams.get("maxResults")).toBe("25");
  });

  it("clamps maxResults to YouTube's max of 50", async () => {
    const { fetcher, calls } = spyFetcher(200, JSON.stringify({ items: [] }));
    await youtube.search("q", { fetcher, limit: 200, env: ENV });
    expect(new URL(calls[0].url).searchParams.get("maxResults")).toBe("50");
  });

  it("falls back to process.env when opts.env is omitted", async () => {
    vi.stubEnv("YOUTUBE_API_KEY", "env-key");
    const { fetcher, calls } = spyFetcher(200, JSON.stringify({ items: [] }));
    await youtube.search("q", { fetcher });
    expect(new URL(calls[0].url).searchParams.get("key")).toBe("env-key");
  });

  it("passes an AbortSignal for the 8s timeout", async () => {
    const { fetcher, calls } = spyFetcher(200, JSON.stringify({ items: [] }));
    await youtube.search("q", { fetcher, env: ENV });
    expect(calls[0].init?.signal).toBeInstanceOf(AbortSignal);
  });

  it("returns status error with one console.warn on a non-ok response", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const r = await youtube.search("q", { fetcher: fakeFetch(403, "quota exceeded"), env: ENV });
    expect(r.posts).toEqual([]);
    expect(r.status).toBe("error");
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it("returns status error with one console.warn when the fetcher throws", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const throwing: Fetcher = async () => {
      throw new Error("network down");
    };
    const r = await youtube.search("q", { fetcher: throwing, env: ENV });
    expect(r.posts).toEqual([]);
    expect(r.status).toBe("error");
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it("returns status error with one console.warn on malformed JSON", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const r = await youtube.search("q", { fetcher: fakeFetch(200, "not json"), env: ENV });
    expect(r.status).toBe("error");
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it("returns [] when items is missing from the response", async () => {
    const r = await youtube.search("q", { fetcher: fakeFetch(200, JSON.stringify({})), env: ENV });
    expect(r).toEqual({ posts: [], status: "ok" });
  });
});

describe("full descriptions (2026-09-27: the card's more still ended in ...)", () => {
  const search = JSON.stringify({
    items: [{ id: { videoId: "v1" }, snippet: { title: "From Idea to Exit", description: "Jake Heller is the co-founder of Casetext, acquired by ...", channelTitle: "YC", publishedAt: null } }],
  });
  const videos = JSON.stringify({
    items: [{
      id: "v1",
      snippet: {
        description: "Jake Heller is the co-founder of Casetext, acquired by Thomson Reuters for $650M.\n\nHe talks about the pivot that made it work.\nSubscribe for more!\nhttps://ycombinator.com\n#startups #ai\n\nChapters:\n00:00 Intro\n02:10 The pivot",
      },
    }],
  });
  const routed = (videosStatus = 200): { fetcher: Fetcher; urls: string[] } => {
    const urls: string[] = [];
    const fetcher: Fetcher = async (url) => {
      urls.push(url);
      const isVideos = url.includes("/videos?");
      const status = isVideos ? videosStatus : 200;
      return { ok: status === 200, status, text: async () => (isVideos ? videos : search) };
    };
    return { fetcher, urls };
  };

  it("takes the prose at the top of the full description, without links, hashtags or chapters", async () => {
    const { fetcher, urls } = routed();
    const r = await youtube.search("yc", { fetcher, env: ENV });
    expect(r.posts[0].text).toBe(
      "From Idea to Exit — Jake Heller is the co-founder of Casetext, acquired by Thomson Reuters for $650M. He talks about the pivot that made it work.",
    );
    expect(urls[1]).toContain("/videos?part=snippet&id=v1&key=yt-key-123");
  });

  it("keeps the search's description when the second call fails", async () => {
    const { fetcher } = routed(403);
    const r = await youtube.search("yc", { fetcher, env: ENV });
    expect(r.posts[0].text).toBe("From Idea to Exit — Jake Heller is the co-founder of Casetext, acquired by ...");
  });

  it("cuts a long description after its last whole sentence", async () => {
    const long = JSON.stringify({ items: [{ id: "v1", snippet: { description: `${"A sentence that goes on. ".repeat(40)}` } }] });
    const fetcher: Fetcher = async (url) => ({ ok: true, status: 200, text: async () => (url.includes("/videos?") ? long : search) });
    const text = (await youtube.search("yc", { fetcher, env: ENV })).posts[0].text;
    expect(text.length).toBeLessThanOrEqual(600);
    expect(text.endsWith("goes on.")).toBe(true);
  });
});

describe("a pasted video's id and description (2026-09-27: the fallback without a transcript)", () => {
  it("reads the id from every kind of YouTube link, and nothing else", () => {
    expect(youtubeVideoId("https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=10s")).toBe("dQw4w9WgXcQ");
    expect(youtubeVideoId("https://youtu.be/dQw4w9WgXcQ?si=x")).toBe("dQw4w9WgXcQ");
    expect(youtubeVideoId("https://www.youtube.com/shorts/dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");
    expect(youtubeVideoId("https://m.youtube.com/live/dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");
    expect(youtubeVideoId("https://example.com/watch?v=dQw4w9WgXcQ")).toBeNull();
  });

  it("keeps the description's prose and chapters, drops its links and hashtags", async () => {
    const body = JSON.stringify({ items: [{ id: "abc123", snippet: { description: "How Satispay grew.\nhttps://satispay.com\n#fintech #startup\n00:00 Intro\n05:12 The first merchants" } }] });
    const text = await videoDescriptionFor("https://youtu.be/abc123", "yt-key", fakeFetch(200, body));
    expect(text).toBe("How Satispay grew.\n00:00 Intro\n05:12 The first merchants");
    expect(await videoDescriptionFor("https://youtu.be/abc123", undefined, fakeFetch(200, body))).toBeNull();
    expect(await videoDescriptionFor("https://youtu.be/abc123", "yt-key", fakeFetch(403, ""))).toBeNull();
  });
});
