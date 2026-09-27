import {
  ADAPTER_DEFAULT_LIMIT,
  ADAPTER_TIMEOUT_MS,
  clampText,
  decodeEntities,
  dedupeByUrl,
  errorResult,
  stripTags,
  type AdapterPost,
  type AdapterResult,
  type SourceAdapter,
} from "./adapter";
import type { Fetcher } from "./types";

const BASE_URL = "http://export.arxiv.org/api/query";
const SOURCE_NAME = "arxiv";

function extractEntries(xml: string): string[] {
  return xml.match(/<entry>[\s\S]*?<\/entry>/g) ?? [];
}

function extractTag(entryXml: string, tag: string): string | null {
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, "i");
  const m = entryXml.match(re);
  return m ? m[1] : null;
}

function normalizeWhitespace(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

// <author><name>Jane Doe</name></author> — arXiv's Atom entries have no
// other <name> tags, so matching all of them within one entry is
// equivalent to (and simpler than) matching <author> then <name> inside it.
function extractAuthors(entryXml: string): string[] {
  const matches = [...entryXml.matchAll(/<name>([\s\S]*?)<\/name>/g)];
  return matches.map((m) => normalizeWhitespace(decodeEntities(m[1]))).filter(Boolean);
}

// arXiv's Atom feed reports each paper's abs-page <id> over plain http even
// though the API itself is served over https (verified against the live
// feed 2026-09-21) — upgraded here since every other link this app surfaces
// is https.
function toHttps(url: string): string {
  return url.startsWith("http://") ? `https://${url.slice("http://".length)}` : url;
}

function toAdapterPost(entryXml: string): AdapterPost | null {
  const rawId = extractTag(entryXml, "id");
  const rawTitle = extractTag(entryXml, "title");
  if (!rawId || !rawTitle) return null;

  const url = toHttps(normalizeWhitespace(rawId));
  const id = url.slice(url.lastIndexOf("/") + 1);
  const title = normalizeWhitespace(stripTags(decodeEntities(rawTitle)));

  const rawSummary = extractTag(entryXml, "summary");
  const summary = rawSummary ? normalizeWhitespace(stripTags(decodeEntities(rawSummary))) : "";
  const text = clampText(summary ? `${title} — ${summary}` : title);

  const authors = extractAuthors(entryXml);
  const rawPublished = extractTag(entryXml, "published");

  return {
    id,
    url,
    text,
    title,
    author: authors.length > 0 ? authors.join(", ") : null,
    metrics: {},
    createdAt: rawPublished ? normalizeWhitespace(rawPublished) : null,
  };
}

async function search(
  query: string,
  opts: { fetcher: Fetcher; limit?: number },
): Promise<AdapterResult> {
  const limit = opts.limit ?? ADAPTER_DEFAULT_LIMIT;
  const url =
    `${BASE_URL}?search_query=${encodeURIComponent(`all:${query}`)}` +
    `&start=0&max_results=${limit}&sortBy=relevance`;

  try {
    const res = await opts.fetcher(url, { signal: AbortSignal.timeout(ADAPTER_TIMEOUT_MS) });
    if (!res.ok) return errorResult(SOURCE_NAME, `request failed with status ${res.status}`);

    const xml = await res.text();
    const posts = dedupeByUrl(
      extractEntries(xml)
        .map(toAdapterPost)
        .filter((p): p is AdapterPost => p !== null),
    );
    return { posts, status: "ok" };
  } catch (e) {
    return errorResult(SOURCE_NAME, "request failed", e);
  }
}

/**
 * arXiv — the public Atom API (`export.arxiv.org`, no key, no rate-limit
 * auth) searched across all fields (`all:<query>`). Links to the paper's
 * abstract page rather than the PDF, matching every other adapter's
 * "open ↗ lands somewhere with context" convention (see hackernews.ts).
 *
 * Atom XML is parsed with small regex-based tag extraction rather than a
 * full XML parser/new dependency — arXiv's entry schema is flat and
 * well-known (id/title/summary/author/name/published), so this is
 * proportionate; malformed/unexpected XML just yields fewer or zero posts
 * (any entry missing an id or title is skipped) rather than throwing.
 */
export const arxiv: SourceAdapter = {
  name: "arxiv",
  label: "arXiv",
  tag: "AX",
  search,
};
