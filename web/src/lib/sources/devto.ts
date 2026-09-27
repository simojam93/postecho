import {
  ADAPTER_DEFAULT_LIMIT,
  ADAPTER_TIMEOUT_MS,
  clampText,
  dedupeByUrl,
  errorResult,
  firstKeywordTag,
  type AdapterPost,
  type AdapterResult,
  type SourceAdapter,
} from "./adapter";
import type { Fetcher } from "./types";

const BASE_URL = "https://dev.to/api/articles";
const SOURCE_NAME = "devto";

type DevToArticle = {
  id?: number;
  title?: string;
  description?: string | null;
  url?: string;
  positive_reactions_count?: number;
  comments_count?: number;
  published_at?: string | null;
  user?: { username?: string };
};

function toAdapterPost(item: DevToArticle): AdapterPost | null {
  if (!item.title || !item.url) return null;
  const text = clampText(item.description ? `${item.title} — ${item.description}` : item.title);
  return {
    id: String(item.id ?? item.url),
    url: item.url,
    text,
    title: item.title,
    author: item.user?.username ?? null,
    metrics: { likes: item.positive_reactions_count, replies: item.comments_count },
    createdAt: item.published_at ?? null,
  };
}

async function search(
  query: string,
  opts: { fetcher: Fetcher; limit?: number },
): Promise<AdapterResult> {
  const limit = opts.limit ?? ADAPTER_DEFAULT_LIMIT;
  const tag = firstKeywordTag(query);
  const url = `${BASE_URL}?tag=${encodeURIComponent(tag)}&top=30&per_page=${limit}`;

  try {
    const res = await opts.fetcher(url, { signal: AbortSignal.timeout(ADAPTER_TIMEOUT_MS) });
    if (!res.ok) return errorResult(SOURCE_NAME, `request failed with status ${res.status}`);

    const data = JSON.parse(await res.text()) as unknown;
    const items = Array.isArray(data) ? (data as DevToArticle[]) : [];
    const posts = dedupeByUrl(items.map(toAdapterPost).filter((p): p is AdapterPost => p !== null));
    return { posts, status: "ok" };
  } catch (e) {
    return errorResult(SOURCE_NAME, "request failed", e);
  }
}

/**
 * dev.to / Forem articles API (`dev.to/api/articles`, no key). Tag-based,
 * not full-text: the public API has no full-text search, so this filters
 * by the query's first token (lowercased, alnum-only) as a tag, sorted by
 * `top=30` (most-reacted in the last 30 days) — see `firstKeywordTag`.
 */
export const devto: SourceAdapter = {
  name: "devto",
  label: "dev.to",
  tag: "DEV",
  search,
};
