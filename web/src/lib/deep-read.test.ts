import { describe, expect, it } from "vitest";
import type { Fetcher } from "@/lib/sources/types";
import {
  cardContent, composeDeepRead, deepRead, deepReadPatch, firstLinkIn, hackerNewsItemId, isArticleUrl, isDiscussionKind,
  linkedArticleUrl, lobstersShortId, needsDeepRead, readableExcerpt, RICH_CONTENT_CHARS, summaryOf, type DeepReadIdea,
} from "./deep-read";

type Route = { status?: number; body: string } | Error;

/** A fetcher answering from a url → response map, recording every url it was asked for. */
function fetcherFor(routes: Record<string, Route>): Fetcher & { calls: string[] } {
  const calls: string[] = [];
  const f = (async (url: string) => {
    calls.push(url);
    const route = routes[url];
    if (!route) return { ok: false, status: 404, text: async () => "not found" };
    if (route instanceof Error) throw route;
    const status = route.status ?? 200;
    return { ok: status >= 200 && status < 300, status, text: async () => route.body };
  }) as Fetcher & { calls: string[] };
  f.calls = calls;
  return f;
}

function idea(over: Partial<DeepReadIdea> = {}): DeepReadIdea {
  return { kind: "hackernews", url: "https://news.ycombinator.com/item?id=41", title: null, content: "How We built a $1M ARR open source SaaS", meta: {}, ...over };
}

const ARTICLE_URL = "https://blog.example.com/arr";
const SENTENCE = "We doubled down on self-serve onboarding and let the open source community carry the top of the funnel. ";
const ARTICLE_HTML = `<html><head><title>How we built a $1M ARR open source SaaS – Example Blog</title>
<meta property="og:title" content="How we built a $1M ARR open source SaaS"></head>
<body><nav>Home Pricing Blog Login</nav><header>Example Blog</header>
<article><h1>How we built a $1M ARR open source SaaS</h1><p>${SENTENCE.repeat(3)}</p><p>Pricing was the hard part.</p><script>track()</script></article>
<footer>© Example</footer></body></html>`;

const HN_ITEM = JSON.stringify({
  title: "How We built a $1M ARR open source SaaS",
  url: ARTICLE_URL,
  text: null,
  author: "caust1c",
  children: [
    { author: "alice", text: "<p>Great write-up, but the churn numbers are missing &#x2F; glossed over.</p>", children: [{ author: "bob", text: "Agreed", children: [] }, { author: "carol", text: "Same", children: [] }] },
    { author: "ghost", text: "[deleted]", children: [] },
    { author: "dan", text: "Congrats!", children: [] },
  ],
});

describe("needsDeepRead", () => {
  it("always reads a discussion source, whatever the content length", () => {
    expect(needsDeepRead(idea())).toBe(true);
    expect(needsDeepRead(idea({ kind: "lobsters", url: ARTICLE_URL, content: "x".repeat(RICH_CONTENT_CHARS + 10) }))).toBe(true);
  });

  it("never reads twice", () => {
    expect(needsDeepRead(idea({ meta: { deepReadAt: "2026-09-23T07:00:00Z" } }))).toBe(false);
  });

  it("reads a link source only when the content is thin and links to an article", () => {
    expect(needsDeepRead(idea({ kind: "bluesky", url: "https://bsky.app/profile/a/post/1", content: `Loved this ${ARTICLE_URL}` }))).toBe(true);
    expect(needsDeepRead(idea({ kind: "bluesky", url: "https://bsky.app/profile/a/post/1", content: "No link here, just a thought." }))).toBe(false);
    expect(needsDeepRead(idea({ kind: "devto", url: "https://dev.to/a/post", content: "x".repeat(RICH_CONTENT_CHARS) }))).toBe(false);
    expect(needsDeepRead(idea({ kind: "devto", url: "https://dev.to/a/post", content: "short" }))).toBe(true);
  });

  it("skips notes, videos, arXiv, GitHub and Product Hunt", () => {
    for (const kind of ["note", "youtube", "arxiv", "github", "producthunt"]) {
      expect(needsDeepRead(idea({ kind, url: ARTICLE_URL, content: "short" }))).toBe(false);
    }
  });
});

describe("url helpers", () => {
  it("hackerNewsItemId parses the item page", () => {
    expect(hackerNewsItemId("https://news.ycombinator.com/item?id=41")).toBe("41");
    expect(hackerNewsItemId(ARTICLE_URL)).toBeNull();
    expect(hackerNewsItemId(null)).toBeNull();
  });

  it("lobstersShortId prefers the scout's sourceId, else parses a comments-page url", () => {
    expect(lobstersShortId(idea({ kind: "lobsters", url: ARTICLE_URL, meta: { sourceId: "lobsters:abc123" } }))).toBe("abc123");
    expect(lobstersShortId(idea({ kind: "lobsters", url: ARTICLE_URL, meta: { sourceId: "abc123" } }))).toBe("abc123");
    expect(lobstersShortId(idea({ kind: "lobsters", url: "https://lobste.rs/s/xyz789/some-title" }))).toBe("xyz789");
    expect(lobstersShortId(idea({ kind: "lobsters", url: ARTICLE_URL }))).toBeNull();
  });

  it("isArticleUrl rejects social post pages, private hosts and non-http schemes", () => {
    expect(isArticleUrl(ARTICLE_URL)).toBe(true);
    expect(isArticleUrl("https://bsky.app/profile/a/post/1")).toBe(false);
    expect(isArticleUrl("https://news.ycombinator.com/item?id=1")).toBe(false);
    expect(isArticleUrl("http://169.254.169.254/latest/meta-data")).toBe(false);
    expect(isArticleUrl("http://localhost:3210/x")).toBe(false);
    expect(isArticleUrl("ftp://example.com/x")).toBe(false);
    expect(isArticleUrl("https://www.youtube.com/watch?v=abc")).toBe(false);
  });

  it("firstLinkIn drops trailing punctuation", () => {
    expect(firstLinkIn(`Read ${ARTICLE_URL}. Then this.`)).toBe(ARTICLE_URL);
    expect(firstLinkIn("nothing")).toBeNull();
  });

  it("linkedArticleUrl: lemmy's own post page is not the article, its external url is", () => {
    expect(linkedArticleUrl(idea({ kind: "lemmy", url: "https://lemmy.world/post/123", content: "title — body" }))).toBeNull();
    expect(linkedArticleUrl(idea({ kind: "lemmy", url: ARTICLE_URL, content: "title" }))).toBe(ARTICLE_URL);
    expect(linkedArticleUrl(idea({ kind: "mastodon", url: "https://m.social/@a/1", content: `see ${ARTICLE_URL}` }))).toBe(ARTICLE_URL);
    expect(linkedArticleUrl(idea({ kind: "x_post", url: "https://x.com/a/status/1", content: "see https://x.com/a/status/1" }))).toBeNull();
  });
});

describe("readableExcerpt", () => {
  it("prefers the <article>, drops nav/header/footer/scripts and decodes entities", () => {
    const text = readableExcerpt(ARTICLE_HTML)!;
    expect(text).toContain("Pricing was the hard part.");
    expect(text).toContain(SENTENCE.trim());
    expect(text).not.toContain("Home Pricing Blog Login");
    expect(text).not.toContain("track()");
    expect(text).not.toContain("© Example");
  });

  it("decodes common named entities and drops unknown ones", () => {
    const html = `<body><article><p>${"Plain sentence here. ".repeat(12)}&larr; All posts &nbsp;&mdash; done &fnord; end</p></article></body>`;
    const text = readableExcerpt(html)!;
    expect(text).toContain("← All posts — done");
    expect(text).not.toContain("&larr;");
    expect(text).not.toContain("&fnord;");
  });

  it("falls back to the body when the <article> is a stub", () => {
    const html = `<html><body><article>Read more</article><div><p>${SENTENCE.repeat(4)}</p></div></body></html>`;
    expect(readableExcerpt(html)).toContain(SENTENCE.trim());
  });

  it("clamps at a sentence end and marks the cut", () => {
    const long = `<body><p>${"A sentence that goes on for a while. ".repeat(200)}</p></body>`;
    const text = readableExcerpt(long, 1000)!;
    expect(text.length).toBeLessThanOrEqual(1003);
    expect(text.endsWith(". …")).toBe(true);
  });

  it("returns null for a page with no visible text", () => {
    expect(readableExcerpt("<html><head><script>x()</script></head><body></body></html>")).toBeNull();
  });
});

describe("deepRead", () => {
  it("Hacker News link story: article extract + most-discussed comments, deleted ones dropped", async () => {
    const fetcher = fetcherFor({ "https://hn.algolia.com/api/v1/items/41": { body: HN_ITEM }, [ARTICLE_URL]: { body: ARTICLE_HTML } });
    const read = (await deepRead(idea(), fetcher))!;
    expect(read).not.toBeNull();
    expect(read.articleUrl).toBe(ARTICLE_URL);
    expect(read.discussionUrl).toBe("https://news.ycombinator.com/item?id=41");
    expect(read.parts).toEqual(["article", "discussion"]);
    expect(read.notes).toEqual([]);
    expect(read.text.startsWith("How We built a $1M ARR open source SaaS\nLink: https://blog.example.com/arr")).toBe(true);
    expect(read.text).toContain("Article extract (blog.example.com):");
    expect(read.text).toContain("Pricing was the hard part.");
    expect(read.text).toContain("Discussion highlights on Hacker News (2 of the comments):");
    expect(read.text).toContain("— alice: Great write-up, but the churn numbers are missing / glossed over.");
    expect(read.text.indexOf("— alice:")).toBeLessThan(read.text.indexOf("— dan:"));
    expect(read.text).not.toContain("[deleted]");
    expect(read.text).toContain("Discussion: https://news.ycombinator.com/item?id=41");
    expect(fetcher.calls).toEqual(["https://hn.algolia.com/api/v1/items/41", ARTICLE_URL]);
    // The card: "title — the article's opening", like every other source's card.
    expect(read.title).toBe("How We built a $1M ARR open source SaaS");
    expect(read.summary!.startsWith("We doubled down on self-serve onboarding")).toBe(true);
    expect(read.summary!.length).toBeLessThanOrEqual(281);
    expect(cardContent(idea(), read)).toBe(`How We built a $1M ARR open source SaaS — ${read.summary}`);
  });

  it("passes the per-request timeout through to every fetch", async () => {
    const seen: number[] = [];
    const inner = fetcherFor({ "https://hn.algolia.com/api/v1/items/41": { body: HN_ITEM }, [ARTICLE_URL]: { body: ARTICLE_HTML } });
    const fetcher = (async (url: string, init?: RequestInit) => {
      seen.push(init?.signal instanceof AbortSignal ? 1 : 0);
      return inner(url, init);
    }) as typeof inner;
    await deepRead(idea(), fetcher, { timeoutMs: 1500 });
    expect(seen).toEqual([1, 1]);
  });

  it("Ask HN: the full story text and the comments, no article fetched", async () => {
    const item = JSON.stringify({ title: "Ask HN: How do you price a dev tool?", url: null, text: "<p>We&#x27;re torn between seats and usage.</p>", children: [{ author: "eve", text: "Usage, always.", children: [] }] });
    const fetcher = fetcherFor({ "https://hn.algolia.com/api/v1/items/41": { body: item } });
    const read = (await deepRead(idea({ content: "Ask HN: How do you price a dev tool? — We're torn" }), fetcher))!;
    expect(read.articleUrl).toBeNull();
    expect(read.parts).toEqual(["discussion"]);
    expect(read.text).toContain("Post text (Hacker News):\nWe're torn between seats and usage.");
    expect(read.text).toContain("— eve: Usage, always.");
    expect(read.text).not.toContain("Link:");
    expect(fetcher.calls).toEqual(["https://hn.algolia.com/api/v1/items/41"]);
  });

  it("Lobsters via meta.sourceId: best-scored comments first, article from the story url", async () => {
    const story = JSON.stringify({
      short_id: "abc123", url: ARTICLE_URL, title: "How we built a $1M ARR open source SaaS", description_plain: "",
      comments: [
        { comment_plain: "Low-effort take.", score: 1, commenting_user: "x" },
        { comment_plain: "The interesting bit is the community-led funnel.", score: 9, commenting_user: "y" },
        { comment_plain: "gone", score: 20, commenting_user: "z", is_deleted: true },
      ],
    });
    const fetcher = fetcherFor({ "https://lobste.rs/s/abc123.json": { body: story }, [ARTICLE_URL]: { body: ARTICLE_HTML } });
    const read = (await deepRead(idea({ kind: "lobsters", url: ARTICLE_URL, meta: { sourceId: "lobsters:abc123" } }), fetcher))!;
    expect(read.parts).toEqual(["article", "discussion"]);
    expect(read.discussionUrl).toBe("https://lobste.rs/s/abc123");
    expect(read.text.indexOf("— y:")).toBeLessThan(read.text.indexOf("— x:"));
    expect(read.text).not.toContain("— z:");
    expect(read.text).toContain("Discussion highlights on Lobsters (2 of the comments):");
  });

  it("Lobsters link story without a saved id: article only, no discussion request", async () => {
    const fetcher = fetcherFor({ [ARTICLE_URL]: { body: ARTICLE_HTML } });
    const read = (await deepRead(idea({ kind: "lobsters", url: ARTICLE_URL }), fetcher))!;
    expect(read.parts).toEqual(["article"]);
    expect(read.discussionUrl).toBeNull();
    expect(fetcher.calls).toEqual([ARTICLE_URL]);
  });

  it("Bluesky post linking to an article: the extract, headed by the article's og:title", async () => {
    const fetcher = fetcherFor({ [ARTICLE_URL]: { body: ARTICLE_HTML } });
    const read = (await deepRead(idea({ kind: "bluesky", url: "https://bsky.app/profile/a/post/1", title: null, content: `Loved this ${ARTICLE_URL}` }), fetcher))!;
    expect(read.text.startsWith("How we built a $1M ARR open source SaaS\nLink: https://blog.example.com/arr")).toBe(true);
    expect(read.parts).toEqual(["article"]);
  });

  it("returns null when nothing could be gathered (discussion down, no article)", async () => {
    const fetcher = fetcherFor({ "https://hn.algolia.com/api/v1/items/41": { status: 500, body: "boom" } });
    expect(await deepRead(idea(), fetcher)).toBeNull();
  });

  it("keeps the discussion when the article fails, and notes the failure", async () => {
    const fetcher = fetcherFor({ "https://hn.algolia.com/api/v1/items/41": { body: HN_ITEM }, [ARTICLE_URL]: new Error("socket hang up") });
    const read = (await deepRead(idea(), fetcher))!;
    expect(read.parts).toEqual(["discussion"]);
    expect(read.articleUrl).toBe(ARTICLE_URL);
    expect(read.notes).toEqual(["article: socket hang up"]);
    expect(read.text).toContain("Link: https://blog.example.com/arr");
    expect(read.text).not.toContain("Article extract");
  });

  it("never fetches an article on a private host, even when the story links to it", async () => {
    const item = JSON.stringify({ title: "t", url: "http://169.254.169.254/latest/meta-data", text: null, children: [{ author: "a", text: "hi", children: [] }] });
    const fetcher = fetcherFor({ "https://hn.algolia.com/api/v1/items/41": { body: item } });
    const read = (await deepRead(idea(), fetcher))!;
    expect(read.articleUrl).toBeNull();
    expect(fetcher.calls).toEqual(["https://hn.algolia.com/api/v1/items/41"]);
  });

  it("a page with only a JS shell yields no article", async () => {
    const fetcher = fetcherFor({ [ARTICLE_URL]: { body: "<html><body><div id=root></div><script>boot()</script></body></html>" } });
    expect(await deepRead(idea({ kind: "article", url: ARTICLE_URL, content: "short" }), fetcher)).toBeNull();
  });
});

describe("composeDeepRead", () => {
  it("falls back to the card's own first line as the title", () => {
    const read = composeDeepRead(idea({ content: "First line\nsecond" }), { url: ARTICLE_URL, title: null, excerpt: "body" }, null, []);
    expect(read.text.split("\n")[0]).toBe("First line");
    expect(read.title).toBe("First line");
  });

  it("summary: the post's own text when there is no article, the top comment when there is neither", async () => {
    const ask = JSON.stringify({ title: "Ask HN: pricing?", url: null, text: "<p>We&#x27;re torn between seats and usage. Advice welcome.</p>", children: [{ author: "eve", text: "Usage, always.", children: [] }] });
    const askRead = (await deepRead(idea(), fetcherFor({ "https://hn.algolia.com/api/v1/items/41": { body: ask } })))!;
    expect(askRead.summary).toBe("We're torn between seats and usage. Advice welcome.");

    const bare = JSON.stringify({ title: "Show HN: a thing", url: null, text: null, children: [{ author: "eve", text: "Neat, but why not SQLite?", children: [] }] });
    const bareRead = (await deepRead(idea(), fetcherFor({ "https://hn.algolia.com/api/v1/items/41": { body: bare } })))!;
    expect(bareRead.summary).toBe("Top comment (eve): Neat, but why not SQLite?");
  });
});

describe("summaryOf / deepReadPatch / isDiscussionKind", () => {
  it("skips leading chrome lines (crumbs, the title again, date/byline), then cuts at a sentence past half the cap", () => {
    const prose = "← All posts How we built a $1M ARR open source SaaS\nJun 22, 2022 • Written by Marko Saric\nWe reached a significant milestone of one million in annual recurring revenue with a simple product. The team is four people. " + "More words follow here. ".repeat(20);
    const s = summaryOf(prose, 200, "How We built a $1M ARR open source SaaS")!;
    expect(s.startsWith("We reached a significant milestone")).toBe(true);
    expect(s.endsWith(".")).toBe(true);
    expect(s.length).toBeLessThanOrEqual(200);
    // Without a title to match, the crumb line still goes (it starts with an arrow) and so does the dated byline.
    expect(summaryOf(prose, 200)!.startsWith("We reached")).toBe(true);
  });

  it("falls back to the first line when nothing reads like prose", () => {
    expect(summaryOf("Short.\nAlso short.", 100)).toBe("Short. Also short.");
  });

  it("cuts at a word and marks it when no sentence ends late enough", () => {
    const s = summaryOf("word ".repeat(100), 50)!;
    expect(s.endsWith("…")).toBe(true);
    expect(s.length).toBeLessThanOrEqual(51);
    expect(summaryOf("   ")).toBeNull();
  });

  it("deepReadPatch: the card's content plus the full text, links and done-marker in meta, existing meta kept", () => {
    const read = composeDeepRead(idea({ meta: { topic: "indie saas", rank: 68 } }), { url: ARTICLE_URL, title: "T", excerpt: `${SENTENCE.repeat(2)}Second paragraph.` }, null, []);
    const patch = deepReadPatch(idea({ meta: { topic: "indie saas", rank: 68 } }), read, new Date("2026-09-23T08:00:00Z"));
    expect(patch.content!.startsWith("T — We doubled down")).toBe(true);
    expect(patch.meta).toMatchObject({ topic: "indie saas", rank: 68, deepReadAt: "2026-09-23T08:00:00.000Z", deepReadText: read.text, deepReadParts: ["article"], articleUrl: ARTICLE_URL, discussionUrl: null });
  });

  it("isDiscussionKind: Hacker News and Lobsters only", () => {
    expect(isDiscussionKind("hackernews")).toBe(true);
    expect(isDiscussionKind("lobsters")).toBe(true);
    expect(isDiscussionKind("bluesky")).toBe(false);
  });
});
