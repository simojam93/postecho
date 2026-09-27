import {
  ADAPTER_DEFAULT_LIMIT,
  ADAPTER_TIMEOUT_MS,
  clampText,
  dedupeByUrl,
  errorResult,
  type AdapterPost,
  type AdapterResult,
  type SourceAdapter,
} from "./adapter";
import type { Fetcher } from "./types";

const BASE_URL = "https://api.github.com/search/repositories";
const SOURCE_NAME = "github";

type GithubRepoItem = {
  id?: number;
  full_name?: string;
  html_url?: string;
  description?: string | null;
  stargazers_count?: number;
  forks_count?: number;
  owner?: { login?: string };
  pushed_at?: string | null;
};

type GithubSearchResponse = { items?: GithubRepoItem[] };

function toAdapterPost(item: GithubRepoItem): AdapterPost | null {
  if (!item.full_name || !item.html_url) return null;
  const text = clampText(item.description ? `${item.full_name} — ${item.description}` : item.full_name);
  return {
    id: String(item.id ?? item.full_name),
    url: item.html_url,
    text,
    title: item.full_name,
    author: item.owner?.login ?? null,
    metrics: { likes: item.stargazers_count, reposts: item.forks_count },
    createdAt: item.pushed_at ?? null,
  };
}

async function search(
  query: string,
  opts: { fetcher: Fetcher; limit?: number; env?: NodeJS.ProcessEnv },
): Promise<AdapterResult> {
  const limit = opts.limit ?? ADAPTER_DEFAULT_LIMIT;
  const env = opts.env ?? process.env;
  const url = `${BASE_URL}?q=${encodeURIComponent(query)}&sort=stars&order=desc&per_page=${limit}`;

  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": "PostEcho",
  };
  // GITHUB_TOKEN is optional — unauthenticated search works fine at our
  // volume (60 req/h), a token just raises the rate limit if one is set.
  const token = env.GITHUB_TOKEN;
  if (token) headers.Authorization = `Bearer ${token}`;

  try {
    const res = await opts.fetcher(url, { headers, signal: AbortSignal.timeout(ADAPTER_TIMEOUT_MS) });
    if (!res.ok) return errorResult(SOURCE_NAME, `request failed with status ${res.status}`);

    const data = JSON.parse(await res.text()) as GithubSearchResponse;
    const posts = dedupeByUrl(
      (data.items ?? []).map(toAdapterPost).filter((p): p is AdapterPost => p !== null),
    );
    return { posts, status: "ok" };
  } catch (e) {
    return errorResult(SOURCE_NAME, "request failed", e);
  }
}

/**
 * GitHub repository search (`api.github.com/search/repositories`, sorted by
 * stars). No key required — unauthenticated requests get 60/hour, plenty at
 * our volume — but an optional `GITHUB_TOKEN` env var adds a Bearer header
 * (raising the rate limit) when present. `requiredEnv` is deliberately left
 * unset so `envReady`/`disabledResult` never gate this adapter off.
 */
export const github: SourceAdapter = {
  name: "github",
  label: "GitHub",
  tag: "GH",
  search,
};
