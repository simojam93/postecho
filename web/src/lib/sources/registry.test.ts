import { describe, expect, it, vi } from "vitest";
import type { AdapterResult, SourceAdapter } from "@/lib/sources/adapter";
import { arxiv } from "@/lib/sources/arxiv";
import { devto } from "@/lib/sources/devto";
import { github } from "@/lib/sources/github";
import { lemmy } from "@/lib/sources/lemmy";
import { lobsters } from "@/lib/sources/lobsters";
import { mastodon } from "@/lib/sources/mastodon";
import { producthunt } from "@/lib/sources/producthunt";
import { EXTRA_ADAPTERS, runAdapters } from "@/lib/sources/registry";
import type { Fetcher } from "@/lib/sources/types";
import { youtube } from "@/lib/sources/youtube";

function okAdapter(name: string, result: AdapterResult): SourceAdapter {
  return { name, label: name, tag: name.slice(0, 2).toUpperCase(), search: vi.fn().mockResolvedValue(result) };
}

const noopFetcher: Fetcher = vi.fn();

// Next.js's global.d.ts augments NodeJS.ProcessEnv with a required NODE_ENV
// field, so a plain `{}`/`{ KEY: "value" }` literal doesn't structurally
// satisfy it — this builds a valid one for tests.
function testEnv(overrides: Partial<NodeJS.ProcessEnv> = {}): NodeJS.ProcessEnv {
  return { NODE_ENV: "test", ...overrides };
}

describe("EXTRA_ADAPTERS", () => {
  it("lists exactly the eight extra adapters, keyless first, in the documented order (Reddit taken out, 2026-09-25)", () => {
    expect(EXTRA_ADAPTERS).toEqual([arxiv, github, devto, mastodon, lobsters, lemmy, youtube, producthunt]);
    expect(EXTRA_ADAPTERS.map((a) => a.name)).toEqual([
      "arxiv",
      "github",
      "devto",
      "mastodon",
      "lobsters",
      "lemmy",
      "youtube",
      "producthunt",
    ]);
  });

  it("gives every adapter a unique name and tag", () => {
    expect(new Set(EXTRA_ADAPTERS.map((a) => a.name)).size).toBe(EXTRA_ADAPTERS.length);
    expect(new Set(EXTRA_ADAPTERS.map((a) => a.tag)).size).toBe(EXTRA_ADAPTERS.length);
  });
});

describe("runAdapters", () => {
  it("calls each adapter's search with the query and passed-through fetcher/limit/env, keyed by adapter.name", async () => {
    const a = okAdapter("a", { posts: [], status: "ok" });
    const b = okAdapter("b", { posts: [], status: "ok" });
    const fetcher: Fetcher = vi.fn();
    const env = testEnv({ SOME_VAR: "1" });
    await runAdapters([a, b], "ai audio", { fetcher, limit: 7, env });
    expect(a.search).toHaveBeenCalledWith("ai audio", { fetcher, limit: 7, env });
    expect(b.search).toHaveBeenCalledWith("ai audio", { fetcher, limit: 7, env });
  });

  it("keys results by each adapter's name", async () => {
    const a = okAdapter("alpha", { posts: [{ id: "1", url: "https://x/1", text: "t", author: null, metrics: {}, createdAt: null }], status: "ok" });
    const b = okAdapter("beta", { posts: [], status: "ok" });
    const r = await runAdapters([a, b], "q", { fetcher: noopFetcher, env: testEnv() });
    expect(Object.keys(r.results).sort()).toEqual(["alpha", "beta"]);
    expect(r.results.alpha.posts).toHaveLength(1);
    expect(r.results.beta.status).toBe("ok");
  });

  it("isolates a throwing adapter via allSettled: other adapters still return normally", async () => {
    const throwing: SourceAdapter = { name: "boom", label: "Boom", tag: "BM", search: vi.fn().mockRejectedValue(new Error("kaboom")) };
    const fine = okAdapter("fine", { posts: [], status: "ok" });
    const r = await runAdapters([throwing, fine], "q", { fetcher: noopFetcher, env: testEnv() });
    expect(r.results.boom.status).toBe("error");
    expect(r.results.boom.posts).toEqual([]);
    expect(r.results.fine.status).toBe("ok");
  });

  it("detects a disabled adapter via envReady and never calls its search (no fetch attempted)", async () => {
    const search = vi.fn().mockResolvedValue({ posts: [], status: "ok" });
    const gated: SourceAdapter = { name: "gated", label: "Gated", tag: "GT", requiredEnv: ["SOME_REQUIRED_KEY"], search };
    const r = await runAdapters([gated], "q", { fetcher: noopFetcher, env: testEnv() });
    expect(r.results.gated).toEqual({ posts: [], status: "disabled", note: "set SOME_REQUIRED_KEY" });
    expect(search).not.toHaveBeenCalled();
  });

  it("calls search when a gated adapter's required env is satisfied", async () => {
    const search = vi.fn().mockResolvedValue({ posts: [], status: "ok" });
    const gated: SourceAdapter = { name: "gated", label: "Gated", tag: "GT", requiredEnv: ["SOME_REQUIRED_KEY"], search };
    await runAdapters([gated], "q", { fetcher: noopFetcher, env: testEnv({ SOME_REQUIRED_KEY: "present" }) });
    expect(search).toHaveBeenCalledTimes(1);
  });

  it("falls back to process.env when opts.env is omitted", async () => {
    vi.stubEnv("SOME_REQUIRED_KEY", "from-process-env");
    const search = vi.fn().mockResolvedValue({ posts: [], status: "ok" });
    const gated: SourceAdapter = { name: "gated", label: "Gated", tag: "GT", requiredEnv: ["SOME_REQUIRED_KEY"], search };
    const r = await runAdapters([gated], "q", { fetcher: noopFetcher });
    expect(r.results.gated.status).toBe("ok");
    expect(search).toHaveBeenCalledTimes(1);
    vi.unstubAllEnvs();
  });

  it("returns an empty results object for an empty adapter list", async () => {
    const r = await runAdapters([], "q", { fetcher: noopFetcher, env: testEnv() });
    expect(r.results).toEqual({});
  });

  it("runs against the real EXTRA_ADAPTERS list: keyless adapters attempt a call, keyed ones report disabled without env", async () => {
    const fetcher: Fetcher = vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => "[]" });
    const r = await runAdapters(EXTRA_ADAPTERS, "audio", { fetcher, limit: 1, env: testEnv() });
    expect(Object.keys(r.results).sort()).toEqual(
      ["arxiv", "devto", "github", "lemmy", "lobsters", "mastodon", "producthunt", "youtube"],
    );
    expect(r.results.lobsters.status).toBe("ok");
    expect(r.results.lemmy.status).toBe("ok");
    expect(r.results.youtube.status).toBe("disabled");
    expect(r.results.producthunt.status).toBe("disabled");
  });
});
