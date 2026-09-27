import { afterEach, describe, expect, it, vi } from "vitest";
import { envReady } from "@/lib/sources/adapter";
import { github } from "@/lib/sources/github";
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

function headers(call: { init?: RequestInit } | undefined): Record<string, string> {
  return (call?.init?.headers as Record<string, string> | undefined) ?? {};
}

// Next.js's global.d.ts augments NodeJS.ProcessEnv with a required NODE_ENV
// field, so a plain `{}`/`{ KEY: "value" }` literal doesn't structurally
// satisfy it — this builds a valid one for tests.
function testEnv(overrides: Partial<NodeJS.ProcessEnv> = {}): NodeJS.ProcessEnv {
  return { NODE_ENV: "test", ...overrides };
}

const oneItem = JSON.stringify({
  total_count: 434135,
  incomplete_results: false,
  items: [
    {
      id: 307260205,
      full_name: "yt-dlp/yt-dlp",
      html_url: "https://github.com/yt-dlp/yt-dlp",
      description: "A feature-rich command-line audio/video downloader",
      stargazers_count: 192554,
      forks_count: 16715,
      owner: { login: "yt-dlp" },
      pushed_at: "2026-09-16T07:48:51Z",
    },
  ],
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("github adapter", () => {
  it("has the expected name/label/tag and no required env (token is optional)", () => {
    expect(github.name).toBe("github");
    expect(github.label).toBe("GitHub");
    expect(github.tag).toBe("GH");
    expect(envReady(github, testEnv())).toBe(true);
  });

  it("parses items into AdapterPost shape", async () => {
    const r = await github.search("audio", { fetcher: fakeFetch(200, oneItem), env: testEnv() });
    expect(r.status).toBe("ok");
    expect(r.posts).toEqual([
      {
        id: "307260205",
        url: "https://github.com/yt-dlp/yt-dlp",
        text: "yt-dlp/yt-dlp — A feature-rich command-line audio/video downloader",
        title: "yt-dlp/yt-dlp",
        author: "yt-dlp",
        metrics: { likes: 192554, reposts: 16715 },
        createdAt: "2026-09-16T07:48:51Z",
      },
    ]);
  });

  it("falls back to just full_name when description is null", async () => {
    const body = JSON.stringify({
      items: [{ id: 1, full_name: "a/b", html_url: "https://github.com/a/b", description: null, stargazers_count: 0, forks_count: 0, owner: { login: "a" }, pushed_at: null }],
    });
    const r = await github.search("q", { fetcher: fakeFetch(200, body), env: testEnv() });
    expect(r.posts[0].text).toBe("a/b");
    expect(r.posts[0].createdAt).toBeNull();
  });

  it("truncates text to 600 chars", async () => {
    const body = JSON.stringify({
      items: [{ id: 1, full_name: "a/b", html_url: "https://github.com/a/b", description: "d".repeat(700), stargazers_count: 0, forks_count: 0, owner: { login: "a" }, pushed_at: null }],
    });
    const r = await github.search("q", { fetcher: fakeFetch(200, body), env: testEnv() });
    expect(r.posts[0].text).toHaveLength(600);
  });

  it("dedupes items by html_url", async () => {
    const body = JSON.stringify({
      items: [
        { id: 1, full_name: "a/b", html_url: "https://github.com/a/b", description: "one", stargazers_count: 1, forks_count: 0, owner: { login: "a" }, pushed_at: null },
        { id: 2, full_name: "a/b-mirror", html_url: "https://github.com/a/b", description: "two", stargazers_count: 2, forks_count: 0, owner: { login: "a" }, pushed_at: null },
      ],
    });
    const r = await github.search("q", { fetcher: fakeFetch(200, body), env: testEnv() });
    expect(r.posts).toHaveLength(1);
    expect(r.posts[0].text).toBe("a/b — one");
  });

  it("builds the request url with encoded query, sort=stars, order=desc, per_page", async () => {
    const { fetcher, calls } = spyFetcher(200, JSON.stringify({ items: [] }));
    await github.search("ai & audio", { fetcher, limit: 10, env: testEnv() });
    const url = new URL(calls[0].url);
    expect(url.origin + url.pathname).toBe("https://api.github.com/search/repositories");
    expect(url.searchParams.get("q")).toBe("ai & audio");
    expect(url.searchParams.get("sort")).toBe("stars");
    expect(url.searchParams.get("order")).toBe("desc");
    expect(url.searchParams.get("per_page")).toBe("10");
  });

  it("defaults limit (per_page) to 25", async () => {
    const { fetcher, calls } = spyFetcher(200, JSON.stringify({ items: [] }));
    await github.search("q", { fetcher, env: testEnv() });
    expect(new URL(calls[0].url).searchParams.get("per_page")).toBe("25");
  });

  it("always sends Accept and User-Agent headers", async () => {
    const { fetcher, calls } = spyFetcher(200, JSON.stringify({ items: [] }));
    await github.search("q", { fetcher, env: testEnv() });
    expect(headers(calls[0]).Accept).toBe("application/vnd.github+json");
    expect(headers(calls[0])["User-Agent"]).toBe("PostEcho");
  });

  it("adds a Bearer Authorization header when GITHUB_TOKEN is set", async () => {
    const { fetcher, calls } = spyFetcher(200, JSON.stringify({ items: [] }));
    await github.search("q", { fetcher, env: testEnv({ GITHUB_TOKEN: "ghp_secret" }) });
    expect(headers(calls[0]).Authorization).toBe("Bearer ghp_secret");
  });

  it("omits the Authorization header when GITHUB_TOKEN is unset (unauthenticated, still works)", async () => {
    const { fetcher, calls } = spyFetcher(200, JSON.stringify({ items: [] }));
    await github.search("q", { fetcher, env: testEnv() });
    expect(headers(calls[0]).Authorization).toBeUndefined();
  });

  it("falls back to process.env when opts.env is omitted", async () => {
    vi.stubEnv("GITHUB_TOKEN", "env-token");
    const { fetcher, calls } = spyFetcher(200, JSON.stringify({ items: [] }));
    await github.search("q", { fetcher });
    expect(headers(calls[0]).Authorization).toBe("Bearer env-token");
  });

  it("passes an AbortSignal for the 8s timeout", async () => {
    const { fetcher, calls } = spyFetcher(200, JSON.stringify({ items: [] }));
    await github.search("q", { fetcher, env: testEnv() });
    expect(calls[0].init?.signal).toBeInstanceOf(AbortSignal);
  });

  it("returns status error with one console.warn on a non-ok response", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const r = await github.search("q", { fetcher: fakeFetch(403, "rate limited"), env: testEnv() });
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
    const r = await github.search("q", { fetcher: throwing, env: testEnv() });
    expect(r.posts).toEqual([]);
    expect(r.status).toBe("error");
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it("returns status error with one console.warn on malformed JSON", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const r = await github.search("q", { fetcher: fakeFetch(200, "not json"), env: testEnv() });
    expect(r.posts).toEqual([]);
    expect(r.status).toBe("error");
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it("returns [] when items is missing from the response", async () => {
    const r = await github.search("q", { fetcher: fakeFetch(200, JSON.stringify({})), env: testEnv() });
    expect(r).toEqual({ posts: [], status: "ok" });
  });
});
