import { afterEach, describe, expect, it, vi } from "vitest";
import { producthunt } from "@/lib/sources/producthunt";
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

function header(call: { init?: RequestInit } | undefined, name: string): string | undefined {
  return (call?.init?.headers as Record<string, string> | undefined)?.[name];
}

// Next.js's global.d.ts augments NodeJS.ProcessEnv with a required NODE_ENV
// field, so a plain `{}`/`{ KEY: "value" }` literal doesn't structurally
// satisfy it — this builds a valid one for tests.
function testEnv(overrides: Partial<NodeJS.ProcessEnv> = {}): NodeJS.ProcessEnv {
  return { NODE_ENV: "test", ...overrides };
}

const ENV = testEnv({ PRODUCTHUNT_TOKEN: "ph-token-123" });

function graphqlBody(nodes: unknown[]) {
  return { data: { posts: { edges: nodes.map((node) => ({ node })) } } };
}

const twoPosts = graphqlBody([
  {
    id: "1",
    name: "PodMixer",
    tagline: "AI audio mastering for podcasters",
    description: "Automatically clean up and master your podcast audio.",
    slug: "podmixer",
    votesCount: 312,
    commentsCount: 24,
    createdAt: "2026-09-10T08:00:00Z",
  },
  {
    id: "2",
    name: "TaskFlow",
    tagline: "Project management for small teams",
    description: "Kanban boards and sprints without the bloat.",
    slug: "taskflow",
    votesCount: 900,
    commentsCount: 50,
    createdAt: "2026-09-11T08:00:00Z",
  },
]);

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("producthunt adapter", () => {
  it("has the expected name/label/tag and requires PRODUCTHUNT_TOKEN", () => {
    expect(producthunt.name).toBe("producthunt");
    expect(producthunt.label).toBe("Product Hunt");
    expect(producthunt.tag).toBe("PH");
    expect(producthunt.requiredEnv).toEqual(["PRODUCTHUNT_TOKEN"]);
  });

  it("is disabled without PRODUCTHUNT_TOKEN and makes no fetch call", async () => {
    const fetcher = vi.fn();
    const r = await producthunt.search("audio", { fetcher, env: testEnv() });
    expect(r).toEqual({ posts: [], status: "disabled", note: "set PRODUCTHUNT_TOKEN" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("POSTs a GraphQL query with a Bearer token and JSON content type", async () => {
    const { fetcher, calls } = spyFetcher(200, JSON.stringify(graphqlBody([])));
    await producthunt.search("audio", { fetcher, env: ENV });
    expect(calls[0].url).toBe("https://api.producthunt.com/v2/api/graphql");
    expect(calls[0].init?.method).toBe("POST");
    expect(header(calls[0], "Authorization")).toBe("Bearer ph-token-123");
    expect(header(calls[0], "Content-Type")).toBe("application/json");
    const parsedBody = JSON.parse(calls[0].init?.body as string);
    expect(typeof parsedBody.query).toBe("string");
    expect(parsedBody.query).toContain("posts");
  });

  it("filters client-side to posts whose name/tagline/description match a query token, mapping matches to AdapterPost shape", async () => {
    const r = await producthunt.search("audio", { fetcher: fakeFetch(200, JSON.stringify(twoPosts)), env: ENV });
    expect(r.status).toBe("ok");
    expect(r.posts).toEqual([
      {
        id: "1",
        url: "https://www.producthunt.com/posts/podmixer",
        text: "PodMixer — AI audio mastering for podcasters",
        title: "PodMixer",
        author: null,
        metrics: { likes: 312, replies: 24 },
        createdAt: "2026-09-10T08:00:00Z",
      },
    ]);
  });

  it("matches on any query token (OR), not requiring every token to be present", async () => {
    const r = await producthunt.search("audio teams", { fetcher: fakeFetch(200, JSON.stringify(twoPosts)), env: ENV });
    expect(r.posts.map((p) => p.title).sort()).toEqual(["PodMixer", "TaskFlow"]);
  });

  it("matches case-insensitively against description when tagline doesn't match", async () => {
    const body = graphqlBody([
      { id: "1", name: "Whisperize", tagline: "Meeting notes, instantly", description: "Transcribes and summarizes AUDIO calls.", slug: "whisperize", votesCount: 10, commentsCount: 1, createdAt: null },
    ]);
    const r = await producthunt.search("audio", { fetcher: fakeFetch(200, JSON.stringify(body)), env: ENV });
    expect(r.posts).toHaveLength(1);
  });

  it("falls back to description when tagline is empty", async () => {
    const body = graphqlBody([
      { id: "1", name: "Match", tagline: "", description: "An audio thing.", slug: "match", votesCount: 0, commentsCount: 0, createdAt: null },
    ]);
    const r = await producthunt.search("audio", { fetcher: fakeFetch(200, JSON.stringify(body)), env: ENV });
    expect(r.posts[0].text).toBe("Match — An audio thing.");
  });

  it("truncates text to 600 chars", async () => {
    const body = graphqlBody([
      { id: "1", name: "Match", tagline: "audio " + "d".repeat(700), description: "", slug: "match", votesCount: 0, commentsCount: 0, createdAt: null },
    ]);
    const r = await producthunt.search("audio", { fetcher: fakeFetch(200, JSON.stringify(body)), env: ENV });
    expect(r.posts[0].text).toHaveLength(600);
  });

  it("dedupes matching posts by url", async () => {
    const body = graphqlBody([
      { id: "1", name: "Audio One", tagline: "audio tool", description: "", slug: "same-slug", votesCount: 1, commentsCount: 0, createdAt: null },
      { id: "2", name: "Audio Two", tagline: "audio tool", description: "", slug: "same-slug", votesCount: 2, commentsCount: 0, createdAt: null },
    ]);
    const r = await producthunt.search("audio", { fetcher: fakeFetch(200, JSON.stringify(body)), env: ENV });
    expect(r.posts).toHaveLength(1);
  });

  it("caps the returned (matched) posts at the requested limit", async () => {
    const nodes = Array.from({ length: 5 }, (_, i) => ({
      id: String(i), name: `Audio Tool ${i}`, tagline: "audio", description: "", slug: `slug-${i}`, votesCount: i, commentsCount: 0, createdAt: null,
    }));
    const r = await producthunt.search("audio", { fetcher: fakeFetch(200, JSON.stringify(graphqlBody(nodes))), env: ENV, limit: 2 });
    expect(r.posts).toHaveLength(2);
  });

  it("requests a fixed pool of 50 recent top posts regardless of the requested limit", async () => {
    const { fetcher, calls } = spyFetcher(200, JSON.stringify(graphqlBody([])));
    await producthunt.search("audio", { fetcher, env: ENV, limit: 5 });
    const parsedBody = JSON.parse(calls[0].init?.body as string);
    expect(parsedBody.query).toContain("50");
  });

  it("falls back to process.env when opts.env is omitted", async () => {
    vi.stubEnv("PRODUCTHUNT_TOKEN", "env-token");
    const { fetcher, calls } = spyFetcher(200, JSON.stringify(graphqlBody([])));
    await producthunt.search("audio", { fetcher });
    expect(header(calls[0], "Authorization")).toBe("Bearer env-token");
  });

  it("passes an AbortSignal for the 8s timeout", async () => {
    const { fetcher, calls } = spyFetcher(200, JSON.stringify(graphqlBody([])));
    await producthunt.search("audio", { fetcher, env: ENV });
    expect(calls[0].init?.signal).toBeInstanceOf(AbortSignal);
  });

  it("returns status error with one console.warn on a non-ok response", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const r = await producthunt.search("audio", { fetcher: fakeFetch(401, "unauthorized"), env: ENV });
    expect(r.posts).toEqual([]);
    expect(r.status).toBe("error");
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it("returns status error with one console.warn on a GraphQL-level error in a 200 response", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const r = await producthunt.search("audio", {
      fetcher: fakeFetch(200, JSON.stringify({ errors: [{ message: "invalid token" }] })),
      env: ENV,
    });
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
    const r = await producthunt.search("audio", { fetcher: throwing, env: ENV });
    expect(r.posts).toEqual([]);
    expect(r.status).toBe("error");
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it("returns status error with one console.warn on malformed JSON", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const r = await producthunt.search("audio", { fetcher: fakeFetch(200, "not json"), env: ENV });
    expect(r.status).toBe("error");
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it("returns [] when no posts match any query token", async () => {
    const r = await producthunt.search("nomatchxyz", { fetcher: fakeFetch(200, JSON.stringify(twoPosts)), env: ENV });
    expect(r).toEqual({ posts: [], status: "ok" });
  });

  it("returns [] when edges is missing from the response", async () => {
    const r = await producthunt.search("audio", { fetcher: fakeFetch(200, JSON.stringify({ data: { posts: {} } })), env: ENV });
    expect(r).toEqual({ posts: [], status: "ok" });
  });
});
