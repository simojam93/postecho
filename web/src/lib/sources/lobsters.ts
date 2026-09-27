import {
  ADAPTER_DEFAULT_LIMIT,
  ADAPTER_TIMEOUT_MS,
  ADAPTER_USER_AGENT,
  clampText,
  dedupeByUrl,
  errorResult,
  stripTags,
  type AdapterPost,
  type AdapterResult,
  type SourceAdapter,
} from "./adapter";
import type { Fetcher } from "./types";

const BASE_URL = "https://lobste.rs";
/** The two public JSON feeds this adapter pools and filters — see the `lobsters` doc comment for why not a search endpoint. */
const FEEDS = ["hottest", "newest"] as const;
const SOURCE_NAME = "lobsters";
/** Same cap hackernews.ts applies to story_text: the description is a supplement to the title, not the whole post. */
const DESCRIPTION_MAX_CHARS = 300;

type LobstersFeed = (typeof FEEDS)[number];

type LobstersStory = {
  short_id?: string;
  title?: string;
  url?: string | null;
  comments_url?: string | null;
  short_id_url?: string | null;
  description?: string | null;
  description_plain?: string | null;
  score?: number;
  comment_count?: number;
  // A plain username string on lobste.rs today (verified live 2026-09-22);
  // older Lobsters releases (and some self-hosted sister sites) return the
  // whole user object instead, so both shapes are accepted.
  submitter_user?: string | { username?: string } | null;
  tags?: string[];
  created_at?: string | null;
};

type FeedResult =
  | { ok: true; stories: LobstersStory[] }
  | { ok: false; note: string; cause?: unknown };

function submitterName(story: LobstersStory): string | null {
  const user = story.submitter_user;
  if (typeof user === "string") return user || null;
  return user?.username ?? null;
}

/** The story's own text, plain: `description_plain` when the feed provides it, else `description` (HTML) stripped and entity-decoded. */
function plainDescription(story: LobstersStory): string {
  const plain = story.description_plain?.trim();
  if (plain) return plain;
  return story.description ? stripTags(story.description) : "";
}

function toAdapterPost(story: LobstersStory): AdapterPost | null {
  if (!story.short_id || !story.title) return null;
  // Text-only submissions ("Ask Lobsters"-style) have an empty `url` — link
  // to the discussion page instead, so "open ↗" always lands somewhere.
  const url = story.url?.trim() || story.comments_url || story.short_id_url;
  if (!url) return null;
  const description = clampText(plainDescription(story), DESCRIPTION_MAX_CHARS);
  return {
    id: story.short_id,
    url,
    text: clampText(description ? `${story.title} — ${description}` : story.title),
    title: story.title,
    author: submitterName(story),
    metrics: { likes: story.score, replies: story.comment_count },
    createdAt: story.created_at ?? null,
  };
}

/**
 * The query's whitespace-separated terms, lowercased and deduped, minus any
 * token without a single letter or digit in it ("&", "-", "→" — those would
 * otherwise match nearly every story). No stopword handling: the scout
 * already hands adapters keyword-shaped queries (see lib/query.ts).
 */
function queryTerms(query: string): string[] {
  const tokens = query.toLowerCase().split(/\s+/).filter((token) => /[a-z0-9]/.test(token));
  return Array.from(new Set(tokens));
}

/** True when ANY term is a case-insensitive substring of the story's title, description or tags. */
function matchesQuery(story: LobstersStory, terms: string[]): boolean {
  const tags = Array.isArray(story.tags) ? story.tags : [];
  const haystack = [story.title ?? "", plainDescription(story), ...tags].join(" ").toLowerCase();
  return terms.some((term) => haystack.includes(term));
}

/** One feed's fetch+parse, degraded to a `FeedResult` rather than thrown so the two feeds can fail independently (see `search`). */
async function fetchFeed(feed: LobstersFeed, fetcher: Fetcher): Promise<FeedResult> {
  try {
    const res = await fetcher(`${BASE_URL}/${feed}.json`, {
      headers: { "User-Agent": ADAPTER_USER_AGENT },
      signal: AbortSignal.timeout(ADAPTER_TIMEOUT_MS),
    });
    if (!res.ok) return { ok: false, note: `${feed}.json failed with status ${res.status}` };
    const data = JSON.parse(await res.text()) as unknown;
    return { ok: true, stories: Array.isArray(data) ? (data as LobstersStory[]) : [] };
  } catch (e) {
    return { ok: false, note: `${feed}.json request failed`, cause: e };
  }
}

async function search(
  query: string,
  opts: { fetcher: Fetcher; limit?: number },
): Promise<AdapterResult> {
  const limit = opts.limit ?? ADAPTER_DEFAULT_LIMIT;
  const terms = queryTerms(query);

  try {
    const results = await Promise.all(FEEDS.map((feed) => fetchFeed(feed, opts.fetcher)));
    const failures = results.filter((r): r is Extract<FeedResult, { ok: false }> => !r.ok);
    const note = failures.map((f) => f.note).join("; ");
    if (failures.length === results.length) {
      return errorResult(SOURCE_NAME, note, failures.find((f) => f.cause !== undefined)?.cause);
    }

    const stories = results.flatMap((r) => (r.ok ? r.stories : []));
    const matched = terms.length === 0 ? [] : stories.filter((story) => matchesQuery(story, terms));
    const posts = dedupeByUrl(matched.map(toAdapterPost).filter((p): p is AdapterPost => p !== null)).slice(0, limit);

    if (failures.length > 0) {
      // One feed answered, the other didn't: still "ok" (there IS a pool to
      // filter), with the failure surfaced in `note` and exactly one warn —
      // the same single-warn discipline as errorResult.
      console.warn(`${SOURCE_NAME}: ${note}`);
      return { posts, status: "ok", note };
    }
    return { posts, status: "ok" };
  } catch (e) {
    return errorResult(SOURCE_NAME, "request failed", e);
  }
}

/**
 * Lobsters (lobste.rs), no key — but NO keyword search either: the site's
 * search exists only as an HTML page (`/search?q=…&what=stories&order=…`);
 * every JSON form of it (`/search.json?q=…`, `…&format=json`, with or
 * without `what`/`order`/`page`) answers 400 `{"error":"400 Unpermitted
 * query or form parameter"}` (verified live 2026-09-22 — the `.json`
 * suffix itself becomes an unpermitted `format` param). Rather than scrape
 * that HTML, this pools the two public JSON feeds — `hottest.json` (the
 * front page, 25 stories) and `newest.json` (the 25 latest submissions) —
 * and filters them client-side: a story matches when ANY whitespace-
 * separated query term is a case-insensitive substring of its title,
 * description or tags. LIMITATION: the result is "what's on Lobsters' front
 * page / just submitted about X right now", not a relevance search of the
 * archive — the pool is at most 50 stories per call, so a niche query can
 * legitimately return zero posts. That recency bias is deliberate and in
 * line with the other adapters (Reddit `t=month`, Lemmy `TopMonth`, dev.to
 * `top=30`). Two requests per search, in parallel; if exactly one feed
 * fails, the other's matches are still returned (`status: "ok"`, with the
 * failure in `note`) — only when both fail is this `status: "error"`.
 * Links to the story's own `url`, falling back to its discussion page
 * (`comments_url`) for text-only submissions. `score`/`comment_count` map
 * to `metrics.likes`/`replies` — the shape `AdapterPost.metrics` has, same
 * convention as hackernews.ts's points/num_comments.
 */
export const lobsters: SourceAdapter = {
  name: "lobsters",
  label: "Lobsters",
  tag: "LOB",
  search,
};
