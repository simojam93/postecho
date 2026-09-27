import { ADAPTER_TIMEOUT_MS, clampText, disabledResult, envReady, errorResult, type AdapterPost, type AdapterResult, type SourceAdapter } from "./adapter";
import type { Fetcher, SourcePost } from "./types";

/**
 * X as a Find Ideas source (owner, 2026-09-24: "metti in settings la
 * possibilità di aggiungere X o no, come api key"). Off until the owner
 * pastes their own X API bearer token in Settings (lib/x-config.ts puts it
 * in the scout's env as X_BEARER_TOKEN); read only through the official API
 * v2 — recent search, the last 7 days — never the website.
 *
 * X bills the owner's developer account per use (docs.x.com pricing, checked
 * 2026-09-24): $0.005 per post read and $0.01 per user read, deduplicated
 * within a UTC day. So a search reads at most `postsPerSearch` posts (default
 * 20, about $0.10), in round 1 only, and authors are looked up after the pick,
 * only for the X posts that made the results (finalizePicked) — asking for
 * every author with the search would cost more than the posts themselves.
 */
export const X_SOURCE_NAME = "x_post";
export const X_REQUIRED_ENV = ["X_BEARER_TOKEN"];
export const X_POSTS_PER_SEARCH = { min: 10, max: 100, default: 20 } as const;
/** X API pay-per-use prices, USD. */
export const X_PRICES_USD = { postRead: 0.005, userRead: 0.01 } as const;

const API = "https://api.x.com/2";
const MAX_QUERY_WORDS = 8;

/** Settings' posts-per-search (X_POSTS_PER_SEARCH in the scout env), clamped to what the API accepts. */
export function xPostsPerSearch(env: NodeJS.ProcessEnv): number {
  const n = Number(env.X_POSTS_PER_SEARCH);
  if (!Number.isInteger(n)) return X_POSTS_PER_SEARCH.default;
  return Math.min(X_POSTS_PER_SEARCH.max, Math.max(X_POSTS_PER_SEARCH.min, n));
}

/**
 * The query X is sent: the search's words only — lowercased, punctuation and
 * leading minus signs dropped, so nothing typed can turn into one of X's
 * operators (OR, -word, from:) — for original posts (no reposts, no replies)
 * in English, the language the posts are written in. Null when no word is left.
 */
export function xSearchQuery(query: string): string | null {
  const words = query
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s'_-]/gu, " ")
    .split(/\s+/)
    .map((word) => word.replace(/^[-']+|[-']+$/g, ""))
    .filter(Boolean)
    .slice(0, MAX_QUERY_WORDS);
  if (words.length === 0) return null;
  return `${words.join(" ")} -is:retweet -is:reply lang:en`;
}

type XTweet = {
  id?: string;
  text?: string;
  author_id?: string;
  created_at?: string;
  note_tweet?: { text?: string };
  public_metrics?: { like_count?: number; retweet_count?: number; reply_count?: number; quote_count?: number };
};

function authHeaders(env: NodeJS.ProcessEnv): Record<string, string> {
  return { Authorization: `Bearer ${env.X_BEARER_TOKEN?.trim() ?? ""}` };
}

/** What a failed X call means for the owner — shown under the search (search-box.tsx). */
export function xStatusNote(status: number): string {
  if (status === 401) return "X rejected the key (401): check the bearer token in Settings";
  if (status === 402) return "X asked for payment (402): check the credits in the X developer console";
  if (status === 403) return "X refused the request (403): check the app's access in the X developer console";
  if (status === 429) return "X said too many requests (429): a rate limit or your spending limit";
  return `X answered ${status}`;
}

function toPost(tweet: XTweet): AdapterPost[] {
  if (typeof tweet.id !== "string" || !/^\d+$/.test(tweet.id)) return [];
  // A long post's full text is in note_tweet; `text` is its first 280 characters.
  const text = (tweet.note_tweet?.text || tweet.text || "").trim();
  if (!text) return [];
  const m = tweet.public_metrics ?? {};
  return [{
    id: tweet.id,
    // Until finalizePicked knows the author: x.com's own author-less permalink.
    url: `https://x.com/i/status/${tweet.id}`,
    text: clampText(text),
    title: null,
    author: null,
    authorId: typeof tweet.author_id === "string" ? tweet.author_id : null,
    metrics: {
      likes: m.like_count,
      reposts: m.retweet_count === undefined && m.quote_count === undefined ? undefined : (m.retweet_count ?? 0) + (m.quote_count ?? 0),
      replies: m.reply_count,
    },
    createdAt: typeof tweet.created_at === "string" ? tweet.created_at : null,
  }];
}

async function search(query: string, opts: { fetcher: Fetcher; limit?: number; env?: NodeJS.ProcessEnv }): Promise<AdapterResult> {
  const env = opts.env ?? process.env;
  if (!envReady({ requiredEnv: X_REQUIRED_ENV }, env)) return disabledResult({ requiredEnv: X_REQUIRED_ENV });
  const q = xSearchQuery(query);
  if (!q) return { posts: [], status: "ok" };
  const maxResults = Math.min(X_POSTS_PER_SEARCH.max, Math.max(X_POSTS_PER_SEARCH.min, opts.limit ?? xPostsPerSearch(env)));
  const url = `${API}/tweets/search/recent?${new URLSearchParams({
    query: q,
    max_results: String(maxResults),
    sort_order: "relevancy",
    "tweet.fields": "created_at,public_metrics,author_id,note_tweet",
  })}`;
  try {
    const res = await opts.fetcher(url, { headers: authHeaders(env), signal: AbortSignal.timeout(ADAPTER_TIMEOUT_MS) });
    if (!res.ok) return errorResult("x", xStatusNote(res.status));
    const body = JSON.parse(await res.text()) as { data?: XTweet[] };
    return { posts: (body.data ?? []).slice(0, maxResults).flatMap(toPost), status: "ok" };
  } catch (e) {
    return errorResult("x", "request failed", e);
  }
}

/** The picked X posts' authors, in one users lookup: `@handle` as the author, and the post's canonical url. */
async function finalizePicked(posts: SourcePost[], opts: { fetcher: Fetcher; env: NodeJS.ProcessEnv }): Promise<SourcePost[]> {
  if (!envReady({ requiredEnv: X_REQUIRED_ENV }, opts.env)) return posts;
  const ids = [...new Set(posts.map((p) => p.authorId).filter((id): id is string => typeof id === "string" && /^\d+$/.test(id)))].slice(0, 100);
  if (ids.length === 0) return posts;
  try {
    const url = `${API}/users?${new URLSearchParams({ ids: ids.join(","), "user.fields": "username,name" })}`;
    const res = await opts.fetcher(url, { headers: authHeaders(opts.env), signal: AbortSignal.timeout(ADAPTER_TIMEOUT_MS) });
    if (!res.ok) {
      console.warn(`x: author lookup — ${xStatusNote(res.status)}`);
      return posts;
    }
    const body = JSON.parse(await res.text()) as { data?: Array<{ id?: string; username?: string }> };
    const handles = new Map<string, string>();
    for (const user of body.data ?? []) {
      if (typeof user.id === "string" && typeof user.username === "string" && /^[A-Za-z0-9_]{1,15}$/.test(user.username)) {
        handles.set(user.id, user.username);
      }
    }
    return posts.map((post) => {
      const handle = post.authorId ? handles.get(post.authorId) : undefined;
      if (!handle) return post;
      const rawId = post.id.startsWith(`${X_SOURCE_NAME}:`) ? post.id.slice(X_SOURCE_NAME.length + 1) : post.id;
      return { ...post, author: `@${handle}`, url: `https://x.com/${handle}/status/${rawId}` };
    });
  } catch (e) {
    console.warn("x: author lookup failed", e);
    return posts;
  }
}

export const x: SourceAdapter = {
  name: X_SOURCE_NAME,
  label: "X",
  tag: "X",
  requiredEnv: X_REQUIRED_ENV,
  search,
  postsPerSearch: xPostsPerSearch,
  minPerRequest: X_POSTS_PER_SEARCH.min,
  finalizePicked,
};
