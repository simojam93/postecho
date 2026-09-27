import {
  ADAPTER_DEFAULT_LIMIT,
  ADAPTER_TIMEOUT_MS,
  clampText,
  dedupeByUrl,
  disabledResult,
  envReady,
  errorResult,
  type AdapterPost,
  type AdapterResult,
  type SourceAdapter,
} from "./adapter";
import type { Fetcher } from "./types";

const GRAPHQL_URL = "https://api.producthunt.com/v2/api/graphql";
const SOURCE_NAME = "producthunt";
const REQUIRED_ENV = ["PRODUCTHUNT_TOKEN"];
// Product Hunt's v2 GraphQL API has no full-text search filter on `posts`
// (only `order`/`topic`/`postedBefore`/`postedAfter`) — see the adapter doc
// comment below — so this fetches a fixed pool of the top 50 most-voted
// recent posts and filters client-side instead.
const CANDIDATE_POOL_SIZE = 50;

const QUERY = `query {
  posts(order: VOTES, first: ${CANDIDATE_POOL_SIZE}) {
    edges {
      node {
        id
        name
        tagline
        description
        slug
        votesCount
        commentsCount
        createdAt
      }
    }
  }
}`;

type ProductHuntNode = {
  id?: string;
  name?: string;
  tagline?: string;
  description?: string;
  slug?: string;
  votesCount?: number;
  commentsCount?: number;
  createdAt?: string | null;
};

type ProductHuntResponse = {
  data?: { posts?: { edges?: Array<{ node?: ProductHuntNode }> } };
  errors?: Array<{ message?: string }>;
};

function tokenize(query: string): string[] {
  return query.trim().toLowerCase().split(/\s+/).filter(Boolean);
}

// A post matches when ANY query token appears in its name/tagline/
// description (OR, not AND) — taglines are short, so requiring every token
// to be present would make this adapter return almost nothing for
// multi-word queries.
function matches(node: ProductHuntNode, tokens: string[]): boolean {
  if (tokens.length === 0) return true;
  const haystack = `${node.name ?? ""} ${node.tagline ?? ""} ${node.description ?? ""}`.toLowerCase();
  return tokens.some((t) => haystack.includes(t));
}

function toAdapterPost(node: ProductHuntNode): AdapterPost | null {
  if (!node.id || !node.name || !node.slug) return null;
  const summary = node.tagline || node.description;
  const text = clampText(summary ? `${node.name} — ${summary}` : node.name);
  return {
    id: node.id,
    url: `https://www.producthunt.com/posts/${node.slug}`,
    text,
    title: node.name,
    // No maker/author field requested in the query — Product Hunt posts
    // don't have a single canonical "author" the way a repo or article does.
    author: null,
    metrics: { likes: node.votesCount, replies: node.commentsCount },
    createdAt: node.createdAt ?? null,
  };
}

async function search(
  query: string,
  opts: { fetcher: Fetcher; limit?: number; env?: NodeJS.ProcessEnv },
): Promise<AdapterResult> {
  const env = opts.env ?? process.env;
  if (!envReady({ requiredEnv: REQUIRED_ENV }, env)) return disabledResult({ requiredEnv: REQUIRED_ENV });

  const limit = opts.limit ?? ADAPTER_DEFAULT_LIMIT;

  try {
    const res = await opts.fetcher(GRAPHQL_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.PRODUCTHUNT_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query: QUERY }),
      signal: AbortSignal.timeout(ADAPTER_TIMEOUT_MS),
    });
    if (!res.ok) return errorResult(SOURCE_NAME, `request failed with status ${res.status}`);

    const data = JSON.parse(await res.text()) as ProductHuntResponse;
    if (data.errors && data.errors.length > 0) {
      return errorResult(SOURCE_NAME, `GraphQL error: ${data.errors[0]?.message ?? "unknown"}`);
    }

    const tokens = tokenize(query);
    const nodes = (data.data?.posts?.edges ?? [])
      .map((edge) => edge.node)
      .filter((n): n is ProductHuntNode => n !== undefined)
      .filter((n) => matches(n, tokens));

    const posts = dedupeByUrl(
      nodes.map(toAdapterPost).filter((p): p is AdapterPost => p !== null),
    ).slice(0, limit);

    return { posts, status: "ok" };
  } catch (e) {
    return errorResult(SOURCE_NAME, "request failed", e);
  }
}

/**
 * Product Hunt's v2 GraphQL API (`api.producthunt.com/v2/api/graphql`).
 * Requires a developer token (`PRODUCTHUNT_TOKEN` — create an app at
 * producthunt.com/v2/oauth/applications and use its own access token, no
 * user OAuth flow needed for read-only queries); without it this adapter
 * is disabled and makes no request.
 *
 * LIMITATION: `posts` isn't filterable by a search string in PH's schema
 * (only `order`/`topic`/date-range) — there is no full-text search. This
 * fetches a fixed pool of the 50 (`CANDIDATE_POOL_SIZE`) most-voted recent
 * posts (`order: VOTES`) and filters client-side by the query's tokens
 * over name+tagline+description, so results reflect "currently popular
 * posts that mention the query," not a relevance-ranked search of PH's
 * full catalog.
 */
export const producthunt: SourceAdapter = {
  name: "producthunt",
  label: "Product Hunt",
  tag: "PH",
  requiredEnv: REQUIRED_ENV,
  search,
};
