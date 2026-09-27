import { decodeEntities, stripTags } from "@/lib/enrich";
import type { Fetcher, SourcePost } from "@/lib/sources/types";

/**
 * Both Algolia endpoints, queried together with identical params.
 * `/search` ranks by RELEVANCE (its own popularity-weighted blend) and
 * `/search_by_date` by RECENCY — same corpus, different orderings, so a
 * story that ranks below the cut on one can still come back from the other.
 * `/search` stays first: it is the original single endpoint, and the more
 * useful of the two on its own.
 */
const SEARCH_URLS = [
  "https://hn.algolia.com/api/v1/search",
  "https://hn.algolia.com/api/v1/search_by_date",
] as const;
const TIMEOUT_MS = 8000;
const DEFAULT_LIMIT = 25;
const STORY_TEXT_MAX_CHARS = 300;

const defaultFetcher: Fetcher = (url, init) => fetch(url, init);

type AlgoliaHit = {
  objectID: string;
  title?: string;
  url?: string;
  story_text?: string | null;
  points?: number;
  num_comments?: number;
  author?: string;
  created_at?: string | null;
};

type AlgoliaSearchResponse = { hits?: AlgoliaHit[] };

/** One endpoint's outcome, degraded to a value rather than thrown so the other endpoint survives it (see `searchHackerNews`). */
type EndpointResult = { ok: true; hits: AlgoliaHit[] } | { ok: false; note: string; cause?: unknown };

// Tags are stripped BEFORE truncating to 300 chars, not after — truncating
// raw HTML first could cut a tag in half and leave a stray "<di" fragment in
// the text. `stripTags` (lib/enrich.ts) also decodes entities (including
// generic numeric/hex — HN's Algolia API commonly returns story_text with
// e.g. "&#x2F;" for "/") and trims, in that order.
function summarizeStoryText(storyText: string): string {
  return stripTags(storyText).slice(0, STORY_TEXT_MAX_CHARS);
}

function toSourcePost(hit: AlgoliaHit): SourcePost | null {
  if (!hit.objectID || !hit.title) return null;
  // The title is plain text (no HTML tags), just possibly entity-escaped
  // (e.g. "I&#x27;m" for "I'm") — decodeEntities alone, no stripTags needed.
  const title = decodeEntities(hit.title);
  const text = hit.story_text ? `${title} — ${summarizeStoryText(hit.story_text)}` : title;
  return {
    id: hit.objectID,
    source: "hackernews",
    url: `https://news.ycombinator.com/item?id=${hit.objectID}`,
    text,
    author: hit.author ?? null,
    metrics: { likes: hit.points, replies: hit.num_comments },
    createdAt: hit.created_at ?? null,
  };
}

/**
 * One endpoint's fetch+parse. Never throws and never warns on its own — the
 * caller decides whether a failure here matters, so that two dead endpoints
 * still produce exactly ONE warning between them.
 */
async function fetchEndpoint(
  endpoint: string,
  query: string,
  limit: number,
  fetcher: Fetcher,
): Promise<EndpointResult> {
  const url = `${endpoint}?query=${encodeURIComponent(query)}&tags=story&hitsPerPage=${limit}`;
  try {
    const res = await fetcher(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) return { ok: false, note: `${endpoint} failed with status ${res.status}` };
    const data = JSON.parse(await res.text()) as AlgoliaSearchResponse;
    return { ok: true, hits: data.hits ?? [] };
  } catch (e) {
    return { ok: false, note: `${endpoint} request failed`, cause: e };
  }
}

/**
 * Hacker News (via the Algolia search API) — the second free, open source
 * the M1.5 scout queries server-side (see
 * docs/specs/2026-09-19-postecho-design.md §11 item 2). Queries
 * BOTH of `SEARCH_URLS` (relevance and recency) in parallel with the same
 * params, then merges and dedupes by `objectID` — which is also the identity
 * of the result, since the url is derived from it. `limit` is both the
 * per-request `hitsPerPage` and the cap on the merged list.
 *
 * Links back to the HN discussion page (not the story's external url) so
 * "open ↗" always lands somewhere with context. One endpoint failing never
 * costs the other its hits (the survivor's are returned, with one warning);
 * any failure of BOTH degrades to an empty array rather than throwing — see
 * bluesky.ts's searchBluesky for the same contract.
 */
export async function searchHackerNews(
  query: string,
  opts: { fetcher?: Fetcher; limit?: number } = {},
): Promise<SourcePost[]> {
  const fetcher = opts.fetcher ?? defaultFetcher;
  const limit = opts.limit ?? DEFAULT_LIMIT;

  const settled = await Promise.allSettled(
    SEARCH_URLS.map((endpoint) => fetchEndpoint(endpoint, query, limit, fetcher)),
  );
  const results: EndpointResult[] = settled.map((s, i) =>
    // fetchEndpoint never rejects; defense-in-depth so one impossible
    // rejection can't cost the other endpoint its hits.
    s.status === "fulfilled" ? s.value : { ok: false, note: `${SEARCH_URLS[i]} request failed`, cause: s.reason },
  );

  const failures = results.filter((r): r is Extract<EndpointResult, { ok: false }> => !r.ok);
  if (failures.length > 0) {
    // Exactly one warn whether one endpoint failed or both — the same
    // single-warn discipline the rest of lib/sources keeps.
    const note = failures.map((f) => f.note).join("; ");
    const cause = failures.find((f) => f.cause !== undefined)?.cause;
    if (cause !== undefined) console.warn(`searchHackerNews: ${note}`, cause);
    else console.warn(`searchHackerNews: ${note}`);
    if (failures.length === results.length) return [];
  }

  const seen = new Set<string>();
  const posts: SourcePost[] = [];
  for (const hit of results.flatMap((r) => (r.ok ? r.hits : []))) {
    if (!hit.objectID || seen.has(hit.objectID)) continue;
    seen.add(hit.objectID);
    const post = toSourcePost(hit);
    if (post) posts.push(post);
  }
  return posts.slice(0, limit);
}
