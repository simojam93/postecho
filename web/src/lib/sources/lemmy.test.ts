import { afterEach, describe, expect, it, vi } from "vitest";
import { lemmy } from "@/lib/sources/lemmy";
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

/**
 * A fetcher that answers per-request rather than one canned response for
 * every call — `pick` sees the parsed url (host, sort, params) and returns
 * that request's status+body. What the fan-out tests need: the whole point
 * is that different instances and sorts answer differently.
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

/** "<host>?<sort>" for each call — the shape the fan-out assertions compare against. */
function requested(calls: { url: string }[]): string[] {
  return calls.map((c) => {
    const u = new URL(c.url);
    return `${u.host}?${u.searchParams.get("sort")}`;
  });
}

const DEFAULT_HOSTS = ["lemmy.world", "lemmy.ml", "sh.itjust.works", "programming.dev"];

// Next.js's global.d.ts augments NodeJS.ProcessEnv with a required NODE_ENV
// field, so a plain `{}`/`{ KEY: "value" }` literal doesn't structurally
// satisfy it — this builds a valid one for tests.
function testEnv(overrides: Partial<NodeJS.ProcessEnv> = {}): NodeJS.ProcessEnv {
  return { NODE_ENV: "test", ...overrides };
}

// Shaped like a real lemmy.world /api/v3/search post view (2026-09-22),
// trimmed to the fields that matter.
function view(overrides: {
  post?: Record<string, unknown>;
  creator?: Record<string, unknown>;
  counts?: Record<string, unknown>;
} = {}) {
  return {
    post: {
      id: 8249046,
      name: "Show HN: SvelteKit SaaS Boilerplate to help launch your product fast",
      url: "https://news.ycombinator.com/item?id=38264034",
      body: "Hi HN!\n\nI am a indie hacker and love building apps with SvelteKit, so I built a boilerplate.",
      ap_id: "https://derp.foo/post/400311",
      published: "2023-11-14T15:20:03.942140Z",
      nsfw: false,
      removed: false,
      deleted: false,
      ...overrides.post,
    },
    creator: { id: 1, name: "haxor", actor_id: "https://derp.foo/u/haxor", ...overrides.creator },
    counts: { post_id: 8249046, comments: 0, score: 2, upvotes: 3, downvotes: 1, ...overrides.counts },
  };
}

function response(posts: unknown[]): string {
  return JSON.stringify({ type_: "Posts", comments: [], posts, communities: [], users: [] });
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("lemmy adapter", () => {
  it("has the expected name/label/tag and no required env (LEMMY_INSTANCE is optional)", () => {
    expect(lemmy.name).toBe("lemmy");
    expect(lemmy.label).toBe("Lemmy");
    expect(lemmy.tag).toBe("LEM");
    expect(lemmy.requiredEnv ?? []).toEqual([]);
  });

  it("parses post views into AdapterPost shape, linking to the post's url", async () => {
    const r = await lemmy.search("indie saas", { fetcher: fakeFetch(200, response([view()])), env: testEnv() });
    expect(r.status).toBe("ok");
    expect(r.posts).toEqual([
      {
        id: "8249046",
        url: "https://news.ycombinator.com/item?id=38264034",
        text: "Show HN: SvelteKit SaaS Boilerplate to help launch your product fast — Hi HN!\n\nI am a indie hacker and love building apps with SvelteKit, so I built a boilerplate.",
        title: "Show HN: SvelteKit SaaS Boilerplate to help launch your product fast",
        author: "haxor",
        metrics: { likes: 2, replies: 0 },
        createdAt: "2023-11-14T15:20:03.942140Z",
      },
    ]);
  });

  it("links a text post (no url) to its ap_id", async () => {
    const textPost = view({ post: { url: undefined } });
    const r = await lemmy.search("q", { fetcher: fakeFetch(200, response([textPost])), env: testEnv() });
    expect(r.posts[0].url).toBe("https://derp.foo/post/400311");
  });

  it("uses just the title when the body is empty, and null createdAt when published is missing", async () => {
    const bare = view({ post: { body: undefined, published: undefined } });
    const r = await lemmy.search("q", { fetcher: fakeFetch(200, response([bare])), env: testEnv() });
    expect(r.posts[0].text).toBe("Show HN: SvelteKit SaaS Boilerplate to help launch your product fast");
    expect(r.posts[0].createdAt).toBeNull();
  });

  it("caps the body at 500 chars and the whole text at 600", async () => {
    const longBody = view({ post: { id: 1, name: "T", body: "b".repeat(700), url: "https://x.example/1" } });
    const longTitle = view({ post: { id: 2, name: "t".repeat(500), body: "b".repeat(700), url: "https://x.example/2" } });
    const r = await lemmy.search("q", { fetcher: fakeFetch(200, response([longBody, longTitle])), env: testEnv() });
    // Cut texts end in "…" (2026-09-27): the body where it was capped, the whole text at its last word.
    expect(r.posts[0].text).toBe("T — " + "b".repeat(499) + "…");
    expect(r.posts[1].text.length).toBeLessThanOrEqual(600);
    expect(r.posts[1].text.endsWith("…")).toBe(true);
  });

  it("skips nsfw, removed and deleted posts", async () => {
    const posts = [
      view({ post: { id: 1, nsfw: true, url: "https://x.example/1" } }),
      view({ post: { id: 2, removed: true, url: "https://x.example/2" } }),
      view({ post: { id: 3, deleted: true, url: "https://x.example/3" } }),
      view({ post: { id: 4, url: "https://x.example/4" } }),
    ];
    const r = await lemmy.search("q", { fetcher: fakeFetch(200, response(posts)), env: testEnv() });
    expect(r.posts.map((p) => p.id)).toEqual(["4"]);
  });

  it("drops views missing a post id or name", async () => {
    const posts = [
      view({ post: { id: undefined, url: "https://x.example/1" } }),
      view({ post: { id: 2, name: undefined, url: "https://x.example/2" } }),
      view({ post: { id: 3, url: "https://x.example/3" } }),
      { creator: { name: "orphan" }, counts: {} },
    ];
    const r = await lemmy.search("q", { fetcher: fakeFetch(200, response(posts)), env: testEnv() });
    expect(r.posts.map((p) => p.id)).toEqual(["3"]);
  });

  it("dedupes posts by url", async () => {
    const posts = [view({ post: { id: 1 }, counts: { score: 9 } }), view({ post: { id: 2 }, counts: { score: 1 } })];
    const r = await lemmy.search("q", { fetcher: fakeFetch(200, response(posts)), env: testEnv() });
    expect(r.posts).toHaveLength(1);
    expect(r.posts[0].id).toBe("1");
  });

  it("builds the first request on lemmy.world by default: posts search, TopAll, all communities", async () => {
    const { fetcher, calls } = spyFetcher(200, response([]));
    await lemmy.search("indie saas", { fetcher, limit: 10, env: testEnv() });
    const url = new URL(calls[0].url);
    expect(url.origin + url.pathname).toBe("https://lemmy.world/api/v3/search");
    expect(url.searchParams.get("q")).toBe("indie saas");
    expect(url.searchParams.get("type_")).toBe("Posts");
    // TopAll leads: TopMonth returned nothing at all for a niche query on
    // every instance tried (2026-09-22), so it cannot be the first ask.
    expect(url.searchParams.get("sort")).toBe("TopAll");
    expect(url.searchParams.get("listing_type")).toBe("All");
    expect(url.searchParams.get("limit")).toBe("10");
  });

  it("queries the same instance on TopMonth too, right after TopAll", async () => {
    const { fetcher, calls } = spyFetcher(200, response([]));
    await lemmy.search("indie saas", { fetcher, env: testEnv({ LEMMY_INSTANCE: "one.example" }) });
    expect(calls.map((c) => new URL(c.url).searchParams.get("sort"))).toEqual(["TopAll", "TopMonth"]);
  });

  it("uses LEMMY_INSTANCE from opts.env when set", async () => {
    const { fetcher, calls } = spyFetcher(200, response([]));
    await lemmy.search("q", { fetcher, env: testEnv({ LEMMY_INSTANCE: "lemmy.ml" }) });
    expect(new URL(calls[0].url).host).toBe("lemmy.ml");
  });

  it("falls back to lemmy.world when LEMMY_INSTANCE is blank", async () => {
    const { fetcher, calls } = spyFetcher(200, response([]));
    await lemmy.search("q", { fetcher, env: testEnv({ LEMMY_INSTANCE: "   " }) });
    expect(new URL(calls[0].url).host).toBe("lemmy.world");
  });

  it("falls back to process.env for LEMMY_INSTANCE when opts.env is omitted", async () => {
    vi.stubEnv("LEMMY_INSTANCE", "programming.dev");
    const { fetcher, calls } = spyFetcher(200, response([]));
    await lemmy.search("q", { fetcher });
    expect(new URL(calls[0].url).host).toBe("programming.dev");
  });

  it("defaults limit to 25", async () => {
    const { fetcher, calls } = spyFetcher(200, response([]));
    await lemmy.search("q", { fetcher, env: testEnv() });
    expect(new URL(calls[0].url).searchParams.get("limit")).toBe("25");
  });

  it("caps limit at Lemmy's max of 50 even if a higher limit is requested", async () => {
    const { fetcher, calls } = spyFetcher(200, response([]));
    await lemmy.search("q", { fetcher, limit: 100, env: testEnv() });
    expect(new URL(calls[0].url).searchParams.get("limit")).toBe("50");
  });

  it("sends the descriptive User-Agent and an AbortSignal for the 8s timeout", async () => {
    const { fetcher, calls } = spyFetcher(200, response([]));
    await lemmy.search("q", { fetcher, env: testEnv() });
    expect(headers(calls[0])["User-Agent"]).toBe("PostEcho/0.1 (+https://github.com/simojam93/PostEcho)");
    expect(calls[0].init?.signal).toBeInstanceOf(AbortSignal);
  });

  it("returns status error with one console.warn on a non-ok response", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const r = await lemmy.search("q", { fetcher: fakeFetch(400, '{"error":"unknown","message":"Fetch limit is > 50"}'), env: testEnv() });
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
    const r = await lemmy.search("q", { fetcher: throwing, env: testEnv() });
    expect(r.posts).toEqual([]);
    expect(r.status).toBe("error");
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it("returns status error with one console.warn on malformed JSON", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const r = await lemmy.search("q", { fetcher: fakeFetch(200, "not json"), env: testEnv() });
    expect(r.status).toBe("error");
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it("returns [] when the response has no posts array (or is not an object at all)", async () => {
    expect(await lemmy.search("q", { fetcher: fakeFetch(200, JSON.stringify({})), env: testEnv() })).toEqual({ posts: [], status: "ok" });
    expect(await lemmy.search("q", { fetcher: fakeFetch(200, "[]"), env: testEnv() })).toEqual({ posts: [], status: "ok" });
    expect(await lemmy.search("q", { fetcher: fakeFetch(200, "null"), env: testEnv() })).toEqual({ posts: [], status: "ok" });
  });
});

describe("lemmy adapter — fan-out across instances and sorts", () => {
  it("queries every default instance on both sorts, instance-major with TopAll first", async () => {
    const { fetcher, calls } = routedFetcher(() => ({ status: 200, body: response([]) }));
    await lemmy.search("indie saas", { fetcher, env: testEnv() });
    expect(requested(calls)).toEqual(DEFAULT_HOSTS.flatMap((host) => [`${host}?TopAll`, `${host}?TopMonth`]));
  });

  it("sends the User-Agent and a timeout signal on every request, not just the first", async () => {
    const { fetcher, calls } = routedFetcher(() => ({ status: 200, body: response([]) }));
    await lemmy.search("q", { fetcher, env: testEnv() });
    expect(calls).toHaveLength(8);
    for (const call of calls) {
      expect(headers(call)["User-Agent"]).toBe("PostEcho/0.1 (+https://github.com/simojam93/PostEcho)");
      expect(call.init?.signal).toBeInstanceOf(AbortSignal);
    }
  });

  it("merges the posts of every instance and dedupes the ones they share", async () => {
    const { fetcher } = routedFetcher((url) => ({
      status: 200,
      // The same federated post is visible everywhere, plus one local to each instance.
      body: response([
        view({ post: { id: 1, url: "https://shared.example/1" } }),
        view({ post: { id: 2, url: `https://${url.host}/own` } }),
      ]),
    }));
    const r = await lemmy.search("indie saas", { fetcher, env: testEnv() });
    expect(r.status).toBe("ok");
    expect(r.posts.map((p) => p.url)).toEqual([
      "https://shared.example/1",
      ...DEFAULT_HOSTS.map((host) => `https://${host}/own`),
    ]);
  });

  it("keeps what only TopAll found alongside what only TopMonth found, deduping the overlap", async () => {
    const { fetcher } = routedFetcher((url) => ({
      status: 200,
      body: response([
        view({ post: { id: 1, url: "https://x.example/in-both" } }),
        view({ post: { id: 2, url: `https://x.example/${url.searchParams.get("sort")}-only` } }),
      ]),
    }));
    const r = await lemmy.search("q", { fetcher, env: testEnv({ LEMMY_INSTANCE: "one.example" }) });
    expect(r.posts.map((p) => p.url)).toEqual([
      "https://x.example/in-both",
      "https://x.example/TopAll-only",
      "https://x.example/TopMonth-only",
    ]);
  });

  it("caps the MERGED result at limit while still asking each request for up to 50", async () => {
    const { fetcher, calls } = routedFetcher((url) => ({
      status: 200,
      body: response(
        Array.from({ length: 50 }, (_, i) => view({ post: { id: i, url: `https://${url.host}/${i}` } })),
      ),
    }));
    const r = await lemmy.search("q", { fetcher, limit: 500, env: testEnv() });
    expect(calls).toHaveLength(8);
    expect(new URL(calls[0].url).searchParams.get("limit")).toBe("50");
    // 8 requests x 50 posts, deduped to the 4 instances' distinct urls.
    expect(r.posts).toHaveLength(4 * 50);

    const capped = await lemmy.search("q", { fetcher, limit: 30, env: testEnv() });
    expect(capped.posts).toHaveLength(30);
  });

  it("still returns the healthy instances' posts when one instance fails, with status ok and a note naming it", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { fetcher } = routedFetcher((url) =>
      url.host === "lemmy.ml"
        ? { status: 503, body: "down" }
        : { status: 200, body: response([view({ post: { id: 1, url: `https://${url.host}/1` } })]) },
    );
    const r = await lemmy.search("q", { fetcher, env: testEnv() });
    expect(r.status).toBe("ok");
    expect(r.posts.map((p) => p.url)).toEqual([
      "https://lemmy.world/1",
      "https://sh.itjust.works/1",
      "https://programming.dev/1",
    ]);
    expect(r.note).toBe("1 of 4 instances failed: lemmy.ml");
    // One warn for the whole fan-out, not one per failed request.
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it("still returns TopAll's posts when only the TopMonth request fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { fetcher } = routedFetcher((url) =>
      url.searchParams.get("sort") === "TopMonth"
        ? { status: 500, body: "boom" }
        : { status: 200, body: response([view({ post: { id: 1, url: "https://x.example/1" } })]) },
    );
    const r = await lemmy.search("q", { fetcher, env: testEnv({ LEMMY_INSTANCE: "one.example" }) });
    expect(r.status).toBe("ok");
    expect(r.posts.map((p) => p.url)).toEqual(["https://x.example/1"]);
    expect(r.note).toBe("1 of 1 instances failed: one.example");
    warn.mockRestore();
  });

  it("survives an instance whose fetch throws, and names it in the note", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetcher: Fetcher = async (url) => {
      if (new URL(url).host === "lemm.ee") throw new Error("network down");
      return { ok: true, status: 200, text: async () => response([view({ post: { id: 1, url: "https://ok.example/1" } })]) };
    };
    const r = await lemmy.search("q", { fetcher, env: testEnv({ LEMMY_INSTANCES: "lemm.ee,lemmy.world" }) });
    expect(r.status).toBe("ok");
    expect(r.posts).toHaveLength(1);
    expect(r.note).toBe("1 of 2 instances failed: lemm.ee");
    warn.mockRestore();
  });

  it("reports error with one warn only when EVERY request fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { fetcher } = routedFetcher(() => ({ status: 503, body: "down" }));
    const r = await lemmy.search("q", { fetcher, env: testEnv() });
    expect(r.posts).toEqual([]);
    expect(r.status).toBe("error");
    expect(r.note).toBe("4 of 4 instances failed: lemmy.world, lemmy.ml, sh.itjust.works, programming.dev");
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
});

describe("lemmy adapter — instance env vars", () => {
  it("reads a comma-separated host list from LEMMY_INSTANCES", async () => {
    const { fetcher, calls } = routedFetcher(() => ({ status: 200, body: response([]) }));
    await lemmy.search("q", { fetcher, env: testEnv({ LEMMY_INSTANCES: "lemmy.ml,programming.dev" }) });
    expect(requested(calls)).toEqual([
      "lemmy.ml?TopAll",
      "lemmy.ml?TopMonth",
      "programming.dev?TopAll",
      "programming.dev?TopMonth",
    ]);
  });

  it("trims whitespace, drops blanks and dedupes hosts in LEMMY_INSTANCES", async () => {
    const { fetcher, calls } = routedFetcher(() => ({ status: 200, body: response([]) }));
    await lemmy.search("q", { fetcher, env: testEnv({ LEMMY_INSTANCES: " lemmy.ml , ,programming.dev, lemmy.ml " }) });
    expect(Array.from(new Set(requested(calls).map((r) => r.split("?")[0])))).toEqual(["lemmy.ml", "programming.dev"]);
    expect(calls).toHaveLength(4);
  });

  it("lets the singular LEMMY_INSTANCE win over the plural list", async () => {
    const { fetcher, calls } = routedFetcher(() => ({ status: 200, body: response([]) }));
    await lemmy.search("q", {
      fetcher,
      env: testEnv({ LEMMY_INSTANCE: "pinned.example", LEMMY_INSTANCES: "lemmy.ml,programming.dev" }),
    });
    expect(requested(calls)).toEqual(["pinned.example?TopAll", "pinned.example?TopMonth"]);
  });

  it("falls back to the four defaults when LEMMY_INSTANCES is blank", async () => {
    const { fetcher, calls } = routedFetcher(() => ({ status: 200, body: response([]) }));
    await lemmy.search("q", { fetcher, env: testEnv({ LEMMY_INSTANCES: "  " }) });
    expect(Array.from(new Set(requested(calls).map((r) => r.split("?")[0])))).toEqual(DEFAULT_HOSTS);
  });

  it("falls back to process.env for LEMMY_INSTANCES when opts.env is omitted", async () => {
    vi.stubEnv("LEMMY_INSTANCES", "lemmy.ml,sh.itjust.works");
    const { fetcher, calls } = routedFetcher(() => ({ status: 200, body: response([]) }));
    await lemmy.search("q", { fetcher });
    expect(Array.from(new Set(requested(calls).map((r) => r.split("?")[0])))).toEqual(["lemmy.ml", "sh.itjust.works"]);
  });
});
