import { afterEach, describe, expect, it, vi } from "vitest";
import { mastodon } from "@/lib/sources/mastodon";
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

/**
 * A fetcher that answers per-request rather than one canned response for
 * every call — `pick` sees the parsed url (host, tag path, params) and
 * returns that request's status+body. What the fan-out tests need: the whole
 * point is that different instances answer differently.
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

/** One minimal status, with the url that dedupe keys on. */
function status(id: string, url: string, content = "<p>hi</p>") {
  return { id, created_at: null, url, content, replies_count: 0, reblogs_count: 0, favourites_count: 0, account: { acct: "a" } };
}

/** "<host><path>" for each call — the shape the fan-out assertions compare against. */
function requested(calls: { url: string }[]): string[] {
  return calls.map((c) => {
    const u = new URL(c.url);
    return u.host + u.pathname;
  });
}

const DEFAULT_HOSTS = ["mastodon.social", "fosstodon.org", "hachyderm.io", "indieweb.social"];

// Next.js's global.d.ts augments NodeJS.ProcessEnv with a required NODE_ENV
// field, so a plain `{}`/`{ KEY: "value" }` literal doesn't structurally
// satisfy it — this builds a valid one for tests.
function testEnv(overrides: Partial<NodeJS.ProcessEnv> = {}): NodeJS.ProcessEnv {
  return { NODE_ENV: "test", ...overrides };
}

const oneStatus = JSON.stringify([
  {
    id: "117310899633609143",
    created_at: "2026-09-21T20:16:23.000Z",
    url: "https://robot.villas/users/npr_news_now/posts/22339821",
    content:
      '<p>Great episode on <a href="https://mastodon.social/tags/audio" class="mention hashtag">#<span>audio</span></a> production tips! Check it out &amp; share.</p>',
    replies_count: 1,
    reblogs_count: 2,
    favourites_count: 5,
    account: { acct: "npr_news_now@robot.villas" },
  },
]);

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("mastodon adapter", () => {
  it("has the expected name/label/tag and no required env", () => {
    expect(mastodon.name).toBe("mastodon");
    expect(mastodon.label).toBe("Mastodon");
    expect(mastodon.tag).toBe("MST");
    expect(mastodon.requiredEnv ?? []).toEqual([]);
  });

  it("parses statuses into AdapterPost shape, stripping and decoding content HTML", async () => {
    const r = await mastodon.search("audio", { fetcher: fakeFetch(200, oneStatus), env: testEnv() });
    expect(r.status).toBe("ok");
    expect(r.posts).toEqual([
      {
        id: "117310899633609143",
        url: "https://robot.villas/users/npr_news_now/posts/22339821",
        text: "Great episode on #audio production tips! Check it out & share.",
        title: null,
        author: "npr_news_now@robot.villas",
        metrics: { likes: 5, reposts: 2, replies: 1 },
        createdAt: "2026-09-21T20:16:23.000Z",
      },
    ]);
  });

  it("truncates text to 600 chars", async () => {
    const body = JSON.stringify([
      { id: "1", created_at: null, url: "https://m.social/@a/1", content: `<p>${"a".repeat(700)}</p>`, replies_count: 0, reblogs_count: 0, favourites_count: 0, account: { acct: "a" } },
    ]);
    const r = await mastodon.search("q", { fetcher: fakeFetch(200, body), env: testEnv() });
    expect(r.posts[0].text).toHaveLength(600);
  });

  it("dedupes statuses by url", async () => {
    const body = JSON.stringify([
      { id: "1", created_at: null, url: "https://m.social/@a/1", content: "<p>one</p>", replies_count: 0, reblogs_count: 0, favourites_count: 0, account: { acct: "a" } },
      { id: "2", created_at: null, url: "https://m.social/@a/1", content: "<p>two</p>", replies_count: 0, reblogs_count: 0, favourites_count: 0, account: { acct: "a" } },
    ]);
    const r = await mastodon.search("q", { fetcher: fakeFetch(200, body), env: testEnv() });
    expect(r.posts).toHaveLength(1);
    expect(r.posts[0].text).toBe("one");
  });

  it("builds the request url on the default instance (mastodon.social), using the first query token as the hashtag", async () => {
    const { fetcher, calls } = spyFetcher(200, "[]");
    await mastodon.search("Audio-Production tips", { fetcher, env: testEnv() });
    const url = new URL(calls[0].url);
    expect(url.origin + url.pathname).toBe("https://mastodon.social/api/v1/timelines/tag/audioproduction");
  });

  it("uses MASTODON_INSTANCE from opts.env when set", async () => {
    const { fetcher, calls } = spyFetcher(200, "[]");
    await mastodon.search("audio", { fetcher, env: testEnv({ MASTODON_INSTANCE: "fosstodon.org" }) });
    expect(new URL(calls[0].url).host).toBe("fosstodon.org");
  });

  it("falls back to process.env for MASTODON_INSTANCE when opts.env is omitted", async () => {
    vi.stubEnv("MASTODON_INSTANCE", "indieweb.social");
    const { fetcher, calls } = spyFetcher(200, "[]");
    await mastodon.search("audio", { fetcher });
    expect(new URL(calls[0].url).host).toBe("indieweb.social");
  });

  it("defaults limit to 25", async () => {
    const { fetcher, calls } = spyFetcher(200, "[]");
    await mastodon.search("audio", { fetcher, env: testEnv() });
    expect(new URL(calls[0].url).searchParams.get("limit")).toBe("25");
  });

  it("clamps limit to Mastodon's max of 40 even if a higher limit is requested", async () => {
    const { fetcher, calls } = spyFetcher(200, "[]");
    await mastodon.search("audio", { fetcher, limit: 100, env: testEnv() });
    expect(new URL(calls[0].url).searchParams.get("limit")).toBe("40");
  });

  it("passes an AbortSignal for the 8s timeout", async () => {
    const { fetcher, calls } = spyFetcher(200, "[]");
    await mastodon.search("audio", { fetcher, env: testEnv() });
    expect(calls[0].init?.signal).toBeInstanceOf(AbortSignal);
  });

  it("returns status error with one console.warn on a non-ok response", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const r = await mastodon.search("q", { fetcher: fakeFetch(404, "not found"), env: testEnv() });
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
    const r = await mastodon.search("q", { fetcher: throwing, env: testEnv() });
    expect(r.posts).toEqual([]);
    expect(r.status).toBe("error");
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it("returns status error with one console.warn on malformed JSON", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const r = await mastodon.search("q", { fetcher: fakeFetch(200, "not json"), env: testEnv() });
    expect(r.status).toBe("error");
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it("returns [] when the response is not an array", async () => {
    const r = await mastodon.search("q", { fetcher: fakeFetch(200, JSON.stringify({})), env: testEnv() });
    expect(r).toEqual({ posts: [], status: "ok" });
  });
});

describe("mastodon adapter — fan-out across instances and hashtags", () => {
  it("queries every default instance for the first two usable hashtags, instance-major", async () => {
    const { fetcher, calls } = routedFetcher(() => ({ status: 200, body: "[]" }));
    await mastodon.search("indie saas founders", { fetcher, env: testEnv() });
    expect(requested(calls)).toEqual(
      DEFAULT_HOSTS.flatMap((host) => [
        `${host}/api/v1/timelines/tag/indie`,
        `${host}/api/v1/timelines/tag/saas`,
      ]),
    );
  });

  it("drops tokens shorter than 3 chars when picking the two hashtags", async () => {
    const { fetcher, calls } = routedFetcher(() => ({ status: 200, body: "[]" }));
    await mastodon.search("ai in indie saas", { fetcher, env: testEnv({ MASTODON_INSTANCE: "one.example" }) });
    expect(requested(calls)).toEqual([
      "one.example/api/v1/timelines/tag/indie",
      "one.example/api/v1/timelines/tag/saas",
    ]);
  });

  it("falls back to the short tokens when NO token is 3+ chars, rather than making no request at all", async () => {
    const { fetcher, calls } = routedFetcher(() => ({ status: 200, body: "[]" }));
    await mastodon.search("ai ux", { fetcher, env: testEnv({ MASTODON_INSTANCE: "one.example" }) });
    expect(requested(calls)).toEqual([
      "one.example/api/v1/timelines/tag/ai",
      "one.example/api/v1/timelines/tag/ux",
    ]);
  });

  it("issues one request per instance when the query has a single usable token", async () => {
    const { fetcher, calls } = routedFetcher(() => ({ status: 200, body: "[]" }));
    await mastodon.search("saas", { fetcher, env: testEnv() });
    expect(requested(calls)).toEqual(DEFAULT_HOSTS.map((host) => `${host}/api/v1/timelines/tag/saas`));
  });

  it("makes no request at all (status ok) when the query has no alphanumerics", async () => {
    const { fetcher, calls } = routedFetcher(() => ({ status: 200, body: "[]" }));
    const r = await mastodon.search("— & →", { fetcher, env: testEnv() });
    expect(calls).toEqual([]);
    expect(r).toEqual({ posts: [], status: "ok" });
  });

  it("merges the posts of every instance and dedupes the ones they share", async () => {
    const { fetcher } = routedFetcher((url) => ({
      status: 200,
      // Every instance sees the same federated post, plus one of its own.
      body: JSON.stringify([status("shared", "https://m.example/shared"), status(url.host, `https://${url.host}/own`)]),
    }));
    const r = await mastodon.search("saas", { fetcher, env: testEnv() });
    expect(r.status).toBe("ok");
    expect(r.posts.map((p) => p.url)).toEqual([
      "https://m.example/shared",
      ...DEFAULT_HOSTS.map((host) => `https://${host}/own`),
    ]);
  });

  it("dedupes the same post seen under both hashtags on one instance", async () => {
    const { fetcher } = routedFetcher(() => ({ status: 200, body: JSON.stringify([status("1", "https://m.example/1")]) }));
    const r = await mastodon.search("indie saas", { fetcher, env: testEnv({ MASTODON_INSTANCE: "one.example" }) });
    expect(r.posts).toHaveLength(1);
  });

  it("caps the MERGED result at limit while still asking each request for up to 40", async () => {
    const { fetcher, calls } = routedFetcher((url) => ({
      status: 200,
      body: JSON.stringify(Array.from({ length: 40 }, (_, i) => status(`${url.host}-${i}`, `https://${url.host}/${i}`))),
    }));
    // limit=200 is above anything the merge can produce, so this shows the
    // full yield: 8 requests x 40 statuses, deduped down to the 4 distinct
    // instances' worth of urls — 160, far more than the single request's 40.
    const r = await mastodon.search("indie saas", { fetcher, limit: 200, env: testEnv() });
    expect(calls).toHaveLength(8);
    expect(new URL(calls[0].url).searchParams.get("limit")).toBe("40");
    expect(r.posts).toHaveLength(4 * 40);

    // ...and the same merge capped at a smaller limit.
    const capped = await mastodon.search("indie saas", { fetcher, limit: 30, env: testEnv() });
    expect(capped.posts).toHaveLength(30);
  });

  it("still returns the healthy instances' posts when one instance fails, with status ok and a note naming it", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { fetcher } = routedFetcher((url) =>
      url.host === "hachyderm.io"
        ? { status: 503, body: "down" }
        : { status: 200, body: JSON.stringify([status(url.host, `https://${url.host}/1`)]) },
    );
    const r = await mastodon.search("indie saas", { fetcher, env: testEnv() });
    expect(r.status).toBe("ok");
    expect(r.posts.map((p) => p.url)).toEqual([
      "https://mastodon.social/1",
      "https://fosstodon.org/1",
      "https://indieweb.social/1",
    ]);
    expect(r.note).toBe("1 of 4 instances failed: hachyderm.io");
    // One warn for the whole fan-out, not one per failed request.
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it("survives an instance whose fetch throws, and names it in the note", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const calls: string[] = [];
    const fetcher: Fetcher = async (url) => {
      calls.push(url);
      if (new URL(url).host === "mas.to") throw new Error("network down");
      return { ok: true, status: 200, text: async () => JSON.stringify([status("1", "https://ok.example/1")]) };
    };
    const r = await mastodon.search("saas", { fetcher, env: testEnv({ MASTODON_INSTANCES: "mas.to,mastodon.social" }) });
    expect(r.status).toBe("ok");
    expect(r.posts).toHaveLength(1);
    expect(r.note).toBe("1 of 2 instances failed: mas.to");
    warn.mockRestore();
  });

  it("reports error with one warn only when EVERY request fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { fetcher } = routedFetcher(() => ({ status: 503, body: "down" }));
    const r = await mastodon.search("indie saas", { fetcher, env: testEnv() });
    expect(r.posts).toEqual([]);
    expect(r.status).toBe("error");
    expect(r.note).toBe("4 of 4 instances failed: mastodon.social, fosstodon.org, hachyderm.io, indieweb.social");
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
});

describe("mastodon adapter — instance env vars", () => {
  it("reads a comma-separated host list from MASTODON_INSTANCES", async () => {
    const { fetcher, calls } = routedFetcher(() => ({ status: 200, body: "[]" }));
    await mastodon.search("saas", { fetcher, env: testEnv({ MASTODON_INSTANCES: "mas.to,hachyderm.io" }) });
    expect(requested(calls)).toEqual([
      "mas.to/api/v1/timelines/tag/saas",
      "hachyderm.io/api/v1/timelines/tag/saas",
    ]);
  });

  it("trims whitespace, drops blanks and dedupes hosts in MASTODON_INSTANCES", async () => {
    const { fetcher, calls } = routedFetcher(() => ({ status: 200, body: "[]" }));
    await mastodon.search("saas", { fetcher, env: testEnv({ MASTODON_INSTANCES: " mas.to , , hachyderm.io ,mas.to" }) });
    expect(requested(calls).map((r) => r.split("/")[0])).toEqual(["mas.to", "hachyderm.io"]);
  });

  it("lets the singular MASTODON_INSTANCE win over the plural list", async () => {
    const { fetcher, calls } = routedFetcher(() => ({ status: 200, body: "[]" }));
    await mastodon.search("saas", {
      fetcher,
      env: testEnv({ MASTODON_INSTANCE: "pinned.example", MASTODON_INSTANCES: "mas.to,hachyderm.io" }),
    });
    expect(requested(calls)).toEqual(["pinned.example/api/v1/timelines/tag/saas"]);
  });

  it("falls back to the four defaults when MASTODON_INSTANCES is blank", async () => {
    const { fetcher, calls } = routedFetcher(() => ({ status: 200, body: "[]" }));
    await mastodon.search("saas", { fetcher, env: testEnv({ MASTODON_INSTANCES: "  " }) });
    expect(requested(calls).map((r) => r.split("/")[0])).toEqual(DEFAULT_HOSTS);
  });

  it("falls back to process.env for MASTODON_INSTANCES when opts.env is omitted", async () => {
    vi.stubEnv("MASTODON_INSTANCES", "mas.to,indieweb.social");
    const { fetcher, calls } = routedFetcher(() => ({ status: 200, body: "[]" }));
    await mastodon.search("saas", { fetcher });
    expect(requested(calls).map((r) => r.split("/")[0])).toEqual(["mas.to", "indieweb.social"]);
  });
});
