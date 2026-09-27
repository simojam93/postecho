import { describe, expect, it, vi } from "vitest";
import { devto } from "@/lib/sources/devto";
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

const oneArticle = JSON.stringify([
  {
    type_of: "article",
    id: 4567243,
    title: "How I built my own set of audio plugins with JUCE",
    description: "A build log on six VST3 plugins written in C++ with JUCE 8.",
    url: "https://dev.to/lluisestape/how-i-built-my-own-set-of-audio-plugins-with-juce-4i2b",
    comments_count: 3,
    positive_reactions_count: 42,
    published_at: "2026-09-05T12:51:47Z",
    user: { name: "Lluis Estape", username: "lluisestape" },
  },
]);

describe("devto adapter", () => {
  it("has the expected name/label/tag and no required env", () => {
    expect(devto.name).toBe("devto");
    expect(devto.label).toBe("dev.to");
    expect(devto.tag).toBe("DEV");
    expect(devto.requiredEnv ?? []).toEqual([]);
  });

  it("parses articles into AdapterPost shape", async () => {
    const r = await devto.search("audio", { fetcher: fakeFetch(200, oneArticle) });
    expect(r.status).toBe("ok");
    expect(r.posts).toEqual([
      {
        id: "4567243",
        url: "https://dev.to/lluisestape/how-i-built-my-own-set-of-audio-plugins-with-juce-4i2b",
        text: "How I built my own set of audio plugins with JUCE — A build log on six VST3 plugins written in C++ with JUCE 8.",
        title: "How I built my own set of audio plugins with JUCE",
        author: "lluisestape",
        metrics: { likes: 42, replies: 3 },
        createdAt: "2026-09-05T12:51:47Z",
      },
    ]);
  });

  it("falls back to just the title when description is empty", async () => {
    const body = JSON.stringify([
      { id: 1, title: "Just a title", description: "", url: "https://dev.to/a/b", comments_count: 0, positive_reactions_count: 0, published_at: null, user: { username: "a" } },
    ]);
    const r = await devto.search("q", { fetcher: fakeFetch(200, body) });
    expect(r.posts[0].text).toBe("Just a title");
    expect(r.posts[0].createdAt).toBeNull();
  });

  it("truncates text to 600 chars", async () => {
    const body = JSON.stringify([
      { id: 1, title: "T", description: "d".repeat(700), url: "https://dev.to/a/b", comments_count: 0, positive_reactions_count: 0, published_at: null, user: { username: "a" } },
    ]);
    const r = await devto.search("q", { fetcher: fakeFetch(200, body) });
    expect(r.posts[0].text).toHaveLength(600);
  });

  it("dedupes articles by url", async () => {
    const body = JSON.stringify([
      { id: 1, title: "One", description: "", url: "https://dev.to/a/b", comments_count: 0, positive_reactions_count: 0, published_at: null, user: { username: "a" } },
      { id: 2, title: "Two", description: "", url: "https://dev.to/a/b", comments_count: 0, positive_reactions_count: 0, published_at: null, user: { username: "a" } },
    ]);
    const r = await devto.search("q", { fetcher: fakeFetch(200, body) });
    expect(r.posts).toHaveLength(1);
    expect(r.posts[0].title).toBe("One");
  });

  it("builds the request url from the first query token, lowercased and alnum-only, as the tag", async () => {
    const { fetcher, calls } = spyFetcher(200, "[]");
    await devto.search("Audio-Production tips", { fetcher, limit: 10 });
    const url = new URL(calls[0].url);
    expect(url.origin + url.pathname).toBe("https://dev.to/api/articles");
    expect(url.searchParams.get("tag")).toBe("audioproduction");
    expect(url.searchParams.get("top")).toBe("30");
    expect(url.searchParams.get("per_page")).toBe("10");
  });

  it("defaults limit (per_page) to 25", async () => {
    const { fetcher, calls } = spyFetcher(200, "[]");
    await devto.search("audio", { fetcher });
    expect(new URL(calls[0].url).searchParams.get("per_page")).toBe("25");
  });

  it("passes an AbortSignal for the 8s timeout", async () => {
    const { fetcher, calls } = spyFetcher(200, "[]");
    await devto.search("audio", { fetcher });
    expect(calls[0].init?.signal).toBeInstanceOf(AbortSignal);
  });

  it("returns status error with one console.warn on a non-ok response", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const r = await devto.search("q", { fetcher: fakeFetch(500, "server error") });
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
    const r = await devto.search("q", { fetcher: throwing });
    expect(r.posts).toEqual([]);
    expect(r.status).toBe("error");
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it("returns status error with one console.warn on malformed JSON", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const r = await devto.search("q", { fetcher: fakeFetch(200, "not json") });
    expect(r.status).toBe("error");
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it("returns [] when the response is not an array", async () => {
    const r = await devto.search("q", { fetcher: fakeFetch(200, JSON.stringify({})) });
    expect(r).toEqual({ posts: [], status: "ok" });
  });
});
