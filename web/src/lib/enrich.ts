export type Fetcher = (url: string) => Promise<{
  ok: boolean; status: number; text: () => Promise<string>;
}>;

// "bluesky"/"hackernews"/"arxiv"/"github"/"devto"/"mastodon"/"reddit"/
// "producthunt" are never produced by enrich() itself (it only classifies
// URLs a human pasted) — they're added here so scout-run.ts can build an
// `Enriched` for a scouted SourcePost through the same saveIdeaFromInput()
// path manual/scout captures already use. Kept in sync with db/schema.ts's
// `ideaKind` pgEnum.
export type IdeaKind =
  | "x_post" | "youtube" | "article" | "note" | "bluesky" | "hackernews"
  | "arxiv" | "github" | "devto" | "mastodon" | "reddit" | "producthunt"
  | "lobsters" | "lemmy";

export type Enriched = {
  kind: IdeaKind;
  title: string | null;
  content: string | null;
  author: string | null;
  meta: Record<string, unknown>;
};

const FETCH_TIMEOUT_MS = 8000;

const defaultFetcher: Fetcher = (url) =>
  fetch(url, {
    headers: { "User-Agent": "PostEchoBot/1.0" },
    // Bound how long a hung third-party server can hold us: past this, the
    // fetch rejects (AbortError) and the caller's try/catch degrades to the
    // empty shape instead of the request holding until the platform kills it.
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });

/** The document's <title> text, or null. */
function titleTag(head: string): string | null {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(head);
  const t = m ? m[1].replace(/\s+/g, " ").trim() : "";
  return t ? t : null;
}

/** <meta name="…" content="…"> in either attribute order, or null. */
function metaNameContent(head: string, name: string): string | null {
  const re1 = new RegExp(`<meta[^>]*\\bname=["']${name}["'][^>]*\\bcontent=["']([^"']*)["']`, "i");
  const re2 = new RegExp(`<meta[^>]*\\bcontent=["']([^"']*)["'][^>]*\\bname=["']${name}["']`, "i");
  const m = re1.exec(head) ?? re2.exec(head);
  const v = m ? m[1].trim() : "";
  return v ? v : null;
}

const BODY_EXCERPT_CHARS = 600;

/** First visible characters of the body with scripts, styles and tags stripped — or null when there is no text. */
function bodyExcerpt(html: string): string | null {
  const bodyStart = html.search(/<body[^>]*>/i);
  const body = bodyStart >= 0 ? html.slice(bodyStart) : html;
  const text = body
    .replace(/<(script|style|noscript|svg)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return text ? text.slice(0, BODY_EXCERPT_CHARS) : null;
}

export function classifyUrl(url: string): IdeaKind {
  let u: URL;
  try { u = new URL(url); } catch { return "note"; }
  const host = u.hostname.replace(/^www\./, "");
  if ((host === "x.com" || host === "twitter.com") && u.pathname.includes("/status/")) return "x_post";
  if (host === "youtube.com" || host === "m.youtube.com" || host === "youtu.be") return "youtube";
  return "article";
}

// Shared HTML entity decoder used by the x_post (stripTags) and article (og
// tag) paths here, and (imported) by lib/sources/hackernews.ts for HN
// titles/story text. "&amp;" is decoded LAST, after every other entity:
// decoding it first would turn a literal, single-escaped "&amp;lt;" into
// "&lt;", which the "&lt;" replace would then wrongly re-decode into "<" — a
// double-decode. Doing "&amp;" last means the "&" it produces can no longer
// be matched by patterns that already ran, so each entity is only ever
// decoded once. The generic numeric (decimal "&#8217;", hex "&#x27;")
// entities subsume the older zero-padded-decimal-apostrophe special case
// ("&#39;", "&#039;", "&#0039;", ...) since real pages (Wikipedia among them,
// and Hacker News's Algolia API) use both numeric forms for arbitrary
// characters, not just the apostrophe.
// The named entities that show up in article/blog HTML besides the numeric
// forms (live, 2026-09-23: a blog's "&larr; All posts" reached the deep-read
// extract undecoded). `&amp;` stays last — see the test on double escaping.
const NAMED_ENTITIES: Record<string, string> = {
  mdash: "—", ndash: "–", hellip: "…", nbsp: " ", apos: "'", larr: "←", rarr: "→",
  laquo: "«", raquo: "»", ldquo: "“", rdquo: "”", lsquo: "‘", rsquo: "’", bull: "•",
  middot: "·", copy: "©", reg: "®", trade: "™", times: "×", deg: "°", euro: "€", pound: "£",
};
const NAMED_ENTITY_RE = new RegExp(`&(${Object.keys(NAMED_ENTITIES).join("|")});`, "g");

export function decodeEntities(s: string): string {
  return s
    .replace(NAMED_ENTITY_RE, (_, name: string) => NAMED_ENTITIES[name])
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&amp;/g, "&");
}

export function stripTags(html: string): string {
  const noTags = html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "");
  return decodeEntities(noTags).trim();
}

// OpenGraph tags always live in <head>, which in practice is a few KB. Bounding
// the text we run the (non-cheerio, hand-rolled) meta regex over keeps a single
// regex pass cheap even if an "article" URL resolves to a huge or malformed
// response body (the fetched HTML is third-party, arbitrary-sized content).
const MAX_HEAD_CHARS = 200_000;

function headSlice(html: string): string {
  const idx = html.indexOf("</head>");
  const head = idx === -1 ? html : html.slice(0, idx);
  return head.length > MAX_HEAD_CHARS ? head.slice(0, MAX_HEAD_CHARS) : head;
}

function metaContent(html: string, property: string): string | null {
  const re = new RegExp(
    `<meta[^>]+(?:property|name)=["']${property}["'][^>]*content=["']([^"']*)["']` +
    `|<meta[^>]+content=["']([^"']*)["'][^>]*(?:property|name)=["']${property}["']`,
    "i",
  );
  const m = html.match(re);
  return m ? (m[1] ?? m[2] ?? null) : null;
}

// Cheap, string-only SSRF guard for the article branch, which fetches whatever
// URL the caller passes in. This is deliberately not exhaustive (no DNS
// resolution, so a public hostname that resolves to a private IP still gets
// through) but blocks the obvious loopback/private/link-local/cloud-metadata
// targets someone could type directly — worth doing cheaply since this is a
// publicly deployable, self-hostable app. Exported for lib/deep-read.ts,
// which fetches the article a scouted story links to at Use time.
export function isPrivateHost(hostname: string): boolean {
  // IPv6 literals come back bracketed from URL#hostname (e.g. "[::1]",
  // "[fe80::1]" — verified with `new URL("http://[fe80::1]/").hostname`, which
  // is NOT bracket-stripped despite that being the more common assumption).
  // Strip once so every check below compares against the bare address —
  // this also fixes the "::1" check above, which was otherwise unreachable.
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "localhost" || h === "0.0.0.0" || h === "::1") return true;
  if (h.startsWith("127.") || h.startsWith("10.") || h.startsWith("192.168.") || h.startsWith("169.254.")) {
    return true;
  }
  if (h.endsWith(".local") || h.endsWith(".internal")) return true;
  const m = /^172\.(\d{1,3})\./.exec(h);
  if (m && Number(m[1]) >= 16 && Number(m[1]) <= 31) return true;
  // Decimal/hex IPv4 literals (e.g. "2130706433" or "0x7f000001" both decode
  // to 127.0.0.1). In practice URL's own parser already canonicalizes these
  // to dotted-quad before .hostname is read (verified empirically), so the
  // checks above already catch them — this is a defense-in-depth backstop,
  // not the primary guard, in case a hostname ever reaches this function
  // without going through `new URL(...)` first.
  if (/^\d+$/.test(h) || /^0x[0-9a-f]+$/i.test(h)) return true;
  // IPv6 link-local (fe80::/10) and unique-local (fc00::/7, i.e. "fc"/"fd")
  // addresses. Gated on the value actually containing a colon so this can
  // never fire on an ordinary hostname that happens to start with "fc"/"fd"
  // (fdic.gov and fcc.gov are real domains, not IPv6 literals).
  if (h.includes(":") && (h.startsWith("fe80:") || h.startsWith("fc") || h.startsWith("fd"))) return true;
  return false;
}

export async function enrich(url: string, fetcher: Fetcher = defaultFetcher): Promise<Enriched> {
  const kind = classifyUrl(url);
  const empty: Enriched = { kind, title: null, content: null, author: null, meta: {} };

  try {
    if (kind === "x_post") {
      const res = await fetcher(
        `https://publish.twitter.com/oembed?omit_script=true&url=${encodeURIComponent(url)}`,
      );
      if (!res.ok) return empty;
      const data = JSON.parse(await res.text()) as { author_name?: string; html?: string };
      let text: string | null = null;
      if (data.html) {
        // Twitter's oEmbed HTML wraps the tweet's own words in a single <p>,
        // followed by "— name (@handle) date" attribution outside it. Extract
        // just the <p> so that boilerplate doesn't leak into the idea content.
        const inner = data.html.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
        text = stripTags(inner ? inner[1] : data.html);
      }
      return { ...empty, author: data.author_name ?? null, content: text, title: text ? text.slice(0, 80) : null };
    }
    if (kind === "youtube") {
      const res = await fetcher(
        `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(url)}`,
      );
      if (!res.ok) return empty;
      const data = JSON.parse(await res.text()) as {
        title?: string; author_name?: string; thumbnail_url?: string;
      };
      return {
        ...empty,
        title: data.title ?? null,
        author: data.author_name ?? null,
        meta: { thumbnailUrl: data.thumbnail_url ?? null },
      };
    }
    if (kind === "article") {
      if (isPrivateHost(new URL(url).hostname)) return empty;
      const res = await fetcher(url);
      if (!res.ok) return empty;
      const html = await res.text();
      const head = headSlice(html);
      // Open Graph first; plain <title> / <meta name="description"> as the
      // fallback (live, 2026-09-23: paulgraham.com has a <title> and no OG
      // at all, so the seed came back empty and the query fell through to
      // the url slug — "html"). Last resort for the content: the first
      // ~600 visible characters of the body, so Jev has something real to
      // judge relevance against.
      const rawTitle = metaContent(head, "og:title") ?? titleTag(head);
      const rawDescription = metaContent(head, "og:description") ?? metaNameContent(head, "description") ?? bodyExcerpt(html);
      return {
        ...empty,
        title: rawTitle !== null ? decodeEntities(rawTitle) : null,
        content: rawDescription !== null ? decodeEntities(rawDescription) : null,
      };
    }
  } catch {
    return empty;
  }
  return empty;
}
