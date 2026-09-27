import { describe, expect, it, vi } from "vitest";
import { lobsters } from "@/lib/sources/lobsters";
import type { Fetcher } from "@/lib/sources/types";

const HOTTEST = "https://lobste.rs/hottest.json";
const NEWEST = "https://lobste.rs/newest.json";

type Route = { status: number; body: string };
type Call = { url: string; init?: RequestInit };

/** A fetcher answering each feed url with its own status/body (throws on any other url), recording every call. */
function feeds(hottest: Route, newest: Route): { fetcher: Fetcher; calls: Call[] } {
  const routes: Record<string, Route> = { [HOTTEST]: hottest, [NEWEST]: newest };
  const calls: Call[] = [];
  const fetcher: Fetcher = async (url, init) => {
    calls.push({ url, init });
    const route = routes[url];
    if (!route) throw new Error(`unexpected url ${url}`);
    return { ok: route.status >= 200 && route.status < 300, status: route.status, text: async () => route.body };
  };
  return { fetcher, calls };
}

function ok(body: unknown): Route {
  return { status: 200, body: JSON.stringify(body) };
}

function headers(call: Call | undefined): Record<string, string> {
  return (call?.init?.headers as Record<string, string> | undefined) ?? {};
}

// Real hottest.json rows (2026-09-22), trimmed to the fields that matter.
const euroCloud = {
  short_id: "6licoy",
  created_at: "2026-09-08T02:20:16.336-05:00",
  title: "The state of European cloud providers in 2026",
  url: "https://crescentro.se/posts/euro-cloud-providers-2026/",
  score: 96,
  flags: 0,
  comment_count: 39,
  description: "",
  description_plain: "",
  submitter_user: "morj",
  user_is_author: false,
  tags: ["scaling"],
  short_id_url: "https://lobste.rs/s/6licoy",
  comments_url: "https://lobste.rs/s/6licoy/state_european_cloud_providers_2026",
};

const indieSaas = {
  short_id: "abc123",
  created_at: "2026-09-21T10:00:00.000-05:00",
  title: "Bootstrapping an indie SaaS on a $5 VPS",
  url: "https://example.com/indie-saas",
  score: 42,
  flags: 0,
  comment_count: 7,
  description: "<p>Notes on running a <em>tiny</em> SaaS &amp; keeping costs near zero.</p>",
  description_plain: "Notes on running a tiny SaaS & keeping costs near zero.",
  submitter_user: "maker",
  user_is_author: true,
  tags: ["practices", "web"],
  short_id_url: "https://lobste.rs/s/abc123",
  comments_url: "https://lobste.rs/s/abc123/bootstrapping_indie_saas",
};

// A text-only ("Ask Lobsters") submission: empty url, only a discussion page.
const askSaas = {
  short_id: "ask001",
  created_at: "2026-09-22T03:00:00.000-05:00",
  title: "What do you use to bill for a SaaS?",
  url: "",
  score: 5,
  flags: 0,
  comment_count: 12,
  description: "<p>Stripe feels heavy for one product.</p>",
  description_plain: "Stripe feels heavy for one product.",
  submitter_user: "solo",
  user_is_author: true,
  tags: ["ask"],
  short_id_url: "https://lobste.rs/s/ask001",
  comments_url: "https://lobste.rs/s/ask001/what_do_you_use_bill_for_saas",
};

function story(overrides: Partial<typeof indieSaas> & { short_id: string }): typeof indieSaas {
  return { ...indieSaas, url: `https://example.com/${overrides.short_id}`, ...overrides };
}

describe("lobsters adapter", () => {
  it("has the expected name/label/tag and no required env", () => {
    expect(lobsters.name).toBe("lobsters");
    expect(lobsters.label).toBe("Lobsters");
    expect(lobsters.tag).toBe("LOB");
    expect(lobsters.requiredEnv ?? []).toEqual([]);
  });

  it("pools hottest.json then newest.json, keeps only stories matching a query term, mapped to AdapterPost shape", async () => {
    const { fetcher } = feeds(ok([euroCloud, indieSaas]), ok([askSaas]));
    const r = await lobsters.search("indie saas", { fetcher });
    expect(r.status).toBe("ok");
    expect(r.posts).toEqual([
      {
        id: "abc123",
        url: "https://example.com/indie-saas",
        text: "Bootstrapping an indie SaaS on a $5 VPS — Notes on running a tiny SaaS & keeping costs near zero.",
        title: "Bootstrapping an indie SaaS on a $5 VPS",
        author: "maker",
        metrics: { likes: 42, replies: 7 },
        createdAt: "2026-09-21T10:00:00.000-05:00",
      },
      {
        id: "ask001",
        url: "https://lobste.rs/s/ask001/what_do_you_use_bill_for_saas",
        text: "What do you use to bill for a SaaS? — Stripe feels heavy for one product.",
        title: "What do you use to bill for a SaaS?",
        author: "solo",
        metrics: { likes: 5, replies: 12 },
        createdAt: "2026-09-22T03:00:00.000-05:00",
      },
    ]);
  });

  it("uses just the title as text when the story has no description", async () => {
    const { fetcher } = feeds(ok([euroCloud]), ok([]));
    const r = await lobsters.search("cloud", { fetcher });
    expect(r.posts).toHaveLength(1);
    expect(r.posts[0].text).toBe("The state of European cloud providers in 2026");
  });

  it("links a text-only story (empty url) to its comments_url", async () => {
    const { fetcher } = feeds(ok([]), ok([askSaas]));
    const r = await lobsters.search("saas", { fetcher });
    expect(r.posts[0].url).toBe("https://lobste.rs/s/ask001/what_do_you_use_bill_for_saas");
  });

  it("accepts submitter_user as a plain string or a user object, and null when absent", async () => {
    const asObject = story({ short_id: "o1", submitter_user: { username: "objuser" } as unknown as string });
    const missing = story({ short_id: "m1", submitter_user: undefined });
    const { fetcher } = feeds(ok([indieSaas, asObject, missing]), ok([]));
    const r = await lobsters.search("saas", { fetcher });
    expect(r.posts.map((p) => p.author)).toEqual(["maker", "objuser", null]);
  });

  it("strips and decodes the HTML description when description_plain is absent", async () => {
    const htmlOnly = story({ short_id: "h1", description_plain: undefined });
    const { fetcher } = feeds(ok([htmlOnly]), ok([]));
    const r = await lobsters.search("saas", { fetcher });
    expect(r.posts[0].text).toBe("Bootstrapping an indie SaaS on a $5 VPS — Notes on running a tiny SaaS & keeping costs near zero.");
  });

  it("caps the description at 300 chars and the whole text at 600", async () => {
    const longDescription = story({ short_id: "d1", title: "T", description_plain: "d".repeat(400) });
    const longTitle = story({ short_id: "d2", title: "t".repeat(500), description_plain: "d".repeat(400) });
    const { fetcher } = feeds(ok([longDescription, longTitle]), ok([]));
    const r = await lobsters.search("t", { fetcher });
    // Cut texts end in "…" (2026-09-27): the description where it was capped, the whole text at its last word.
    expect(r.posts[0].text).toBe("T — " + "d".repeat(299) + "…");
    expect(r.posts[1].text.length).toBeLessThanOrEqual(600);
    expect(r.posts[1].text.endsWith("…")).toBe(true);
  });

  it("matches case-insensitively on tags and description, not just the title", async () => {
    const { fetcher } = feeds(ok([euroCloud, indieSaas]), ok([]));
    const byTag = await lobsters.search("SCALING", { fetcher });
    expect(byTag.posts.map((p) => p.id)).toEqual(["6licoy"]);
    const byDescription = await lobsters.search("costs", { fetcher });
    expect(byDescription.posts.map((p) => p.id)).toEqual(["abc123"]);
  });

  it("returns no posts when nothing in the pool matches", async () => {
    const { fetcher } = feeds(ok([euroCloud, indieSaas]), ok([askSaas]));
    const r = await lobsters.search("quantum knitting", { fetcher });
    expect(r).toEqual({ posts: [], status: "ok" });
  });

  it("ignores terms with no letter or digit, and returns no posts for an empty query", async () => {
    const { fetcher } = feeds(ok([euroCloud, indieSaas]), ok([askSaas]));
    expect((await lobsters.search("&", { fetcher })).posts).toEqual([]);
    expect((await lobsters.search("   ", { fetcher })).posts).toEqual([]);
    // The "&" is dropped but "saas" still matches.
    expect((await lobsters.search("saas & more", { fetcher })).posts.map((p) => p.id)).toEqual(["abc123", "ask001"]);
  });

  it("dedupes a story present in both feeds by url, keeping the hottest copy first", async () => {
    const { fetcher } = feeds(ok([indieSaas]), ok([{ ...indieSaas, score: 1 }, askSaas]));
    const r = await lobsters.search("saas", { fetcher });
    expect(r.posts.map((p) => p.id)).toEqual(["abc123", "ask001"]);
    expect(r.posts[0].metrics.likes).toBe(42);
  });

  it("drops stories missing short_id or title", async () => {
    const noId = { ...indieSaas, short_id: undefined };
    const noTitle = story({ short_id: "nt", title: undefined });
    const { fetcher } = feeds(ok([noId, noTitle, indieSaas]), ok([]));
    const r = await lobsters.search("saas", { fetcher });
    expect(r.posts.map((p) => p.id)).toEqual(["abc123"]);
  });

  it("defaults limit to 25 over the pooled matches", async () => {
    const hottest = Array.from({ length: 20 }, (_, i) => story({ short_id: `h${i}` }));
    const newest = Array.from({ length: 20 }, (_, i) => story({ short_id: `n${i}` }));
    const { fetcher } = feeds(ok(hottest), ok(newest));
    const r = await lobsters.search("saas", { fetcher });
    expect(r.posts).toHaveLength(25);
    expect(r.posts[0].id).toBe("h0");
    expect(r.posts[24].id).toBe("n4");
  });

  it("respects an explicit limit", async () => {
    const { fetcher } = feeds(ok([indieSaas, story({ short_id: "s2" })]), ok([askSaas]));
    const r = await lobsters.search("saas", { fetcher, limit: 2 });
    expect(r.posts.map((p) => p.id)).toEqual(["abc123", "s2"]);
  });

  it("requests exactly hottest.json and newest.json, each with the descriptive User-Agent and an AbortSignal", async () => {
    const { fetcher, calls } = feeds(ok([]), ok([]));
    await lobsters.search("saas", { fetcher });
    expect(calls.map((c) => c.url)).toEqual([HOTTEST, NEWEST]);
    for (const call of calls) {
      expect(headers(call)["User-Agent"]).toBe("PostEcho/0.1 (+https://github.com/simojam93/PostEcho)");
      expect(call.init?.signal).toBeInstanceOf(AbortSignal);
    }
  });

  it("returns status error with one console.warn when both feeds answer non-ok", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { fetcher } = feeds({ status: 500, body: "server error" }, { status: 503, body: "down" });
    const r = await lobsters.search("saas", { fetcher });
    expect(r.posts).toEqual([]);
    expect(r.status).toBe("error");
    expect(r.note).toBe("hottest.json failed with status 500; newest.json failed with status 503");
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it("returns status error with one console.warn when the fetcher throws", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const throwing: Fetcher = async () => {
      throw new Error("network down");
    };
    const r = await lobsters.search("saas", { fetcher: throwing });
    expect(r.posts).toEqual([]);
    expect(r.status).toBe("error");
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it("returns status error with one console.warn when both feeds return malformed JSON", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { fetcher } = feeds({ status: 200, body: "not json" }, { status: 200, body: "<html>" });
    const r = await lobsters.search("saas", { fetcher });
    expect(r.status).toBe("error");
    expect(r.posts).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it("still returns the healthy feed's matches (status ok, failure in note, one warn) when only one feed fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { fetcher } = feeds({ status: 500, body: "server error" }, ok([askSaas]));
    const r = await lobsters.search("saas", { fetcher });
    expect(r.status).toBe("ok");
    expect(r.posts.map((p) => p.id)).toEqual(["ask001"]);
    expect(r.note).toBe("hottest.json failed with status 500");
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it("treats a non-array feed response as an empty pool", async () => {
    const { fetcher } = feeds(ok({}), ok({ stories: [] }));
    const r = await lobsters.search("saas", { fetcher });
    expect(r).toEqual({ posts: [], status: "ok" });
  });
});
