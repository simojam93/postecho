import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb } from "@/test/db";
import { ideas } from "@/db/schema";
import { setSetting } from "@/lib/settings";
import { DEFAULT_FIND_ORDER, jevKinds, RELEVANCE_GATE } from "@/lib/find-kinds";
import type { AdapterPost, AdapterResult, SourceAdapter } from "@/lib/sources/adapter";
import type { SourcePost } from "@/lib/sources/types";
import type { JevClient, PostJudgment } from "jev-judge";

const state: { db: Awaited<ReturnType<typeof createTestDb>> | null } = { db: null };
vi.mock("@/db", () => ({ get db() { return state.db; } }));

// Defaults to a single variant equal to the query itself — tests that don't
// care about variant expansion get the old "one call per source" shape for
// free; variant-expansion tests override with mockReturnValueOnce. Same
// mocking strategy as before this file's rewrite: query-derivation nuances
// have their own coverage in lib/query.test.ts, so scout-run's own tests
// stay focused on the pipeline itself.
vi.mock("@/lib/query", async (orig) => ({
  ...(await orig()),
  queryVariants: vi.fn((q: string) => (q ? [q] : [])),
}));
// Keeps the real `sortByRank` (and other exports) working — only
// `createJevClient`/`judgePosts` are faked.
vi.mock("jev-judge", async (orig) => ({
  ...(await orig()),
  createJevClient: vi.fn(),
  judgePosts: vi.fn(),
}));
// The REAL loadTasteExamples, just wrapped in a spy so the rounds tests can
// assert taste is loaded once per run rather than once per round.
vi.mock("@/lib/taste", async (orig) => {
  const mod = await orig<typeof import("@/lib/taste")>();
  return { ...mod, loadTasteExamples: vi.fn(mod.loadTasteExamples) };
});

const { runScoutSearch, adapterPostToSourcePost, MAX_ROUNDS, TIME_BUDGET_MS, UNRANKED_NOTE, VARIANT_DEAD_MIN_JUDGED } = await import("@/lib/scout-run");
const { queryVariants } = await import("@/lib/query");
const { createJevClient, judgePosts } = await import("jev-judge");
const { loadTasteExamples } = await import("@/lib/taste");

function adapterPost(overrides: Partial<AdapterPost> & { id: string }): AdapterPost {
  return {
    id: overrides.id,
    url: overrides.url ?? `https://example.com/${overrides.id}`,
    text: overrides.text ?? "some post text",
    title: overrides.title ?? null,
    author: overrides.author === undefined ? "some author" : overrides.author,
    metrics: overrides.metrics ?? { likes: 1 },
    createdAt: overrides.createdAt === undefined ? null : overrides.createdAt,
  };
}

/** A minimal SourceAdapter test double — `search` defaults to resolving no posts, `ok`. */
function fakeAdapter(overrides: Partial<SourceAdapter> & { name: string }): SourceAdapter {
  return {
    name: overrides.name,
    label: overrides.label ?? overrides.name,
    tag: overrides.tag ?? overrides.name.slice(0, 2).toUpperCase(),
    requiredEnv: overrides.requiredEnv,
    search: overrides.search ?? vi.fn().mockResolvedValue({ posts: [], status: "ok" }),
  };
}

/** A fake adapter whose search always resolves the same AdapterResult, regardless of variant/call count. */
function staticAdapter(name: string, result: AdapterResult): SourceAdapter {
  return fakeAdapter({ name, search: vi.fn().mockResolvedValue(result) });
}

/**
 * Scripts an adapter's successive variant-call results in order: entry `i`
 * is returned on that adapter's (i+1)th `search` call (clamped to the last
 * entry once the script runs out); `"reject"` throws instead.
 */
function scriptedAdapter(name: string, script: Array<AdapterResult | "reject">): SourceAdapter {
  let i = 0;
  const search = vi.fn(async () => {
    const entry = script[Math.min(i, script.length - 1)];
    i++;
    if (entry === "reject") throw new Error(`${name} call #${i} rejected`);
    return entry;
  });
  return fakeAdapter({ name, search });
}

/**
 * Simulates a real source: every call returns the first `limit` posts of one
 * fixed, ordered pool — so a bigger `limit` (a later round) surfaces posts a
 * smaller one didn't, while re-returning everything already seen.
 */
function pooledAdapter(name: string, pool: AdapterPost[]): SourceAdapter {
  const search = vi.fn(async (_query: string, opts: { limit?: number }): Promise<AdapterResult> => ({
    posts: pool.slice(0, opts.limit ?? pool.length),
    status: "ok",
  }));
  return fakeAdapter({ name, search });
}

/** `n` distinct posts named `${prefix}1..n` at `https://${prefix}/1..n`. */
function pool(prefix: string, n: number): AdapterPost[] {
  return Array.from({ length: n }, (_, i) => adapterPost({ id: `${prefix}${i + 1}`, url: `https://${prefix}/${i + 1}` }));
}

/**
 * A `pooledAdapter` that also knows which variant it was asked for: one
 * fixed, ordered pool PER query variant, `search(variant, {limit})` returning
 * the first `limit` posts of `pools[variant]` (none for a variant it has no
 * pool for), `ok`. The variant-pruning tests need this because they're about
 * a source's variants behaving differently from one another.
 */
function variantPooledAdapter(name: string, pools: Record<string, AdapterPost[]>): SourceAdapter {
  const search = vi.fn(async (variant: string, opts: { limit?: number }): Promise<AdapterResult> => ({
    posts: (pools[variant] ?? []).slice(0, opts.limit),
    status: "ok",
  }));
  return fakeAdapter({ name, search });
}

/** Every (variant, limit) pair an adapter's `search` was asked, in call order — the variant-pruning tests' main assertion. */
function searchCalls(adapter: SourceAdapter): Array<[string, number | undefined]> {
  return vi.mocked(adapter.search).mock.calls.map((c) => [c[0], c[1].limit]);
}

/** Has Jev judge every candidate of every round by `rankOf(id)` — non-spam, relevance = rank. */
function judgeEveryCandidate(rankOf: (id: string) => number): void {
  vi.mocked(judgePosts).mockImplementation(async (_client, args) => args.posts.map((p) => judgment(p.id, rankOf(p.id))));
}

/** The ids `judgePosts` was given on its `n`th call (1-based). */
function judgedIdsOnCall(n: number): string[] {
  return vi.mocked(judgePosts).mock.calls[n - 1][1].posts.map((p) => p.id);
}

function judgment(
  id: string,
  relevance: number,
  isSpam = false,
  extra: { quality?: number; tasteFit?: number | null; rank?: number } = {},
): PostJudgment {
  return {
    id,
    relevance,
    relevanceConfidence: 0.8,
    quality: extra.quality ?? relevance,
    qualityConfidence: 0.8,
    tasteFit: extra.tasteFit ?? null,
    // Defaulting rank to relevance keeps every pre-existing fixture's
    // ordering unchanged; tests that care about rank-vs-relevance divergence
    // pass `rank` explicitly.
    rank: extra.rank ?? relevance,
    isSpam,
    spamScore: isSpam ? 0.9 : 0.1,
  };
}

/** Fake JevClient — never actually called since `judgePosts` itself is mocked, but
 * `runScoutSearch` needs *some* truthy value to pass through as the client. */
const fakeClient = { systemOne: vi.fn() } as unknown as JevClient;

const originalKey = process.env.TYPESAFE_API_KEY;

beforeEach(async () => {
  state.db = await createTestDb();
  vi.mocked(queryVariants).mockReset().mockImplementation((q: string) => (q ? [q] : []));
  vi.mocked(judgePosts).mockReset();
  vi.mocked(createJevClient).mockReset().mockReturnValue(fakeClient);
  vi.mocked(loadTasteExamples).mockClear();
  delete process.env.TYPESAFE_API_KEY;
});

afterEach(() => {
  if (originalKey === undefined) delete process.env.TYPESAFE_API_KEY;
  else process.env.TYPESAFE_API_KEY = originalKey;
});

describe("adapterPostToSourcePost", () => {
  it("prefixes id with the adapter name and passes every other field through unchanged", () => {
    const p = adapterPost({ id: "12345", url: "https://arxiv.org/abs/12345", text: "hi", title: "T", author: "Jane", metrics: { likes: 2 }, createdAt: "2026-01-01" });
    expect(adapterPostToSourcePost("arxiv", p)).toEqual({
      id: "arxiv:12345",
      source: "arxiv",
      url: "https://arxiv.org/abs/12345",
      text: "hi",
      author: "Jane",
      metrics: { likes: 2 },
      createdAt: "2026-01-01",
    });
  });

  it("drops AdapterPost's title (SourcePost has none)", () => {
    const p = adapterPost({ id: "1", title: "has a title" });
    const mapped = adapterPostToSourcePost("github", p) as unknown as Record<string, unknown>;
    expect("title" in mapped).toBe(false);
  });

  it("prefixes distinctly per adapter, so two sources' otherwise-identical raw ids never collide", () => {
    const a = adapterPostToSourcePost("arxiv", adapterPost({ id: "1" }));
    const b = adapterPostToSourcePost("github", adapterPost({ id: "1" }));
    expect(a.id).not.toBe(b.id);
  });
});

describe("runScoutSearch", () => {
  it("returns a 'no candidates' summary without calling Jev when every adapter finds nothing", async () => {
    const a = staticAdapter("arxiv", { posts: [], status: "ok" });
    const b = staticAdapter("github", { posts: [], status: "ok" });
    const r = await runScoutSearch(state.db as never, { query: "ai audio", judgeTopic: "ai audio" }, { adapters: [a, b] });
    expect(r).toEqual({
      query: "ai audio", candidates: 0, judged: 0, inserted: 0, skippedDuplicates: 0,
      rounds: 1, minScore: 60, resultsTotal: 20, variantsTried: 2,
      perSource: {
        arxiv: { status: "ok", candidates: 0, judged: 0, strong: 0, inserted: 0, skippedDuplicates: 0, deadVariants: 0 },
        github: { status: "ok", candidates: 0, judged: 0, strong: 0, inserted: 0, skippedDuplicates: 0, deadVariants: 0 },
      },
      note: "no candidates",
    });
    expect(judgePosts).not.toHaveBeenCalled();
    expect(await state.db!.select().from(ideas)).toHaveLength(0);
  });

  it("without Jev, saves what the free sources found, unranked (2026-09-27: \"ok jev opzionale\")", async () => {
    const a = staticAdapter("arxiv", { posts: [adapterPost({ id: "a" }), adapterPost({ id: "b" })], status: "ok" });
    const b = staticAdapter("github", { posts: [], status: "ok" });
    const r = await runScoutSearch(state.db as never, { query: "ai audio", judgeTopic: "ai audio" }, { adapters: [a, b] });
    expect(r).toMatchObject({ query: "ai audio", candidates: 2, judged: 0, inserted: 2, rounds: 1, note: UNRANKED_NOTE });
    expect(r.perSource.arxiv).toMatchObject({ status: "ok", candidates: 2, judged: 0, inserted: 2 });
    expect(createJevClient).not.toHaveBeenCalled();
    expect(judgePosts).not.toHaveBeenCalled();
    const rows = await state.db!.select().from(ideas);
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row).toMatchObject({ source: "scout", status: "new" });
      expect(row.meta).toMatchObject({ unranked: true, topic: "ai audio", sourceName: "arxiv" });
      expect(row.meta).not.toHaveProperty("rank");
    }
  });

  it("without Jev, takes the sources in turn, up to the results total", async () => {
    const a = staticAdapter("arxiv", { posts: ["a1", "a2", "a3"].map((id) => adapterPost({ id })), status: "ok" });
    const b = staticAdapter("github", { posts: ["g1", "g2"].map((id) => adapterPost({ id })), status: "ok" });
    const r = await runScoutSearch(state.db as never, { query: "q", judgeTopic: "q" }, { adapters: [a, b], resultsTotal: 3 });
    expect(r.inserted).toBe(3);
    const urls = (await state.db!.select().from(ideas)).map((row) => row.url).sort();
    expect(urls).toEqual(["https://example.com/a1", "https://example.com/a2", "https://example.com/g1"]);
  });

  it("uses a caller-supplied deps.jev even when TYPESAFE_API_KEY is unset", async () => {
    const a = staticAdapter("arxiv", { posts: [adapterPost({ id: "a" })], status: "ok" });
    vi.mocked(judgePosts).mockResolvedValueOnce([judgment("arxiv:a", 90)]);
    const r = await runScoutSearch(state.db as never, { query: "q", judgeTopic: "q" }, { adapters: [a], jev: fakeClient });
    expect(r.inserted).toBe(1);
    expect(createJevClient).not.toHaveBeenCalled();
    expect(judgePosts).toHaveBeenCalledWith(fakeClient, expect.objectContaining({ topic: "q" }));
  });

  it("tells each step as it happens, and a listener that throws never stops the search (2026-09-27)", async () => {
    const a = staticAdapter("arxiv", { posts: [adapterPost({ id: "a" })], status: "ok" });
    vi.mocked(judgePosts).mockResolvedValueOnce([judgment("arxiv:a", 90)]);
    const steps: unknown[] = [];
    const r = await runScoutSearch(state.db as never, { query: "q", judgeTopic: "q" }, {
      adapters: [a], jev: fakeClient, resultsTotal: 1,
      onStep: (step) => { steps.push(step); throw new Error("page gone"); },
    });
    expect(r.inserted).toBe(1);
    expect(steps.slice(0, 3)).toEqual([
      { step: "searching", round: 1, sources: 1 },
      { step: "ranking", round: 1, posts: 1 },
      { step: "saving", count: 1 },
    ]);
  });

  it("builds a client via createJevClient when TYPESAFE_API_KEY is set and no deps.jev given", async () => {
    process.env.TYPESAFE_API_KEY = "test-key";
    const a = staticAdapter("arxiv", { posts: [adapterPost({ id: "a" })], status: "ok" });
    vi.mocked(judgePosts).mockResolvedValueOnce([judgment("arxiv:a", 90)]);
    await runScoutSearch(state.db as never, { query: "q", judgeTopic: "q" }, { adapters: [a] });
    expect(createJevClient).toHaveBeenCalledTimes(1);
    expect(judgePosts).toHaveBeenCalledWith(fakeClient, expect.objectContaining({ topic: "q" }));
  });

  it("passes judgeTopic (not query) as the judging topic, and candidate id/text/author/metrics as posts", async () => {
    process.env.TYPESAFE_API_KEY = "k";
    const a = staticAdapter("hackernews", {
      posts: [adapterPost({ id: "a", text: "hello world", author: "ronin", metrics: { likes: 5, replies: 2 } })],
      status: "ok",
    });
    vi.mocked(judgePosts).mockResolvedValueOnce([judgment("hackernews:a", 90)]);
    await runScoutSearch(state.db as never, { query: "kw", judgeTopic: "the full seed text" }, { adapters: [a] });
    expect(judgePosts).toHaveBeenCalledWith(fakeClient, {
      topic: "the full seed text",
      posts: [{ id: "hackernews:a", text: "hello world", author: "ronin", metrics: { likes: 5, replies: 2 } }],
      kinds: jevKinds(DEFAULT_FIND_ORDER),
      options: { relevanceGate: RELEVANCE_GATE },
    });
  });

  it("converts a null candidate author to undefined for jev-judge's PostInput", async () => {
    process.env.TYPESAFE_API_KEY = "k";
    const a = staticAdapter("arxiv", { posts: [adapterPost({ id: "a", author: null })], status: "ok" });
    vi.mocked(judgePosts).mockResolvedValueOnce([judgment("arxiv:a", 90)]);
    await runScoutSearch(state.db as never, { query: "q", judgeTopic: "q" }, { adapters: [a] });
    const call = vi.mocked(judgePosts).mock.calls[0][1];
    expect(call.posts[0].author).toBeUndefined();
  });

  it("passes each adapter's search the deps fetcher and candidatesPerSource as the limit", async () => {
    process.env.TYPESAFE_API_KEY = "k";
    const searchA = vi.fn().mockResolvedValue({ posts: [], status: "ok" });
    const searchB = vi.fn().mockResolvedValue({ posts: [], status: "ok" });
    const a = fakeAdapter({ name: "arxiv", search: searchA });
    const b = fakeAdapter({ name: "github", search: searchB });
    const fetcher = vi.fn();
    await runScoutSearch(state.db as never, { query: "q", judgeTopic: "q" }, { adapters: [a, b], fetcher, candidatesPerSource: 7 });
    expect(searchA).toHaveBeenCalledWith("q", expect.objectContaining({ fetcher, limit: 7 }));
    expect(searchB).toHaveBeenCalledWith("q", expect.objectContaining({ fetcher, limit: 7 }));
  });

  it("uses a real fetch-backed default fetcher when deps.fetcher is omitted", async () => {
    const search = vi.fn().mockResolvedValue({ posts: [], status: "ok" });
    const a = fakeAdapter({ name: "arxiv", search });
    await runScoutSearch(state.db as never, { query: "q", judgeTopic: "q" }, { adapters: [a] });
    const passedFetcher = search.mock.calls[0][1].fetcher;
    expect(typeof passedFetcher).toBe("function");
  });

  describe("per-source status and candidate counts", () => {
    it("tallies candidates per source and marks a throwing adapter's status as error, without affecting the other adapter", async () => {
      process.env.TYPESAFE_API_KEY = "k";
      const a = staticAdapter("arxiv", {
        posts: [adapterPost({ id: "a1", url: "https://a/1" }), adapterPost({ id: "a2", url: "https://a/2" })],
        status: "ok",
      });
      const b = fakeAdapter({ name: "github", search: vi.fn().mockRejectedValue(new Error("boom")) });
      vi.mocked(judgePosts).mockResolvedValueOnce([judgment("arxiv:a1", 90), judgment("arxiv:a2", 90)]);

      const r = await runScoutSearch(state.db as never, { query: "q", judgeTopic: "q" }, { adapters: [a, b] });
      expect(r.perSource.arxiv.status).toBe("ok");
      expect(r.perSource.arxiv.candidates).toBe(2);
      expect(r.perSource.github.status).toBe("error");
      expect(r.perSource.github.candidates).toBe(0);
    });

    it("reports an adapter's status ok even when its own search resolves an error AdapterResult (not just on throw)", async () => {
      const a = staticAdapter("arxiv", { posts: [], status: "error", note: "request failed with status 500" });
      const r = await runScoutSearch(state.db as never, { query: "q", judgeTopic: "q" }, { adapters: [a] });
      expect(r.perSource.arxiv.status).toBe("error");
    });

    it("reports a disabled adapter (missing requiredEnv) and makes no search call for it", async () => {
      const search = vi.fn().mockResolvedValue({ posts: [], status: "ok" });
      const gated = fakeAdapter({ name: "reddit", requiredEnv: ["SOME_TEST_ONLY_KEY_NOT_SET"], search });
      const b = staticAdapter("github", { posts: [adapterPost({ id: "h1" })], status: "ok" });
      const r = await runScoutSearch(state.db as never, { query: "q", judgeTopic: "q" }, { adapters: [gated, b] });
      expect(r.perSource.reddit).toEqual({ status: "disabled", candidates: 0, judged: 0, strong: 0, inserted: 0, skippedDuplicates: 0, deadVariants: 0 });
      expect(search).not.toHaveBeenCalled();
    });

    it("reports perSource (including a disabled adapter) on the 'no candidates' early return", async () => {
      const gated = fakeAdapter({ name: "reddit", requiredEnv: ["SOME_TEST_ONLY_KEY_NOT_SET"] });
      const b = staticAdapter("github", { posts: [], status: "ok" });
      const r = await runScoutSearch(state.db as never, { query: "q", judgeTopic: "q" }, { adapters: [gated, b] });
      expect(r.perSource.reddit).toEqual({ status: "disabled", candidates: 0, judged: 0, strong: 0, inserted: 0, skippedDuplicates: 0, deadVariants: 0 });
      expect(r.perSource.github).toEqual({ status: "ok", candidates: 0, judged: 0, strong: 0, inserted: 0, skippedDuplicates: 0, deadVariants: 0 });
      expect(r.note).toBe("no candidates");
    });

    it("reports perSource (including a disabled adapter) on a search without Jev", async () => {
      const gated = fakeAdapter({ name: "reddit", requiredEnv: ["SOME_TEST_ONLY_KEY_NOT_SET"] });
      const b = staticAdapter("github", { posts: [adapterPost({ id: "a" })], status: "ok" });
      const r = await runScoutSearch(state.db as never, { query: "q", judgeTopic: "q" }, { adapters: [gated, b] });
      expect(r.perSource.reddit.status).toBe("disabled");
      expect(r.perSource.github).toEqual({ status: "ok", candidates: 1, judged: 0, strong: 0, inserted: 1, skippedDuplicates: 0, deadVariants: 0 });
    });
  });

  describe("query-variant expansion (per adapter)", () => {
    beforeEach(() => { process.env.TYPESAFE_API_KEY = "k"; });

    it("tries the next variant when the first yields nothing", async () => {
      vi.mocked(queryVariants).mockReturnValue(["v1", "v2"]);
      const a = scriptedAdapter("arxiv", [{ posts: [], status: "ok" }, { posts: [adapterPost({ id: "a" })], status: "ok" }]);
      vi.mocked(judgePosts).mockResolvedValueOnce([judgment("arxiv:a", 90)]);

      // resultsTotal: 1 so round 1's single strong hit satisfies the run —
      // this test is about variant order within a round, not about rounds.
      const r = await runScoutSearch(state.db as never, { query: "full query", judgeTopic: "q" }, { adapters: [a], resultsTotal: 1 });
      expect(r.candidates).toBe(1);
      expect(vi.mocked(a.search).mock.calls).toHaveLength(2);
      expect(vi.mocked(a.search).mock.calls[0][0]).toBe("v1");
      expect(vi.mocked(a.search).mock.calls[1][0]).toBe("v2");
    });

    it("stops once candidatesPerSource is reached, without trying further variants", async () => {
      vi.mocked(queryVariants).mockReturnValue(["v1", "v2", "v3"]);
      const a = scriptedAdapter("arxiv", [{
        posts: [adapterPost({ id: "a", url: "https://a/1" }), adapterPost({ id: "b", url: "https://a/2" })],
        status: "ok",
      }]);
      vi.mocked(judgePosts).mockResolvedValueOnce([judgment("arxiv:a", 90), judgment("arxiv:b", 90)]);

      // resultsTotal: 2 so round 1 satisfies the run (see the rounds block for multi-round behavior).
      await runScoutSearch(state.db as never, { query: "q", judgeTopic: "q" }, { adapters: [a], candidatesPerSource: 2, resultsTotal: 2 });
      expect(vi.mocked(a.search).mock.calls).toHaveLength(1);
    });

    it("caps at 5 variant attempts per adapter even when more variants are available", async () => {
      vi.mocked(queryVariants).mockReturnValue(["v1", "v2", "v3", "v4", "v5", "v6"]);
      const a = staticAdapter("arxiv", { posts: [], status: "ok" });

      const r = await runScoutSearch(state.db as never, { query: "q", judgeTopic: "q" }, { adapters: [a], candidatesPerSource: 12 });
      expect(vi.mocked(a.search).mock.calls).toHaveLength(5);
      expect(r.note).toBe("no candidates");
    });

    it("dedupes accumulated candidates by url within an adapter across variants", async () => {
      vi.mocked(queryVariants).mockReturnValue(["v1", "v2"]);
      const a = scriptedAdapter("arxiv", [
        { posts: [adapterPost({ id: "a", url: "https://a/1" }), adapterPost({ id: "b", url: "https://a/2" })], status: "ok" },
        { posts: [adapterPost({ id: "b-dup", url: "https://a/2" }), adapterPost({ id: "c", url: "https://a/3" })], status: "ok" },
      ]);
      vi.mocked(judgePosts).mockResolvedValueOnce([judgment("arxiv:a", 90), judgment("arxiv:b", 90), judgment("arxiv:c", 90)]);

      const r = await runScoutSearch(state.db as never, { query: "q", judgeTopic: "q" }, { adapters: [a], candidatesPerSource: 12 });
      expect(r.candidates).toBe(3);
      const rows = await state.db!.select().from(ideas);
      expect(rows.map((row) => row.url).sort()).toEqual(["https://a/1", "https://a/2", "https://a/3"]);
    });

    it("records which variant produced each candidate as meta.queryVariant", async () => {
      vi.mocked(queryVariants).mockReturnValue(["v1", "v2"]);
      const a = scriptedAdapter("arxiv", [{ posts: [], status: "ok" }, { posts: [adapterPost({ id: "a", url: "https://a/1" })], status: "ok" }]);
      vi.mocked(judgePosts).mockResolvedValueOnce([judgment("arxiv:a", 90)]);

      await runScoutSearch(state.db as never, { query: "q", judgeTopic: "q" }, { adapters: [a] });
      const [row] = await state.db!.select().from(ideas);
      expect((row.meta as { queryVariant?: string }).queryVariant).toBe("v2");
    });

    it("one adapter erroring on every variant attempt doesn't prevent another adapter's candidates from being judged/inserted", async () => {
      const a = scriptedAdapter("reddit", ["reject"]);
      const b = staticAdapter("github", { posts: [adapterPost({ id: "h1", url: "https://a/1" })], status: "ok" });
      vi.mocked(judgePosts).mockResolvedValueOnce([judgment("github:h1", 90)]);

      const r = await runScoutSearch(state.db as never, { query: "q", judgeTopic: "q" }, { adapters: [a, b] });
      expect(r.perSource.reddit.status).toBe("error");
      expect(r.perSource.github.status).toBe("ok");
      expect(r.inserted).toBe(1);
      const rows = await state.db!.select().from(ideas);
      expect(rows).toHaveLength(1);
      expect(rows[0].url).toBe("https://a/1");
    });
  });

  describe("global top-N ranking among strong (rank >= minScore) candidates", () => {
    beforeEach(() => { process.env.TYPESAFE_API_KEY = "k"; });

    it("selects the top resultsTotal by rank across ALL sources as one shared pool — a stronger source takes more slots", async () => {
      const names = ["arxiv", "github", "devto"];
      const adapters = names.map((name) =>
        staticAdapter(name, {
          posts: Array.from({ length: 4 }, (_, i) => adapterPost({ id: `${name}${i}`, url: `https://${name}/${i}` })),
          status: "ok",
        }),
      );
      // Ranks staggered across sources (arxiv highest, devto lowest): the
      // global top-6 is all 4 arxiv + the best 2 github + 0 devto — even
      // though every devto candidate clears minScore too.
      const judgments = names.flatMap((name, sourceIdx) =>
        Array.from({ length: 4 }, (_, i) => judgment(`${name}:${name}${i}`, 90, false, { rank: 100 - sourceIdx * 10 - i })),
      );
      vi.mocked(judgePosts).mockResolvedValueOnce(judgments);

      const r = await runScoutSearch(state.db as never, { query: "q", judgeTopic: "q" }, { adapters, resultsTotal: 6 });
      expect(r.rounds).toBe(1);
      expect(r.inserted).toBe(6);
      expect(r.perSource.arxiv).toMatchObject({ strong: 4, inserted: 4 });
      expect(r.perSource.github).toMatchObject({ strong: 4, inserted: 2 });
      expect(r.perSource.devto).toMatchObject({ strong: 4, inserted: 0 });
      const rows = await state.db!.select().from(ideas);
      expect(rows.map((row) => row.url).sort()).toEqual([
        "https://arxiv/0", "https://arxiv/1", "https://arxiv/2", "https://arxiv/3", "https://github/0", "https://github/1",
      ]);
    });

    // arxiv: 12 strong (ranks 98..87); github: 2 strong (99, 95) + 10 weak (10).
    function unevenFixture() {
      const arxivPosts = pool("a", 12);
      const githubPosts = pool("g", 12);
      const adapters = [
        staticAdapter("arxiv", { posts: arxivPosts, status: "ok" }),
        staticAdapter("github", { posts: githubPosts, status: "ok" }),
      ];
      vi.mocked(judgePosts).mockResolvedValueOnce([
        ...arxivPosts.map((p, i) => judgment(`arxiv:${p.id}`, 90, false, { rank: 98 - i })),
        ...githubPosts.map((p, i) => judgment(`github:${p.id}`, 90, false, { rank: i === 0 ? 99 : i === 1 ? 95 : 10 })),
      ]);
      return adapters;
    }

    it("the global pick can be uneven across sources: 8 from one, 2 from another", async () => {
      const adapters = unevenFixture();

      const r = await runScoutSearch(state.db as never, { query: "q", judgeTopic: "q" }, { adapters, candidatesPerSource: 12, resultsTotal: 10 });
      expect(r.rounds).toBe(1);
      expect(r.inserted).toBe(10);
      expect(r.perSource.arxiv).toMatchObject({ strong: 12, inserted: 8 });
      expect(r.perSource.github).toMatchObject({ strong: 2, inserted: 2 });
      // Top 10 by rank: g1 99, a1 98, a2 97, a3 96, g2 95, a4 94 … a8 90.
      const rows = await state.db!.select().from(ideas);
      expect(rows.map((row) => row.url).sort()).toEqual([
        ...Array.from({ length: 8 }, (_, i) => `https://a/${i + 1}`), "https://g/1", "https://g/2",
      ]);
    });

    it("with more slots than strong candidates, inserts every strong one and nothing weak — weak candidates never fill the quota", async () => {
      const adapters = unevenFixture();

      // 14 strong, 10 weak, quota 20: static sources have nothing new in
      // round 2, so the run stops exhausted at 14 rather than padding with weak ones.
      const r = await runScoutSearch(state.db as never, { query: "q", judgeTopic: "q" }, { adapters, candidatesPerSource: 12, resultsTotal: 20 });
      expect(r.rounds).toBe(2);
      expect(r.inserted).toBe(14);
      expect(r.perSource.arxiv).toMatchObject({ strong: 12, inserted: 12 });
      expect(r.perSource.github).toMatchObject({ strong: 2, inserted: 2 });
      const rows = await state.db!.select().from(ideas);
      expect(rows).toHaveLength(14);
      expect(rows.every((row) => (row.meta as { rank: number }).rank >= 60)).toBe(true);
    });

    it("never inserts a candidate with rank below minScore (default 60), even when that leaves the run short of resultsTotal", async () => {
      const a = staticAdapter("arxiv", {
        posts: [adapterPost({ id: "low", url: "https://a/low" }), adapterPost({ id: "high", url: "https://a/high" })],
        status: "ok",
      });
      // Relevance is high on BOTH — the cutoff is on `rank` (the ✦ number the
      // card shows), not on relevance; 59 is out, 60 is in.
      vi.mocked(judgePosts).mockResolvedValueOnce([
        judgment("arxiv:low", 90, false, { rank: 59 }),
        judgment("arxiv:high", 90, false, { rank: 60 }),
      ]);

      const r = await runScoutSearch(state.db as never, { query: "q", judgeTopic: "q" }, { adapters: [a], resultsTotal: 5 });
      expect(r.inserted).toBe(1);
      const rows = await state.db!.select().from(ideas);
      expect(rows.map((row) => row.url)).toEqual(["https://a/high"]);
      expect("lowMatch" in (rows[0].meta as Record<string, unknown>)).toBe(false);
    });

    it("reads scoutMinScore from kv settings when deps.minScore is not given", async () => {
      await setSetting(state.db as never, "scoutMinScore", 50);
      const a = staticAdapter("arxiv", { posts: [adapterPost({ id: "a", url: "https://a/1" })], status: "ok" });
      vi.mocked(judgePosts).mockResolvedValueOnce([judgment("arxiv:a", 55)]);

      const r = await runScoutSearch(state.db as never, { query: "q", judgeTopic: "q" }, { adapters: [a] });
      expect(r.inserted).toBe(1);
    });

    it("deps.minScore overrides the kv setting", async () => {
      await setSetting(state.db as never, "scoutMinScore", 50);
      const a = staticAdapter("arxiv", { posts: [adapterPost({ id: "a", url: "https://a/1" })], status: "ok" });
      vi.mocked(judgePosts).mockResolvedValueOnce([judgment("arxiv:a", 55)]);

      const r = await runScoutSearch(state.db as never, { query: "q", judgeTopic: "q" }, { adapters: [a], minScore: 70 });
      expect(r.inserted).toBe(0);
      expect(await state.db!.select().from(ideas)).toHaveLength(0);
    });

    it("still excludes spam regardless of relevance/rank", async () => {
      const a = staticAdapter("arxiv", { posts: [adapterPost({ id: "a", url: "https://a/1" })], status: "ok" });
      vi.mocked(judgePosts).mockResolvedValueOnce([judgment("arxiv:a", 95, true)]);

      const r = await runScoutSearch(state.db as never, { query: "q", judgeTopic: "q" }, { adapters: [a] });
      expect(r.inserted).toBe(0);
      expect(await state.db!.select().from(ideas)).toHaveLength(0);
    });

    it("reads scoutResultsTotal from kv settings when deps.resultsTotal is not given", async () => {
      await setSetting(state.db as never, "scoutResultsTotal", 2);
      const posts = Array.from({ length: 4 }, (_, i) => adapterPost({ id: `b${i}`, url: `https://b/${i}` }));
      const a = staticAdapter("arxiv", { posts, status: "ok" });
      vi.mocked(judgePosts).mockResolvedValueOnce(posts.map((p, i) => judgment(`arxiv:${p.id}`, 90 - i)));

      const r = await runScoutSearch(state.db as never, { query: "q", judgeTopic: "q" }, { adapters: [a] });
      expect(r.resultsTotal).toBe(2);
      expect(r.inserted).toBe(2);
    });

    it("deps.resultsTotal overrides the kv setting", async () => {
      await setSetting(state.db as never, "scoutResultsTotal", 2);
      const posts = Array.from({ length: 4 }, (_, i) => adapterPost({ id: `b${i}`, url: `https://b/${i}` }));
      const a = staticAdapter("arxiv", { posts, status: "ok" });
      vi.mocked(judgePosts).mockResolvedValueOnce(posts.map((p, i) => judgment(`arxiv:${p.id}`, 90 - i)));

      const r = await runScoutSearch(state.db as never, { query: "q", judgeTopic: "q" }, { adapters: [a], resultsTotal: 1 });
      expect(r.resultsTotal).toBe(1);
      expect(r.inserted).toBe(1);
    });

    it("reads scoutCandidatesPerSource from kv settings when deps.candidatesPerSource is not given", async () => {
      await setSetting(state.db as never, "scoutCandidatesPerSource", 3);
      const search = vi.fn().mockResolvedValue({ posts: [], status: "ok" });
      const a = fakeAdapter({ name: "arxiv", search });
      await runScoutSearch(state.db as never, { query: "q", judgeTopic: "q" }, { adapters: [a] });
      expect(search).toHaveBeenCalledWith("q", expect.objectContaining({ limit: 3 }));
    });

    it("counts an already-saved url as a skipped duplicate instead of a new insert", async () => {
      const a = staticAdapter("arxiv", { posts: [adapterPost({ id: "a", url: "https://a/1" })], status: "ok" });
      vi.mocked(judgePosts).mockResolvedValueOnce([judgment("arxiv:a", 90)]).mockResolvedValueOnce([judgment("arxiv:a", 90)]);

      const first = await runScoutSearch(state.db as never, { query: "q", judgeTopic: "q" }, { adapters: [a] });
      expect(first.inserted).toBe(1);
      expect(first.skippedDuplicates).toBe(0);

      const second = await runScoutSearch(state.db as never, { query: "q", judgeTopic: "q" }, { adapters: [a] });
      expect(second.inserted).toBe(0);
      expect(second.skippedDuplicates).toBe(1);
      expect(second.perSource.arxiv.skippedDuplicates).toBe(1);
      expect(await state.db!.select().from(ideas)).toHaveLength(1);
    });

    it("brings back a post its cleared search had archived, under the new search; a dismissed one stays out (2026-09-27)", async () => {
      const a = staticAdapter("arxiv", { posts: [adapterPost({ id: "a", url: "https://a/1" }), adapterPost({ id: "b", url: "https://a/2" })], status: "ok" });
      const both = [judgment("arxiv:a", 90), judgment("arxiv:b", 88)];
      vi.mocked(judgePosts).mockResolvedValueOnce(both).mockResolvedValueOnce(both);
      await runScoutSearch(state.db as never, { query: "q", judgeTopic: "q" }, { adapters: [a] });
      // × on the chip archived what was still new; the owner had dismissed the other.
      await state.db!.update(ideas).set({ status: "archived" }).where(eq(ideas.url, "https://a/1"));
      await state.db!.update(ideas).set({ status: "dismissed" }).where(eq(ideas.url, "https://a/2"));

      const again = await runScoutSearch(state.db as never, { query: "q again", judgeTopic: "q again" }, { adapters: [a] });
      expect(again.inserted).toBe(1);
      expect(again.skippedDuplicates).toBe(1);
      const rows = await state.db!.select().from(ideas);
      expect(rows.find((r) => r.url === "https://a/1")).toMatchObject({ status: "new", meta: expect.objectContaining({ topic: "q again" }) });
      expect(rows.find((r) => r.url === "https://a/2")?.status).toBe("dismissed");
    });

    it("gives a card the whole text its source had cut, when a search finds it again; Liked ones keep theirs (2026-09-27)", async () => {
      const cut = "From Idea to Exit — Jake Heller is the co-founder of Casetext, acquired by ...";
      const whole = "From Idea to Exit — Jake Heller is the co-founder of Casetext, acquired by Thomson Reuters for $650M.";
      const first = staticAdapter("youtube", { posts: [adapterPost({ id: "v1", url: "https://y/1", text: cut }), adapterPost({ id: "v2", url: "https://y/2", text: cut })], status: "ok" });
      const again = staticAdapter("youtube", { posts: [adapterPost({ id: "v1", url: "https://y/1", text: whole }), adapterPost({ id: "v2", url: "https://y/2", text: whole })], status: "ok" });
      const both = [judgment("youtube:v1", 90), judgment("youtube:v2", 88)];
      vi.mocked(judgePosts).mockResolvedValueOnce(both).mockResolvedValueOnce(both);
      await runScoutSearch(state.db as never, { query: "q", judgeTopic: "q" }, { adapters: [first] });
      await state.db!.update(ideas).set({ status: "kept" }).where(eq(ideas.url, "https://y/2"));

      const r = await runScoutSearch(state.db as never, { query: "q", judgeTopic: "q" }, { adapters: [again] });
      expect(r.skippedDuplicates).toBe(2);
      const rows = await state.db!.select().from(ideas);
      expect(rows.find((row) => row.url === "https://y/1")?.content).toBe(whole);
      expect(rows.find((row) => row.url === "https://y/2")?.content).toBe(cut);
    });

    it("summarizes the picked Hacker News/Lobsters cards right after the pick — title — summary on the card, the full text in meta; other kinds untouched; a read that gives nothing leaves the row as is", async () => {
      const hn1 = adapterPost({ id: "41", url: "https://news.ycombinator.com/item?id=41", text: "How We built a $1M ARR open source SaaS", author: "caust1c" });
      const hn2 = adapterPost({ id: "42", url: "https://news.ycombinator.com/item?id=42", text: "Ask HN: pricing?", author: "eve" });
      const bsky = adapterPost({ id: "b", url: "https://bsky.app/profile/a/post/1", text: "a post" });
      const hnAdapter = staticAdapter("hackernews", { posts: [hn1, hn2], status: "ok" });
      const bskyAdapter = staticAdapter("bluesky", { posts: [bsky], status: "ok" });
      vi.mocked(judgePosts).mockResolvedValueOnce([
        judgment("hackernews:41", 88, false, { rank: 80 }),
        judgment("hackernews:42", 85, false, { rank: 75 }),
        judgment("bluesky:b", 84, false, { rank: 70 }),
      ]);
      const fakeRead = {
        text: "How We built a $1M ARR open source SaaS\nLink: https://blog.example.com/arr\n\nArticle extract (blog.example.com):\nWe doubled down…",
        title: "How We built a $1M ARR open source SaaS",
        summary: "We doubled down on self-serve onboarding.",
        articleUrl: "https://blog.example.com/arr",
        discussionUrl: "https://news.ycombinator.com/item?id=41",
        parts: ["article" as const],
        notes: [],
      };
      const deepRead = vi.fn(async (row: { url: string | null }) => (row.url === hn1.url ? fakeRead : null));

      const summary = await runScoutSearch(state.db as never, { query: "q", judgeTopic: "q" }, { adapters: [hnAdapter, bskyAdapter], deepRead });
      expect(summary.inserted).toBe(3);

      // Only the discussion-source rows are read, with the scout's short timeout.
      expect(deepRead).toHaveBeenCalledTimes(2);
      expect(deepRead.mock.calls.map((c) => c[0].url).sort()).toEqual([hn1.url, hn2.url].sort());
      expect((deepRead.mock.calls[0] as unknown[])[2]).toEqual({ timeoutMs: 4000 });

      const rows = await state.db!.select().from(ideas);
      const byUrl = Object.fromEntries(rows.map((r) => [r.url, r]));
      expect(byUrl[hn1.url].content).toBe("How We built a $1M ARR open source SaaS — We doubled down on self-serve onboarding.");
      expect(byUrl[hn1.url].meta).toMatchObject({ topic: "q", sourceId: "hackernews:41", deepReadText: fakeRead.text, deepReadParts: ["article"], articleUrl: "https://blog.example.com/arr" });
      expect(typeof byUrl[hn1.url].meta.deepReadAt).toBe("string");
      expect(byUrl[hn2.url].content).toBe("Ask HN: pricing?");
      expect(byUrl[hn2.url].meta.deepReadAt).toBeUndefined();
      expect(byUrl[bsky.url].content).toBe("a post");
    });

    it("rates the saved cards' AI style in one batch after the summaries; bare titles and already rated cards are skipped", async () => {
      const long = (s: string) => `${s} `.repeat(30).trim();
      const b1 = adapterPost({ id: "b1", url: "https://bsky.app/profile/a/post/1", text: long("a real post") });
      const b2 = adapterPost({ id: "b2", url: "https://bsky.app/profile/a/post/2", text: "short one" });
      const hn = adapterPost({ id: "41", url: "https://news.ycombinator.com/item?id=41", text: "A bare HN title" });
      const bsky = staticAdapter("bluesky", { posts: [b1, b2], status: "ok" });
      const hnA = staticAdapter("hackernews", { posts: [hn], status: "ok" });
      vi.mocked(judgePosts).mockResolvedValueOnce([
        judgment("bluesky:b1", 88, false, { rank: 80 }), judgment("bluesky:b2", 86, false, { rank: 78 }), judgment("hackernews:41", 85, false, { rank: 76 }),
      ]);
      const deepRead = vi.fn(async () => ({
        text: "full", title: "A bare HN title", summary: long("The article opens with a plain sentence"),
        articleUrl: "https://a.example/x", discussionUrl: hn.url, parts: ["article" as const], notes: [],
      }));
      const rateAiStyle = vi.fn(async (_client: unknown, args: { posts: Array<{ id: string; text: string }> }) =>
        args.posts.map((p) => ({ id: p.id, slopScore: 20, verdict: "human" as const })));

      await runScoutSearch(state.db as never, { query: "q", judgeTopic: "q" }, { adapters: [bsky, hnA], deepRead, rateAiStyle });

      expect(rateAiStyle).toHaveBeenCalledTimes(1);
      const rated = rateAiStyle.mock.calls[0]![1].posts;
      const rows = await state.db!.select().from(ideas);
      const byUrl = Object.fromEntries(rows.map((r) => [r.url, r]));
      // The HN card is rated on its summary (read first), the short post not at all.
      expect(rated.map((p) => p.id).sort()).toEqual([byUrl[b1.url].id, byUrl[hn.url].id].sort());
      expect(rated.find((p) => p.id === byUrl[hn.url].id)!.text).toContain("The article opens with a plain sentence");
      expect(byUrl[b1.url].meta).toMatchObject({ aiStyle: { slopScore: 20, verdict: "human" } });
      expect(byUrl[b2.url].meta.aiStyle).toBeUndefined();
    });

    it("a failing AI-style batch leaves the cards unrated and the search's results stand", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const p = adapterPost({ id: "b1", url: "https://bsky.app/profile/a/post/1", text: "long enough text for a rating ".repeat(4) });
      vi.mocked(judgePosts).mockResolvedValueOnce([judgment("bluesky:b1", 88, false, { rank: 80 })]);
      const rateAiStyle = vi.fn(async () => { throw new Error("jev down"); });
      const summary = await runScoutSearch(state.db as never, { query: "q", judgeTopic: "q" }, { adapters: [staticAdapter("bluesky", { posts: [p], status: "ok" })], rateAiStyle });
      expect(summary.inserted).toBe(1);
      const [row] = await state.db!.select().from(ideas);
      expect(row.meta.aiStyle).toBeUndefined();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("AI-style rating skipped: jev down"));
      warn.mockRestore();
    });

    it("a read that throws is contained: the search still returns and the other cards are summarized", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const hn1 = adapterPost({ id: "41", url: "https://news.ycombinator.com/item?id=41", text: "t1" });
      const hn2 = adapterPost({ id: "42", url: "https://news.ycombinator.com/item?id=42", text: "t2" });
      const a = staticAdapter("hackernews", { posts: [hn1, hn2], status: "ok" });
      vi.mocked(judgePosts).mockResolvedValueOnce([judgment("hackernews:41", 88, false, { rank: 80 }), judgment("hackernews:42", 85, false, { rank: 75 })]);
      const deepRead = vi.fn(async (row: { url: string | null }) => {
        if (row.url === hn1.url) throw new Error("socket hang up");
        return { text: "full", title: "t2", summary: "the gist", articleUrl: null, discussionUrl: hn2.url, parts: ["discussion" as const], notes: [] };
      });
      const summary = await runScoutSearch(state.db as never, { query: "q", judgeTopic: "q" }, { adapters: [a], deepRead });
      expect(summary.inserted).toBe(2);
      const rows = await state.db!.select().from(ideas);
      const byUrl = Object.fromEntries(rows.map((r) => [r.url, r]));
      expect(byUrl[hn1.url].content).toBe("t1");
      expect(byUrl[hn2.url].content).toBe("t2 — the gist");
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("1 failed — socket hang up"));
      warn.mockRestore();
    });

    it("inserts with the documented meta shape (score, quality, tasteFit, rank, postKind, kindFit, topic=query, sourceName, metrics, queryVariant), kind = adapter name", async () => {
      const p = adapterPost({ id: "a", url: "https://a/1", text: "hn post text", author: "hnuser", metrics: { likes: 42, replies: 7 } });
      const a = staticAdapter("hackernews", { posts: [p], status: "ok" });
      vi.mocked(judgePosts).mockResolvedValueOnce([judgment("hackernews:a", 88, false, { quality: 70, tasteFit: 0.42, rank: 75 })]);

      // query (search keywords) deliberately differs from judgeTopic (full seed
      // text) — meta.topic must be the *query*, not judgeTopic.
      await runScoutSearch(state.db as never, { query: "hn kw", judgeTopic: "the full seed text" }, { adapters: [a] });

      const [row] = await state.db!.select().from(ideas);
      expect(row.kind).toBe("hackernews");
      expect(row.source).toBe("scout");
      expect(row.url).toBe("https://a/1");
      expect(row.content).toBe("hn post text");
      expect(row.author).toBe("hnuser");
      expect(row.meta).toEqual({
        score: 88, quality: 70, tasteFit: 0.42, rank: 75,
        // No kind in this judgment: stored as null, not left out.
        postKind: null, kindFit: null,
        topic: "hn kw", sourceName: "hackernews", sourceId: "hackernews:a", metrics: { likes: 42, replies: 7 },
        queryVariant: "hn kw",
      });
    });

    it("returns no note on a normal successful run", async () => {
      const a = staticAdapter("arxiv", { posts: [adapterPost({ id: "a", url: "https://a/1" })], status: "ok" });
      vi.mocked(judgePosts).mockResolvedValueOnce([judgment("arxiv:a", 90)]);
      const r = await runScoutSearch(state.db as never, { query: "q", judgeTopic: "q" }, { adapters: [a] });
      expect(r.note).toBeUndefined();
    });

    it("reports an accurate perSource summary (status, candidates, judged, inserted, skippedDuplicates) across two adapters", async () => {
      const aPosts = [adapterPost({ id: "b1", url: "https://b/1" }), adapterPost({ id: "b2", url: "https://b/2" })];
      const bPosts = [adapterPost({ id: "h1", url: "https://h/1" })];
      const a = staticAdapter("arxiv", { posts: aPosts, status: "ok" });
      const b = staticAdapter("github", { posts: bPosts, status: "ok" });
      // arxiv:b2 is judged (counted) but weak (rank 10 < 60), so it's never inserted.
      vi.mocked(judgePosts).mockResolvedValueOnce([judgment("arxiv:b1", 90), judgment("arxiv:b2", 10), judgment("github:h1", 90)]);

      const r = await runScoutSearch(state.db as never, { query: "q", judgeTopic: "q" }, { adapters: [a, b] });
      expect(r.perSource).toEqual({
        arxiv: { status: "ok", candidates: 2, judged: 2, strong: 1, inserted: 1, skippedDuplicates: 0, deadVariants: 0 },
        github: { status: "ok", candidates: 1, judged: 1, strong: 1, inserted: 1, skippedDuplicates: 0, deadVariants: 0 },
      });
      expect(r.candidates).toBe(3);
      expect(r.judged).toBe(3);
      expect(r.inserted).toBe(2);
    });
  });

  describe("rounds — keep searching until the run has resultsTotal strong matches", () => {
    beforeEach(() => { process.env.TYPESAFE_API_KEY = "k"; });

    it("runs a second round when round 1 falls short of resultsTotal: same adapter, larger limit, only the NEW candidates judged", async () => {
      const a = pooledAdapter("arxiv", pool("a", 4));
      vi.mocked(judgePosts)
        // Round 1 (limit 2 → a1, a2): one strong, one weak → 1 of 2.
        .mockResolvedValueOnce([judgment("arxiv:a1", 90), judgment("arxiv:a2", 30)])
        // Round 2 (limit 4 → a1..a4; a1/a2 already seen): only a3, a4 are new.
        .mockResolvedValueOnce([judgment("arxiv:a3", 80), judgment("arxiv:a4", 20)]);

      const r = await runScoutSearch(state.db as never, { query: "q", judgeTopic: "q" }, { adapters: [a], candidatesPerSource: 2, resultsTotal: 2 });

      const calls = vi.mocked(a.search).mock.calls;
      expect(calls).toHaveLength(2);
      expect(calls[0][1]).toMatchObject({ limit: 2 });
      expect(calls[1][1]).toMatchObject({ limit: 4 });

      expect(judgePosts).toHaveBeenCalledTimes(2);
      expect(judgedIdsOnCall(1)).toEqual(["arxiv:a1", "arxiv:a2"]);
      expect(judgedIdsOnCall(2)).toEqual(["arxiv:a3", "arxiv:a4"]);

      expect(r.rounds).toBe(2);
      expect(r.candidates).toBe(4);
      expect(r.judged).toBe(4);
      expect(r.inserted).toBe(2);
      expect(r.perSource.arxiv).toEqual({ status: "ok", candidates: 4, judged: 4, strong: 2, inserted: 2, skippedDuplicates: 0, deadVariants: 0 });
      const rows = await state.db!.select().from(ideas);
      expect(rows.map((row) => row.url).sort()).toEqual(["https://a/1", "https://a/3"]);
    });

    it("re-queries EVERY enabled, non-exhausted source in the next round — the shortfall is the run's, not one source's", async () => {
      const a = pooledAdapter("arxiv", pool("a", 4));
      const g = pooledAdapter("github", pool("g", 4));
      vi.mocked(judgePosts)
        .mockResolvedValueOnce([judgment("arxiv:a1", 90), judgment("arxiv:a2", 85), judgment("github:g1", 10), judgment("github:g2", 10)])
        .mockResolvedValueOnce([judgment("arxiv:a3", 70), judgment("arxiv:a4", 5), judgment("github:g3", 65), judgment("github:g4", 5)]);

      const r = await runScoutSearch(state.db as never, { query: "q", judgeTopic: "q" }, { adapters: [a, g], candidatesPerSource: 2, resultsTotal: 4 });

      // arxiv alone had 2 strong after round 1, but the RUN had 2 of 4 — so both sources go again, in the same round.
      expect(vi.mocked(a.search)).toHaveBeenCalledTimes(2);
      expect(vi.mocked(g.search)).toHaveBeenCalledTimes(2);
      expect(judgedIdsOnCall(2)).toEqual(["arxiv:a3", "arxiv:a4", "github:g3", "github:g4"]);
      expect(r.rounds).toBe(2);
      expect(r.inserted).toBe(4);
      expect(r.perSource.arxiv).toMatchObject({ candidates: 4, judged: 4, strong: 3, inserted: 3 });
      expect(r.perSource.github).toMatchObject({ candidates: 4, judged: 4, strong: 1, inserted: 1 });
    });

    it("stops after round 1 when it already has resultsTotal strong matches", async () => {
      const a = pooledAdapter("arxiv", pool("a", 4));
      vi.mocked(judgePosts).mockResolvedValueOnce([judgment("arxiv:a1", 90), judgment("arxiv:a2", 85)]);

      const r = await runScoutSearch(state.db as never, { query: "q", judgeTopic: "q" }, { adapters: [a], candidatesPerSource: 2, resultsTotal: 2 });
      expect(vi.mocked(a.search)).toHaveBeenCalledTimes(1);
      expect(r.rounds).toBe(1);
      expect(r.inserted).toBe(2);
    });

    it("stops once every enabled source is exhausted (a round adds nothing new) — no infinite loop, no empty Jev call, disabled sources never queried", async () => {
      const a = staticAdapter("arxiv", { posts: [adapterPost({ id: "a1", url: "https://a/1" })], status: "ok" });
      const gated = fakeAdapter({ name: "reddit", requiredEnv: ["SOME_TEST_ONLY_KEY_NOT_SET"] });
      vi.mocked(judgePosts).mockResolvedValueOnce([judgment("arxiv:a1", 30)]);

      const r = await runScoutSearch(state.db as never, { query: "q", judgeTopic: "q" }, { adapters: [a, gated] });

      // Round 2 re-queried arxiv (the run was short), got nothing new, and stopped.
      expect(vi.mocked(a.search)).toHaveBeenCalledTimes(2);
      expect(vi.mocked(gated.search)).not.toHaveBeenCalled();
      expect(judgePosts).toHaveBeenCalledTimes(1);
      expect(r.rounds).toBe(2);
      expect(r.inserted).toBe(0);
      expect(r.perSource.arxiv).toEqual({ status: "ok", candidates: 1, judged: 1, strong: 0, inserted: 0, skippedDuplicates: 0, deadVariants: 0 });
      expect(r.perSource.reddit).toEqual({ status: "disabled", candidates: 0, judged: 0, strong: 0, inserted: 0, skippedDuplicates: 0, deadVariants: 0 });
    });

    it("a source exhausted in round 2 is left alone afterwards while a deeper source is still queried", async () => {
      const dry = staticAdapter("arxiv", { posts: [adapterPost({ id: "a1", url: "https://a/1" })], status: "ok" });
      const deep = pooledAdapter("github", pool("g", 100));
      // g1 strong keeps github's one variant alive to MAX_ROUNDS (a variant dies only at 0 strong — see the variant-pruning block); everything else is weak.
      judgeEveryCandidate((id) => (id === "github:g1" ? 90 : 10));

      const r = await runScoutSearch(state.db as never, { query: "q", judgeTopic: "q" }, { adapters: [dry, deep], candidatesPerSource: 2, resultsTotal: 2 });

      expect(vi.mocked(dry.search)).toHaveBeenCalledTimes(2);
      expect(vi.mocked(deep.search)).toHaveBeenCalledTimes(MAX_ROUNDS);
      expect(r.rounds).toBe(MAX_ROUNDS);
    });

    it("stops at MAX_ROUNDS (4) while a source keeps yielding new candidates that never add up to resultsTotal", async () => {
      const a = pooledAdapter("arxiv", pool("a", 100));
      // One strong hit (a1) in the lot: short of resultsTotal every round, yet enough to keep the variant alive (a variant dies only at 0 strong — see the variant-pruning block).
      judgeEveryCandidate((id) => (id === "arxiv:a1" ? 90 : 10));

      const r = await runScoutSearch(state.db as never, { query: "q", judgeTopic: "q" }, { adapters: [a], candidatesPerSource: 2, resultsTotal: 2 });

      expect(MAX_ROUNDS).toBe(4);
      expect(vi.mocked(a.search).mock.calls.map((c) => c[1].limit)).toEqual([2, 4, 8, 16]);
      expect(judgePosts).toHaveBeenCalledTimes(4);
      // Geometric caps 2 → 4 → 8 → 16: round 4 adds candidates 9..16.
      expect(judgedIdsOnCall(4)).toEqual(Array.from({ length: 8 }, (_, i) => `arxiv:a${i + 9}`));
      expect(r.rounds).toBe(4);
      expect(r.candidates).toBe(16);
      expect(r.judged).toBe(16);
      expect(r.perSource.arxiv.strong).toBe(1);
      expect(r.inserted).toBe(1);
      expect(await state.db!.select().from(ideas)).toHaveLength(1);
    });

    it("a lone variant that never yields a strong candidate goes dead once 6+ of its candidates are judged: the run ends there (round 3), short of MAX_ROUNDS", async () => {
      const a = pooledAdapter("arxiv", pool("a", 100));
      judgeEveryCandidate(() => 10);

      const r = await runScoutSearch(state.db as never, { query: "q", judgeTopic: "q" }, { adapters: [a], candidatesPerSource: 2, resultsTotal: 2 });

      // Rounds 1–2 judge 2 + 2 weak candidates (alive: under VARIANT_DEAD_MIN_JUDGED); round 3's 4 more make 8 judged with 0 strong → dead → the source, whose only variant that is, is exhausted without another adapter call.
      expect(vi.mocked(a.search).mock.calls.map((c) => c[1].limit)).toEqual([2, 4, 8]);
      expect(judgePosts).toHaveBeenCalledTimes(3);
      expect(r.rounds).toBe(3);
      expect(r.judged).toBe(8);
      expect(r.perSource.arxiv).toMatchObject({ strong: 0, inserted: 0, deadVariants: 1 });
      expect(r.variantsTried).toBe(1);
    });

    it("does not start another round once the injected clock is past the time budget", async () => {
      const a = pooledAdapter("arxiv", pool("a", 4));
      vi.mocked(judgePosts).mockResolvedValueOnce([judgment("arxiv:a1", 90), judgment("arxiv:a2", 30)]);
      // startedAt = 0; every later reading is just past the budget.
      const now = vi.fn<() => number>().mockReturnValueOnce(0).mockReturnValue(TIME_BUDGET_MS + 1);

      const r = await runScoutSearch(state.db as never, { query: "q", judgeTopic: "q" }, { adapters: [a], candidatesPerSource: 2, resultsTotal: 2, now });

      expect(TIME_BUDGET_MS).toBe(50_000);
      expect(vi.mocked(a.search)).toHaveBeenCalledTimes(1);
      expect(judgePosts).toHaveBeenCalledTimes(1);
      expect(r.rounds).toBe(1);
      expect(r.inserted).toBe(1);
      expect(r.perSource.arxiv).toMatchObject({ candidates: 2, strong: 1, inserted: 1 });
    });

    it("does not start a round that would overrun: elapsed + twice the previous round's duration must fit the budget", async () => {
      const a = pooledAdapter("arxiv", pool("a", 8));
      vi.mocked(judgePosts).mockImplementation(async (_client, args) => args.posts.map((p) => judgment(p.id, 10)));
      // startedAt 0, round 1 starts at 0 and its check reads 20s: 20s + 2×20s = 60s > 50s → stop.
      const now = vi.fn<() => number>().mockReturnValueOnce(0).mockReturnValueOnce(0).mockReturnValue(20_000);

      const r = await runScoutSearch(state.db as never, { query: "q", judgeTopic: "q" }, { adapters: [a], candidatesPerSource: 2, resultsTotal: 2, now });
      expect(r.rounds).toBe(1);
      expect(vi.mocked(a.search)).toHaveBeenCalledTimes(1);
    });

    it("keeps going when the previous round was quick enough to fit twice over", async () => {
      const a = pooledAdapter("arxiv", pool("a", 8));
      vi.mocked(judgePosts).mockImplementation(async (_client, args) => args.posts.map((p) => judgment(p.id, 10)));
      // Round 1 took 12s (12s + 24s = 36s ≤ 50s → continue); later readings are all 12s → zero-length rounds.
      const now = vi.fn<() => number>().mockReturnValueOnce(0).mockReturnValueOnce(0).mockReturnValue(12_000);

      const r = await runScoutSearch(state.db as never, { query: "q", judgeTopic: "q" }, { adapters: [a], candidatesPerSource: 2, resultsTotal: 2, now });
      expect(r.rounds).toBeGreaterThan(1);
    });

    it("a Jev failure in round 2 keeps round 1's strong results, inserts them, and reports a note instead of throwing", async () => {
      const a = pooledAdapter("arxiv", pool("a", 8));
      vi.mocked(judgePosts)
        .mockResolvedValueOnce([judgment("arxiv:a1", 90), judgment("arxiv:a2", 20)])
        .mockRejectedValueOnce(new Error("Request timed out after 10000ms."));

      const r = await runScoutSearch(state.db as never, { query: "q", judgeTopic: "q" }, { adapters: [a], candidatesPerSource: 2, resultsTotal: 3 });

      expect(r.rounds).toBe(2);
      expect(r.inserted).toBe(1);
      expect(r.note).toMatch(/^judging failed in round 2: Request timed out/);
      expect(await state.db!.select().from(ideas)).toHaveLength(1);
    });

    it("a Jev failure in round 1 yields an empty, noted summary rather than a thrown error", async () => {
      const a = pooledAdapter("arxiv", pool("a", 4));
      vi.mocked(judgePosts).mockRejectedValueOnce(new Error("fetch failed"));

      const r = await runScoutSearch(state.db as never, { query: "q", judgeTopic: "q" }, { adapters: [a], candidatesPerSource: 2, resultsTotal: 2 });

      expect(r.rounds).toBe(1);
      expect(r.inserted).toBe(0);
      expect(r.candidates).toBe(2);
      expect(r.note).toBe("judging failed in round 1: fetch failed");
    });

    it("still runs the next round when the clock is exactly at the budget (the cutoff is strictly past it)", async () => {
      const a = pooledAdapter("arxiv", pool("a", 4));
      vi.mocked(judgePosts)
        .mockResolvedValueOnce([judgment("arxiv:a1", 90), judgment("arxiv:a2", 30)])
        .mockResolvedValueOnce([judgment("arxiv:a3", 80), judgment("arxiv:a4", 20)]);
      const now = vi.fn<() => number>().mockReturnValueOnce(0).mockReturnValue(TIME_BUDGET_MS);

      const r = await runScoutSearch(state.db as never, { query: "q", judgeTopic: "q" }, { adapters: [a], candidatesPerSource: 2, resultsTotal: 2, now });
      expect(r.rounds).toBe(2);
    });

    it("reports rounds, minScore and resultsTotal (kv defaults or deps overrides) plus per-source strong counts", async () => {
      const a = staticAdapter("arxiv", {
        posts: [adapterPost({ id: "a1", url: "https://a/1" }), adapterPost({ id: "a2", url: "https://a/2" }), adapterPost({ id: "a3", url: "https://a/3" })],
        status: "ok",
      });
      // 65 clears the default 60 and a custom 63, but not a custom 70; 61 clears only the default.
      vi.mocked(judgePosts).mockResolvedValue([judgment("arxiv:a1", 65), judgment("arxiv:a2", 61), judgment("arxiv:a3", 95, true)]);

      const defaults = await runScoutSearch(state.db as never, { query: "q", judgeTopic: "q" }, { adapters: [a] });
      expect(defaults).toMatchObject({ rounds: 2, minScore: 60, resultsTotal: 20 });
      expect(defaults.perSource.arxiv).toMatchObject({ candidates: 3, judged: 3, strong: 2, inserted: 2 });

      const overridden = await runScoutSearch(state.db as never, { query: "q2", judgeTopic: "q2" }, { adapters: [a], minScore: 63, resultsTotal: 1 });
      expect(overridden).toMatchObject({ rounds: 1, minScore: 63, resultsTotal: 1 });
      // a1 (65) is strong; a2 (61) isn't; a3 is spam. The one strong hit is the url saved by the first run → a skipped duplicate.
      expect(overridden.perSource.arxiv).toMatchObject({ strong: 1, inserted: 0, skippedDuplicates: 1 });

      await setSetting(state.db as never, "scoutMinScore", 70);
      const fromKv = await runScoutSearch(state.db as never, { query: "q3", judgeTopic: "q3" }, { adapters: [a] });
      expect(fromKv.minScore).toBe(70);
      expect(fromKv.perSource.arxiv.strong).toBe(0);
    });

    it("loads taste examples once per run (not per round) and passes the same taste to every round's judging call", async () => {
      await state.db!.insert(ideas).values([
        { kind: "note", content: "kept one", status: "used", createdAt: new Date(Date.now() - 2000) },
        { kind: "note", content: "kept two", status: "used", createdAt: new Date(Date.now() - 1000) },
        { kind: "note", content: "skipped one", status: "dismissed" },
      ]);
      const a = pooledAdapter("arxiv", pool("a", 4));
      vi.mocked(judgePosts)
        .mockResolvedValueOnce([judgment("arxiv:a1", 90), judgment("arxiv:a2", 30)])
        .mockResolvedValueOnce([judgment("arxiv:a3", 80), judgment("arxiv:a4", 20)]);

      const r = await runScoutSearch(state.db as never, { query: "q", judgeTopic: "q" }, { adapters: [a], candidatesPerSource: 2, resultsTotal: 2 });
      expect(r.rounds).toBe(2);
      expect(loadTasteExamples).toHaveBeenCalledTimes(1);
      const taste = { kept: ["kept two", "kept one"], skipped: ["skipped one"] };
      expect(vi.mocked(judgePosts).mock.calls[0][1].taste).toEqual(taste);
      expect(vi.mocked(judgePosts).mock.calls[1][1].taste).toEqual(taste);
    });
  });

  describe("variant pruning — dead variants, drained variants, and single-term descent (live finding, 2026-09-22)", () => {
    beforeEach(() => { process.env.TYPESAFE_API_KEY = "k"; });

    it("a variant that yielded 0 strong from ≥ 6 judged candidates in round 1 is dead — never queried again — while the productive variant is re-queried", async () => {
      // Both variants multi-term, so the single-term rule stays out of this test.
      vi.mocked(queryVariants).mockReturnValue(["alpha beta gamma", "alpha beta"]);
      const x = variantPooledAdapter("arxiv", { "alpha beta gamma": pool("a", 3), "alpha beta": pool("b", 20) });
      judgeEveryCandidate((id) => (id.startsWith("arxiv:a") ? 90 : 10));

      const r = await runScoutSearch(state.db as never, { query: "q", judgeTopic: "q" }, { adapters: [x], candidatesPerSource: 9, resultsTotal: 5 });

      // Round 1 (cap 9): the full query gives a1..a3 (all strong), then "alpha beta" fills the cap with b1..b6 — 6 judged, 0 strong → dead.
      // Round 2 (cap 18): only the full query is asked again; it re-returns a1..a3, adds nothing, and the source is exhausted.
      expect(searchCalls(x)).toEqual([["alpha beta gamma", 9], ["alpha beta", 9], ["alpha beta gamma", 18]]);
      expect(judgePosts).toHaveBeenCalledTimes(1);
      expect(r.rounds).toBe(2);
      expect(r.perSource.arxiv).toMatchObject({ candidates: 9, judged: 9, strong: 3, inserted: 3, deadVariants: 1 });
      expect(r.variantsTried).toBe(2);
    });

    it("five weak judgments are one short of dead (VARIANT_DEAD_MIN_JUDGED = 6): the variant is still re-queried in round 2", async () => {
      expect(VARIANT_DEAD_MIN_JUDGED).toBe(6);
      vi.mocked(queryVariants).mockReturnValue(["alpha beta gamma", "alpha beta"]);
      const x = variantPooledAdapter("arxiv", { "alpha beta gamma": pool("a", 3), "alpha beta": pool("b", 20) });
      judgeEveryCandidate((id) => (id.startsWith("arxiv:a") ? 90 : 10));

      const r = await runScoutSearch(state.db as never, { query: "q", judgeTopic: "q" }, { adapters: [x], candidatesPerSource: 8, resultsTotal: 5 });

      // Round 1 (cap 8): a1..a3 + b1..b5. Round 2 (cap 16): "alpha beta" (5 judged, 0 strong — alive) adds b6..b13, which do kill it; with the full query drained too, the source is exhausted.
      expect(searchCalls(x)).toEqual([["alpha beta gamma", 8], ["alpha beta", 8], ["alpha beta gamma", 16], ["alpha beta", 16]]);
      expect(judgedIdsOnCall(2)).toEqual(Array.from({ length: 8 }, (_, i) => `arxiv:b${i + 6}`));
      expect(r.rounds).toBe(2);
      expect(r.perSource.arxiv).toMatchObject({ judged: 16, strong: 3, deadVariants: 1 });
    });

    it("single-term variants are skipped in round 2 while a multi-term variant still yields new candidates, and used once every multi-term variant is drained", async () => {
      vi.mocked(queryVariants).mockReturnValue(["alpha beta", "alpha"]);
      const x = variantPooledAdapter("arxiv", { "alpha beta": pool("a", 6), alpha: pool("b", 50) });
      // a1 strong keeps "alpha beta" alive (a variant dies only at 0 strong); everything else is weak.
      judgeEveryCandidate((id) => (id === "arxiv:a1" ? 90 : 10));

      const r = await runScoutSearch(state.db as never, { query: "q", judgeTopic: "q" }, { adapters: [x], candidatesPerSource: 4, resultsTotal: 5 });

      // Round 1 (cap 4): "alpha beta" → a1..a4, cap met. Round 2 (cap 8): it adds a5, a6 — still yielding, so "alpha" is skipped even with the cap unmet (the old walk descended into it right here).
      // Round 3 (cap 16): "alpha beta" re-returns a1..a6 → drained → "alpha" is finally used (b1..b10, all weak → dead) → nothing left → exhausted.
      expect(searchCalls(x)).toEqual([["alpha beta", 4], ["alpha beta", 8], ["alpha beta", 16], ["alpha", 16]]);
      expect(judgedIdsOnCall(2)).toEqual(["arxiv:a5", "arxiv:a6"]);
      expect(judgedIdsOnCall(3)).toEqual(Array.from({ length: 10 }, (_, i) => `arxiv:b${i + 1}`));
      expect(r.rounds).toBe(3);
      expect(r.perSource.arxiv).toMatchObject({ candidates: 16, judged: 16, strong: 1, deadVariants: 1 });
      expect(r.variantsTried).toBe(2);
    });

    it("single-term variants are used when every multi-term variant is dead", async () => {
      vi.mocked(queryVariants).mockReturnValue(["alpha beta gamma", "alpha beta", "alpha"]);
      const x = variantPooledAdapter("arxiv", { "alpha beta gamma": pool("a", 6), "alpha beta": pool("b", 6), alpha: pool("c", 30) });
      judgeEveryCandidate((id) => (id === "arxiv:c1" ? 90 : 10));

      const r = await runScoutSearch(state.db as never, { query: "q", judgeTopic: "q" }, { adapters: [x], candidatesPerSource: 12, resultsTotal: 1 });

      // Round 1 (cap 12): a1..a6 + b1..b6 fill the cap — "alpha" is never reached; both multi-term variants end up 6 judged, 0 strong → dead.
      // Round 2 (cap 24): neither is asked again; "alpha" is, and c1 meets the quota.
      expect(searchCalls(x)).toEqual([["alpha beta gamma", 12], ["alpha beta", 12], ["alpha", 24]]);
      expect(judgedIdsOnCall(2)).toEqual(Array.from({ length: 12 }, (_, i) => `arxiv:c${i + 1}`));
      expect(r.rounds).toBe(2);
      expect(r.inserted).toBe(1);
      expect(r.perSource.arxiv.deadVariants).toBe(2);
      expect(r.variantsTried).toBe(3);
    });

    it("round 1 still falls back to a single-term variant when the multi-term ones return nothing (nothing judged yet, so nothing to prune on)", async () => {
      vi.mocked(queryVariants).mockReturnValue(["alpha beta", "alpha"]);
      const x = variantPooledAdapter("arxiv", { "alpha beta": [], alpha: pool("c", 3) });
      judgeEveryCandidate(() => 90);

      const r = await runScoutSearch(state.db as never, { query: "q", judgeTopic: "q" }, { adapters: [x], candidatesPerSource: 12, resultsTotal: 1 });

      expect(searchCalls(x)).toEqual([["alpha beta", 12], ["alpha", 12]]);
      expect(r.rounds).toBe(1);
      expect(r.candidates).toBe(3);
      expect(r.inserted).toBe(1);
      expect(r.perSource.arxiv.deadVariants).toBe(0);
      expect(r.variantsTried).toBe(2);
    });

    it("a source whose every variant is dead is exhausted right after judging: no further adapter call for it, while a live source keeps going", async () => {
      vi.mocked(queryVariants).mockReturnValue(["alpha beta"]);
      const dead = variantPooledAdapter("arxiv", { "alpha beta": pool("a", 8) });
      const live = variantPooledAdapter("github", { "alpha beta": pool("b", 100) });
      judgeEveryCandidate((id) => (id === "github:b1" ? 90 : 10));

      const r = await runScoutSearch(state.db as never, { query: "q", judgeTopic: "q" }, { adapters: [dead, live], candidatesPerSource: 8, resultsTotal: 5 });

      expect(searchCalls(dead)).toEqual([["alpha beta", 8]]);
      expect(searchCalls(live).map(([, limit]) => limit)).toEqual([8, 16, 32, 64]);
      expect(r.rounds).toBe(MAX_ROUNDS);
      expect(r.perSource.arxiv).toMatchObject({ candidates: 8, judged: 8, strong: 0, deadVariants: 1 });
      expect(r.perSource.github).toMatchObject({ strong: 1, deadVariants: 0 });
      expect(r.variantsTried).toBe(2);
    });

    it("when every source's every variant is dead, the loop ends without an empty round or an empty Jev call", async () => {
      vi.mocked(queryVariants).mockReturnValue(["alpha beta"]);
      const x = variantPooledAdapter("arxiv", { "alpha beta": pool("a", 8) });
      judgeEveryCandidate(() => 10);

      const r = await runScoutSearch(state.db as never, { query: "q", judgeTopic: "q" }, { adapters: [x], candidatesPerSource: 8, resultsTotal: 5 });

      expect(searchCalls(x)).toEqual([["alpha beta", 8]]);
      expect(judgePosts).toHaveBeenCalledTimes(1);
      expect(r.rounds).toBe(1);
      expect(r.note).toBeUndefined();
      expect(r.perSource.arxiv).toEqual({ status: "ok", candidates: 8, judged: 8, strong: 0, inserted: 0, skippedDuplicates: 0, deadVariants: 1 });
      expect(r.variantsTried).toBe(1);
    });

    // The measured problem (live, 2026-09-22): only the full query is
    // productive; the narrower variants are off-topic. Full query: 20 posts,
    // every odd one strong (10 in all). "alpha beta": `narrowPoolSize` weak
    // posts. "alpha": 100 weak posts. The quota of 20 is never met, so only
    // pruning can end the run before MAX_ROUNDS.
    function onlyTheFullQueryIsProductive(narrowPoolSize: number): SourceAdapter {
      vi.mocked(queryVariants).mockReturnValue(["alpha beta gamma", "alpha beta", "alpha"]);
      const x = variantPooledAdapter("arxiv", { "alpha beta gamma": pool("a", 20), "alpha beta": pool("b", narrowPoolSize), alpha: pool("c", 100) });
      judgeEveryCandidate((id) => {
        const m = id.match(/^arxiv:a(\d+)$/);
        return m && Number(m[1]) % 2 === 1 ? 90 : 10;
      });
      return x;
    }

    it("over a 4-round run where only the full query is productive, dead and drained variants are pruned: 6 adapter calls where the old walk made 9", async () => {
      const x = onlyTheFullQueryIsProductive(10);

      const r = await runScoutSearch(state.db as never, { query: "q", judgeTopic: "q" }, { adapters: [x], candidatesPerSource: 12, resultsTotal: 20 });

      expect(searchCalls(x)).toEqual([
        ["alpha beta gamma", 12], // round 1: a1..a12
        ["alpha beta gamma", 24], ["alpha beta", 24], // round 2: a13..a20, then b1..b4
        ["alpha beta gamma", 48], ["alpha beta", 48], // round 3: the full query re-returns a1..a20 → drained; "alpha beta" adds b5..b10 (still yielding, so "alpha" stays gated)
        ["alpha", 96], // round 4: "alpha beta" is dead (10 judged, 0 strong) and the full query drained → "alpha" is finally used
      ]);
      expect(r.rounds).toBe(4);
      expect(r.perSource.arxiv).toMatchObject({ candidates: 96, judged: 96, strong: 10, inserted: 10, deadVariants: 2 });
      expect(r.variantsTried).toBe(3);
    });

    it("…and when the narrower variants run dry sooner, the run ends a round early: 6 adapter calls, 3 Jev calls, 48 judged — where the old walk made 9, 4 and 96", async () => {
      const x = onlyTheFullQueryIsProductive(4);

      const r = await runScoutSearch(state.db as never, { query: "q", judgeTopic: "q" }, { adapters: [x], candidatesPerSource: 12, resultsTotal: 20 });

      expect(searchCalls(x)).toEqual([
        ["alpha beta gamma", 12],
        ["alpha beta gamma", 24], ["alpha beta", 24], // round 2: a13..a20, then b1..b4 (its whole pool)
        ["alpha beta gamma", 48], ["alpha beta", 48], ["alpha", 48], // round 3: both multi-term variants drained → "alpha" adds c1..c24, all weak → dead → nothing left to query
      ]);
      expect(judgePosts).toHaveBeenCalledTimes(3);
      expect(r.rounds).toBe(3);
      expect(r.perSource.arxiv).toMatchObject({ candidates: 48, judged: 48, strong: 10, inserted: 10, deadVariants: 1 });
      expect(r.variantsTried).toBe(3);
    });
  });

  describe("taste examples", () => {
    beforeEach(() => { process.env.TYPESAFE_API_KEY = "k"; });

    it("omits taste when fewer than 3 kept+skipped examples exist", async () => {
      await state.db!.insert(ideas).values([
        { kind: "note", content: "kept one", status: "used" },
        { kind: "note", content: "skipped one", status: "dismissed" },
      ]);
      const a = staticAdapter("arxiv", { posts: [adapterPost({ id: "a" })], status: "ok" });
      vi.mocked(judgePosts).mockResolvedValueOnce([judgment("arxiv:a", 90)]);

      await runScoutSearch(state.db as never, { query: "q", judgeTopic: "q" }, { adapters: [a] });
      const call = vi.mocked(judgePosts).mock.calls[0][1];
      expect("taste" in call).toBe(false);
    });

    it("passes taste examples once kept+skipped reaches 3", async () => {
      await state.db!.insert(ideas).values([
        { kind: "note", content: "kept one", status: "used", createdAt: new Date(Date.now() - 2000) },
        { kind: "note", content: "kept two", status: "used", createdAt: new Date(Date.now() - 1000) },
        { kind: "note", content: "skipped one", status: "dismissed" },
      ]);
      const a = staticAdapter("arxiv", { posts: [adapterPost({ id: "a" })], status: "ok" });
      vi.mocked(judgePosts).mockResolvedValueOnce([judgment("arxiv:a", 90)]);

      await runScoutSearch(state.db as never, { query: "q", judgeTopic: "q" }, { adapters: [a] });
      const call = vi.mocked(judgePosts).mock.calls[0][1];
      expect(call.taste).toEqual({ kept: ["kept two", "kept one"], skipped: ["skipped one"] });
    });
  });
});

describe("a source billed per post read (X, 2026-09-24)", () => {
  const env = { NODE_ENV: "test" } as NodeJS.ProcessEnv;

  function paidAdapter(pools: Record<string, AdapterPost[]>, extra: Partial<SourceAdapter> = {}): SourceAdapter {
    const search = vi.fn(async (variant: string, opts: { limit?: number }): Promise<AdapterResult> => ({
      posts: (pools[variant] ?? []).slice(0, opts.limit),
      status: "ok",
    }));
    return { ...fakeAdapter({ name: "x_post", search }), postsPerSearch: () => 20, minPerRequest: 10, ...extra };
  }

  it("is read in round 1 only, never past its budget, and keeps every post it paid for", async () => {
    vi.mocked(queryVariants).mockReturnValue(["a b c", "a b", "a"]);
    const paid = paidAdapter({ "a b c": pool("p", 6), "a b": pool("q", 12), a: pool("r", 30) });
    const free = pooledAdapter("hackernews", pool("f", 300));
    judgeEveryCandidate(() => 50); // nothing strong, so the run goes on to more rounds

    const r = await runScoutSearch(state.db as never, { query: "a b c", judgeTopic: "t" }, {
      adapters: [paid, free], jev: fakeClient, candidatesPerSource: 5, resultsTotal: 20, env,
    });
    // 20 to read: 6 from the full query, then what's left (14) from the next
    // variant, which had 12; 2 left is under X's minimum page of 10, so it stops.
    expect(searchCalls(paid)).toEqual([["a b c", 20], ["a b", 14]]);
    expect(r.rounds).toBeGreaterThan(1);
    expect(r.perSource.x_post).toMatchObject({ candidates: 18, billed: { posts: 18, users: 0 } });
    expect(r.perSource.hackernews.billed).toBeUndefined();
  });

  it("an error ends its walk, and its note reaches the summary", async () => {
    vi.mocked(queryVariants).mockReturnValue(["a b", "a"]);
    const search = vi.fn(async (): Promise<AdapterResult> => ({ posts: [], status: "error", note: "X rejected the key (401): check the bearer token in Settings" }));
    const paid = { ...fakeAdapter({ name: "x_post", search }), postsPerSearch: () => 20, minPerRequest: 10 };
    const free = staticAdapter("hackernews", { posts: [adapterPost({ id: "h1" })], status: "ok" });
    judgeEveryCandidate(() => 90);

    const r = await runScoutSearch(state.db as never, { query: "a b", judgeTopic: "t" }, { adapters: [paid, free], jev: fakeClient, resultsTotal: 1, env });
    expect(search).toHaveBeenCalledTimes(1);
    expect(r.perSource.x_post).toMatchObject({ status: "error", note: "X rejected the key (401): check the bearer token in Settings" });
  });

  it("finishes only the picked posts, in one call, before they're saved", async () => {
    vi.mocked(queryVariants).mockReturnValue(["q"]);
    const posts = [1, 2, 3].map((n) => ({ ...adapterPost({ id: `p${n}`, url: `https://x.com/i/status/${n}`, author: null }), authorId: `u${n % 2}` }));
    const finalizePicked = vi.fn(async (picked: SourcePost[]) =>
      picked.map((p) => ({ ...p, author: `@user${p.authorId}`, url: p.url.replace("/i/", `/user${p.authorId}/`) })));
    const paid = paidAdapter({ q: posts }, { finalizePicked });
    judgeEveryCandidate((id) => (id === "x_post:p1" ? 90 : id === "x_post:p2" ? 80 : 10));

    const r = await runScoutSearch(state.db as never, { query: "q", judgeTopic: "t" }, { adapters: [paid], jev: fakeClient, resultsTotal: 5, env });
    expect(finalizePicked).toHaveBeenCalledTimes(1);
    expect(finalizePicked.mock.calls[0][0].map((p) => p.id)).toEqual(["x_post:p1", "x_post:p2"]);
    const rows = await state.db!.select().from(ideas);
    expect(rows.map((row) => [row.kind, row.url, row.author]).sort()).toEqual([
      ["x_post", "https://x.com/useru0/status/2", "@useru0"],
      ["x_post", "https://x.com/useru1/status/1", "@useru1"],
    ]);
    expect(r.perSource.x_post.billed).toEqual({ posts: 3, users: 2 });
  });

  it("a failed finish still saves the picked posts as they were", async () => {
    vi.mocked(queryVariants).mockReturnValue(["q"]);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const paid = paidAdapter({ q: [adapterPost({ id: "p1", url: "https://x.com/i/status/1" })] }, { finalizePicked: vi.fn().mockRejectedValue(new Error("boom")) });
    judgeEveryCandidate(() => 90);
    await runScoutSearch(state.db as never, { query: "q", judgeTopic: "t" }, { adapters: [paid], jev: fakeClient, resultsTotal: 5, env });
    expect((await state.db!.select().from(ideas)).map((row) => row.url)).toEqual(["https://x.com/i/status/1"]);
    warn.mockRestore();
  });
});


describe("disconnected sources (2026-09-25)", () => {
  it("a search reads every source but the ones the owner disconnected", async () => {
    const { connectedAdapters } = await import("@/lib/scout-run");
    const { ALL_ADAPTERS } = await import("@/lib/sources/all");
    expect((await connectedAdapters(state.db as never)).map((a) => a.name)).toEqual(ALL_ADAPTERS.map((a) => a.name));
    await setSetting(state.db as never, "disabledSources", ["hackernews", "lemmy"]);
    const names = (await connectedAdapters(state.db as never)).map((a) => a.name);
    expect(names).not.toContain("hackernews");
    expect(names).not.toContain("lemmy");
    expect(names).toContain("arxiv");
  });
});

describe("what the owner wants first (2026-09-26)", () => {
  it("asks Jev for the kinds in the owner's order, with the relevance gate", async () => {
    process.env.TYPESAFE_API_KEY = "k";
    await setSetting(state.db as never, "findOrder", ["opinion", "story", "problem", "news", "tool"]);
    const a = staticAdapter("devto", { posts: [adapterPost({ id: "a" })], status: "ok" });
    vi.mocked(judgePosts).mockResolvedValueOnce([judgment("devto:a", 90)]);
    await runScoutSearch(state.db as never, { query: "q", judgeTopic: "q" }, { adapters: [a] });
    const call = vi.mocked(judgePosts).mock.calls[0][1];
    expect(call.kinds?.map((k) => [k.label, k.weight])).toEqual([
      ["opinion", 1], ["story", 0.9], ["problem", 0.8], ["news", 0.5], ["tool", 0.3], ["other", 0.15],
    ]);
    expect(call.options).toEqual({ relevanceGate: { floor: 10, full: 35 } });
  });

  it("keeps each saved idea's kind next to its rank", async () => {
    process.env.TYPESAFE_API_KEY = "k";
    const a = staticAdapter("devto", { posts: [adapterPost({ id: "a" })], status: "ok" });
    vi.mocked(judgePosts).mockResolvedValueOnce([{ ...judgment("devto:a", 90), kind: "story", kindFit: 0.9 }]);
    await runScoutSearch(state.db as never, { query: "q", judgeTopic: "q" }, { adapters: [a] });
    const [row] = await state.db!.select().from(ideas);
    expect(row.meta).toMatchObject({ rank: 90, postKind: "story", kindFit: 0.9 });
  });
});
