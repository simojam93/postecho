import { describe, expect, it } from "vitest";
import { classifyUrl, decodeEntities, enrich, stripTags, type Fetcher } from "@/lib/enrich";

const xOembed = JSON.stringify({
  author_name: "Ronin",
  html: '<blockquote class="twitter-tweet"><p lang="en">Best methods to promote your SaaS:<br>build in public</p>&mdash; Ronin (@DeRonin_) <a href="https://twitter.com/DeRonin_/status/1">August 10, 2026</a></blockquote>',
});

const xOembedEscapedEntities = JSON.stringify({
  author_name: "Ronin",
  html: '<blockquote class="twitter-tweet"><p lang="en">Use &amp;lt;b&amp;gt; carefully</p>&mdash; Ronin (@DeRonin_) <a href="https://twitter.com/DeRonin_/status/2">September 1, 2026</a></blockquote>',
});

const ytOembed = JSON.stringify({
  title: "How to Build an AI-Native Services Company",
  author_name: "Y Combinator",
  thumbnail_url: "https://i.ytimg.com/vi/abc/hqdefault.jpg",
});

const articleHtml = `<html><head>
<meta property="og:title" content="A Great Article" />
<meta property="og:description" content="Why things happen." />
</head><body>hi</body></html>`;

const articleHtmlEntities = `<html><head>
<meta property="og:title" content="AT&amp;T - Wikipedia" />
<meta property="og:description" content="Alzheimer&#039;s disease" />
</head><body>hi</body></html>`;

const articleHtmlReversedAttrs = `<html><head>
<meta content="Reversed Title" property="og:title">
<meta content='Reversed description' property='og:description'>
</head><body>hi</body></html>`;

function fakeFetch(map: Record<string, string>): Fetcher {
  return async (url: string) => {
    const hit = Object.entries(map).find(([k]) => url.includes(k));
    if (!hit) return { ok: false, status: 404, text: async () => "" };
    return { ok: true, status: 200, text: async () => hit[1] };
  };
}

function spyFetcher(): { fetcher: Fetcher; calls: string[] } {
  const calls: string[] = [];
  const fetcher: Fetcher = async (url) => {
    calls.push(url);
    return { ok: false, status: 404, text: async () => "" };
  };
  return { fetcher, calls };
}

describe("decodeEntities (exported for reuse by lib/sources/hackernews.ts)", () => {
  it("decodes a generic hex numeric entity (&#x2F; -> /)", () => {
    expect(decodeEntities("post&#x2F;path")).toBe("post/path");
  });

  it("decodes a generic hex numeric entity for an apostrophe (&#x27;)", () => {
    expect(decodeEntities("it&#x27;s")).toBe("it's");
  });

  it("decodes a generic decimal numeric entity (&#8217; -> curly apostrophe)", () => {
    expect(decodeEntities("don&#8217;t")).toBe("don’t");
  });

  it("still decodes the zero-padded decimal apostrophe form (&#039;)", () => {
    expect(decodeEntities("Alzheimer&#039;s")).toBe("Alzheimer's");
  });

  it("still decodes named entities (&amp; last, so a double-escaped entity doesn't collapse)", () => {
    expect(decodeEntities("Use &amp;lt;b&amp;gt; carefully")).toBe("Use &lt;b&gt; carefully");
    expect(decodeEntities("AT&amp;T")).toBe("AT&T");
  });

  it("is a no-op on text with no entities", () => {
    expect(decodeEntities("plain text")).toBe("plain text");
  });
});

describe("stripTags (exported for reuse by lib/sources/hackernews.ts)", () => {
  it("strips tags, decodes entities (including generic numeric/hex), and trims", () => {
    expect(stripTags("  <p>It&#x27;s free&#x2F;open &#8217;source&#8217;</p>  ")).toBe("It's free/open ’source’");
  });
});

describe("classifyUrl", () => {
  it("detects x posts", () => {
    expect(classifyUrl("https://x.com/DeRonin_/status/12345")).toBe("x_post");
    expect(classifyUrl("https://twitter.com/a/status/9")).toBe("x_post");
  });
  it("detects youtube", () => {
    expect(classifyUrl("https://www.youtube.com/watch?v=abc")).toBe("youtube");
    expect(classifyUrl("https://youtu.be/abc")).toBe("youtube");
  });
  it("falls back to article for other urls", () => {
    expect(classifyUrl("https://example.com/post")).toBe("article");
  });
  it("falls back to note for invalid urls", () => {
    expect(classifyUrl("not a url")).toBe("note");
  });
});

describe("enrich", () => {
  it("enriches an x post via oembed (text without tags, author)", async () => {
    const r = await enrich("https://x.com/DeRonin_/status/1", fakeFetch({ "publish.twitter.com/oembed": xOembed }));
    expect(r.kind).toBe("x_post");
    expect(r.author).toBe("Ronin");
    expect(r.content).toContain("Best methods to promote your SaaS:");
    expect(r.content).toContain("build in public");
    expect(r.content).not.toContain("<");
    // Attribution boilerplate ("— name (@handle) date") lives outside the
    // tweet's own <p> in Twitter's oEmbed HTML and must not leak into content.
    expect(r.content).not.toContain("(@DeRonin_)");
    expect(r.content).not.toContain("August 10, 2026");
  });

  it("decodes &amp; last so a double-escaped entity doesn't collapse into a real tag", async () => {
    const r = await enrich(
      "https://x.com/DeRonin_/status/2",
      fakeFetch({ "publish.twitter.com/oembed": xOembedEscapedEntities }),
    );
    expect(r.content).toContain("&lt;b&gt;");
    expect(r.content).not.toContain("<b>");
  });

  it("enriches youtube via oembed", async () => {
    const r = await enrich("https://youtu.be/abc", fakeFetch({ "youtube.com/oembed": ytOembed }));
    expect(r.kind).toBe("youtube");
    expect(r.title).toBe("How to Build an AI-Native Services Company");
    expect(r.meta.thumbnailUrl).toContain("i.ytimg.com");
  });

  it("enriches articles via og tags", async () => {
    const r = await enrich("https://example.com/post", fakeFetch({ "example.com/post": articleHtml }));
    expect(r.kind).toBe("article");
    expect(r.title).toBe("A Great Article");
    expect(r.content).toBe("Why things happen.");
  });

  it("falls back to <title> and <meta name=description> when a page has no Open Graph tags", async () => {
    const plain = `<html><head><title>Do Things that Don&#x27;t Scale</title>
<meta name="description" content="An essay about early startups."></head><body><p>Body text.</p></body></html>`;
    const r = await enrich("https://example.com/ds.html", fakeFetch({ "example.com/ds.html": plain }));
    expect(r.kind).toBe("article");
    expect(r.title).toBe("Do Things that Don't Scale");
    expect(r.content).toBe("An essay about early startups.");
  });

  it("uses the first visible body text as content when there is no description at all", async () => {
    const bare = `<html><head><title>Only a title</title><style>p{}</style></head><body><script>x()</script><h1>Only a title</h1><p>One of the most common types of advice we give at Y Combinator is to do things that don't scale.</p></body></html>`;
    const r = await enrich("https://example.com/bare", fakeFetch({ "example.com/bare": bare }));
    expect(r.title).toBe("Only a title");
    expect(r.content).toContain("One of the most common types of advice");
    expect(r.content).not.toContain("x()");
    expect(r.content).not.toContain("<");
  });

  it("decodes html entities in article og tags", async () => {
    const r = await enrich("https://example.com/wiki", fakeFetch({ "example.com/wiki": articleHtmlEntities }));
    expect(r.kind).toBe("article");
    expect(r.title).toBe("AT&T - Wikipedia");
    expect(r.content).toBe("Alzheimer's disease");
  });

  it("finds og tags when content comes before property, double- or single-quoted", async () => {
    const r = await enrich(
      "https://example.com/reversed",
      fakeFetch({ "example.com/reversed": articleHtmlReversedAttrs }),
    );
    expect(r.kind).toBe("article");
    expect(r.title).toBe("Reversed Title");
    expect(r.content).toBe("Reversed description");
  });

  it("degrades gracefully when fetch fails", async () => {
    const r = await enrich("https://x.com/a/status/1", fakeFetch({}));
    expect(r.kind).toBe("x_post");
    expect(r.title).toBeNull();
  });

  it("degrades gracefully when youtube fetch fails", async () => {
    const r = await enrich("https://youtu.be/abc", fakeFetch({}));
    expect(r.kind).toBe("youtube");
    expect(r.title).toBeNull();
  });

  it("degrades gracefully when article fetch fails", async () => {
    const r = await enrich("https://example.com/missing", fakeFetch({}));
    expect(r.kind).toBe("article");
    expect(r.title).toBeNull();
  });

  it("blocks SSRF to localhost without calling the fetcher", async () => {
    const { fetcher, calls } = spyFetcher();
    const r = await enrich("http://localhost:3000/x", fetcher);
    expect(r.kind).toBe("article");
    expect(r.title).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it("blocks SSRF to private IP ranges without calling the fetcher", async () => {
    const { fetcher, calls } = spyFetcher();
    const r = await enrich("http://192.168.1.10/x", fetcher);
    expect(r.kind).toBe("article");
    expect(r.title).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it("blocks SSRF to a decimal IPv4 literal without calling the fetcher", async () => {
    const { fetcher, calls } = spyFetcher();
    const r = await enrich("http://2130706433/x", fetcher); // decimal for 127.0.0.1
    expect(r.kind).toBe("article");
    expect(r.title).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it("blocks SSRF to an IPv6 link-local address without calling the fetcher", async () => {
    const { fetcher, calls } = spyFetcher();
    const r = await enrich("http://[fe80::1]/x", fetcher);
    expect(r.kind).toBe("article");
    expect(r.title).toBeNull();
    expect(calls).toHaveLength(0);
  });
});
