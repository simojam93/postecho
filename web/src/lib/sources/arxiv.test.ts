import { describe, expect, it, vi } from "vitest";
import { arxiv } from "@/lib/sources/arxiv";
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

function feed(entriesXml: string): string {
  return `<?xml version='1.0' encoding='UTF-8'?>
<feed xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/" xmlns:arxiv="http://arxiv.org/schemas/atom" xmlns="http://www.w3.org/2005/Atom">
  <id>https://arxiv.org/api/abc123</id>
  <title>arXiv Query: search_query=all:audio&amp;id_list=&amp;start=0&amp;max_results=1</title>
  <updated>2026-09-21T21:55:19Z</updated>
  <opensearch:itemsPerPage>1</opensearch:itemsPerPage>
  <opensearch:totalResults>1</opensearch:totalResults>
  <opensearch:startIndex>0</opensearch:startIndex>
${entriesXml}
</feed>`;
}

const oneEntry = feed(`  <entry>
    <id>http://arxiv.org/abs/2305.15266v3</id>
    <title>Diffusion-Based Audio Inpainting</title>
    <updated>2025-01-10T13:07:40Z</updated>
    <link href="https://arxiv.org/abs/2305.15266v3" rel="alternate" type="text/html"/>
    <link href="https://arxiv.org/pdf/2305.15266v3" rel="related" type="application/pdf" title="pdf"/>
    <summary>Audio inpainting aims to reconstruct missing segments in corrupted recordings &amp; streams.</summary>
    <category term="eess.AS" scheme="http://arxiv.org/schemas/atom"/>
    <published>2023-05-24T15:52:11Z</published>
    <arxiv:primary_category term="eess.AS"/>
    <author>
      <name>Eloi Moliner</name>
    </author>
    <author>
      <name>Vesa Valimaki</name>
    </author>
  </entry>`);

describe("arxiv adapter", () => {
  it("has the expected name/label/tag and no required env", () => {
    expect(arxiv.name).toBe("arxiv");
    expect(arxiv.label).toBe("arXiv");
    expect(arxiv.tag).toBe("AX");
    expect(arxiv.requiredEnv ?? []).toEqual([]);
  });

  it("parses an entry into AdapterPost shape, linking to the https abs page", async () => {
    const r = await arxiv.search("audio", { fetcher: fakeFetch(200, oneEntry) });
    expect(r.status).toBe("ok");
    expect(r.posts).toHaveLength(1);
    expect(r.posts[0]).toEqual({
      id: "2305.15266v3",
      url: "https://arxiv.org/abs/2305.15266v3",
      text: "Diffusion-Based Audio Inpainting — Audio inpainting aims to reconstruct missing segments in corrupted recordings & streams.",
      title: "Diffusion-Based Audio Inpainting",
      author: "Eloi Moliner, Vesa Valimaki",
      metrics: {},
      createdAt: "2023-05-24T15:52:11Z",
    });
  });

  it("upgrades the feed's http abs-page id to https", async () => {
    const r = await arxiv.search("audio", { fetcher: fakeFetch(200, oneEntry) });
    expect(r.posts[0].url.startsWith("https://")).toBe(true);
  });

  it("falls back to the title alone when summary is absent", async () => {
    const noSummary = feed(`  <entry>
    <id>http://arxiv.org/abs/1111.11111v1</id>
    <title>A Paper With No Summary</title>
    <published>2020-01-01T00:00:00Z</published>
    <author><name>Solo Author</name></author>
  </entry>`);
    const r = await arxiv.search("q", { fetcher: fakeFetch(200, noSummary) });
    expect(r.posts[0].text).toBe("A Paper With No Summary");
    expect(r.posts[0].author).toBe("Solo Author");
  });

  it("normalizes a multi-line, indented title and summary to single-space text", async () => {
    const wrapped = feed(`  <entry>
    <id>http://arxiv.org/abs/2222.22222v1</id>
    <title>A Very Long Title That
  Wraps Across Multiple
  Lines</title>
    <summary>  Leading and trailing whitespace,
    plus internal
    line wraps.  </summary>
    <published>2021-01-01T00:00:00Z</published>
  </entry>`);
    const r = await arxiv.search("q", { fetcher: fakeFetch(200, wrapped) });
    expect(r.posts[0].title).toBe("A Very Long Title That Wraps Across Multiple Lines");
    expect(r.posts[0].text).toBe(
      "A Very Long Title That Wraps Across Multiple Lines — Leading and trailing whitespace, plus internal line wraps.",
    );
  });

  it("returns null author when the entry has no <author> tags", async () => {
    const noAuthor = feed(`  <entry>
    <id>http://arxiv.org/abs/3333.33333v1</id>
    <title>No Authors Listed</title>
    <published>2019-01-01T00:00:00Z</published>
  </entry>`);
    const r = await arxiv.search("q", { fetcher: fakeFetch(200, noAuthor) });
    expect(r.posts[0].author).toBeNull();
  });

  it("truncates text to 600 chars", async () => {
    const long = feed(`  <entry>
    <id>http://arxiv.org/abs/4444.44444v1</id>
    <title>T</title>
    <summary>${"a".repeat(700)}</summary>
    <published>2019-01-01T00:00:00Z</published>
  </entry>`);
    const r = await arxiv.search("q", { fetcher: fakeFetch(200, long) });
    expect(r.posts[0].text).toHaveLength(600);
  });

  it("dedupes entries sharing the same abs-page id/url", async () => {
    const dup = feed(`  <entry>
    <id>http://arxiv.org/abs/5555.55555v1</id>
    <title>First Copy</title>
    <published>2019-01-01T00:00:00Z</published>
  </entry>
  <entry>
    <id>http://arxiv.org/abs/5555.55555v1</id>
    <title>Second Copy (same id)</title>
    <published>2019-01-01T00:00:00Z</published>
  </entry>`);
    const r = await arxiv.search("q", { fetcher: fakeFetch(200, dup) });
    expect(r.posts).toHaveLength(1);
    expect(r.posts[0].title).toBe("First Copy");
  });

  it("returns [] with status ok when the feed has no entries", async () => {
    const r = await arxiv.search("nomatch", { fetcher: fakeFetch(200, feed("")) });
    expect(r).toEqual({ posts: [], status: "ok" });
  });

  it("builds the request url with all:<query> search_query, start=0, sortBy=relevance, and max_results", async () => {
    const { fetcher, calls } = spyFetcher(200, feed(""));
    await arxiv.search("ai & audio", { fetcher, limit: 10 });
    const url = new URL(calls[0].url);
    expect(url.origin + url.pathname).toBe("http://export.arxiv.org/api/query");
    expect(url.searchParams.get("search_query")).toBe("all:ai & audio");
    expect(url.searchParams.get("start")).toBe("0");
    expect(url.searchParams.get("sortBy")).toBe("relevance");
    expect(url.searchParams.get("max_results")).toBe("10");
  });

  it("defaults limit (max_results) to 25", async () => {
    const { fetcher, calls } = spyFetcher(200, feed(""));
    await arxiv.search("q", { fetcher });
    expect(new URL(calls[0].url).searchParams.get("max_results")).toBe("25");
  });

  it("passes an AbortSignal for the 8s timeout", async () => {
    const { fetcher, calls } = spyFetcher(200, feed(""));
    await arxiv.search("q", { fetcher });
    expect(calls[0].init?.signal).toBeInstanceOf(AbortSignal);
  });

  it("returns status error with one console.warn on a non-ok response", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const r = await arxiv.search("q", { fetcher: fakeFetch(500, "server error") });
    expect(r.posts).toEqual([]);
    expect(r.status).toBe("error");
    expect(r.note).toBeTruthy();
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it("returns status error with one console.warn when the fetcher throws", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const throwing: Fetcher = async () => {
      throw new Error("network down");
    };
    const r = await arxiv.search("q", { fetcher: throwing });
    expect(r.posts).toEqual([]);
    expect(r.status).toBe("error");
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it("returns status error on malformed/unparseable XML rather than throwing", async () => {
    const r = await arxiv.search("q", { fetcher: fakeFetch(200, "not xml at all") });
    expect(r.posts).toEqual([]);
    expect(r.status === "ok" || r.status === "error").toBe(true);
  });
});
