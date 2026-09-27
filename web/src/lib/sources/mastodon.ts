import {
  ADAPTER_DEFAULT_LIMIT,
  ADAPTER_TIMEOUT_MS,
  clampText,
  dedupeByUrl,
  errorResult,
  failedInstancesNote,
  instanceHosts,
  keywordTags,
  stripTags,
  type AdapterPost,
  type AdapterResult,
  type SourceAdapter,
} from "./adapter";
import type { Fetcher } from "./types";

/**
 * The instances queried when neither MASTODON_INSTANCES nor MASTODON_INSTANCE
 * is set. All four answered `/api/v1/timelines/tag/saas?limit=40` with a full
 * 40 statuses (verified live 2026-09-22): mastodon.social (the largest
 * general-purpose instance), fosstodon.org and hachyderm.io (both heavily
 * dev/tech), indieweb.social (indie makers — PostEcho's own audience).
 * techhub.social is deliberately ABSENT: its request failed on the same
 * check.
 */
const DEFAULT_INSTANCES = ["mastodon.social", "fosstodon.org", "hachyderm.io", "indieweb.social"];
const MAX_LIMIT = 40;
/**
 * Hashtags requested per instance. Two, not one: a hashtag timeline is an
 * exact-tag lookup, so a single tag makes the whole source hinge on the
 * query's first word. Not more than two — the request count is
 * instances × tags, and the scout already calls this once per query variant.
 */
const MAX_TAGS = 2;
const SOURCE_NAME = "mastodon";

type MastodonStatus = {
  id?: string;
  url?: string | null;
  uri?: string | null;
  content?: string;
  replies_count?: number;
  reblogs_count?: number;
  favourites_count?: number;
  created_at?: string | null;
  account?: { acct?: string };
};

/** One instance+tag request, degraded to a value rather than thrown so the others survive it (see `search`). */
type TimelineResult =
  | { ok: true; statuses: MastodonStatus[] }
  | { ok: false; host: string; cause?: unknown };

function toAdapterPost(item: MastodonStatus): AdapterPost | null {
  const url = item.url ?? item.uri;
  if (!item.id || !url) return null;
  const text = clampText(item.content ? stripTags(item.content) : "");
  return {
    id: item.id,
    url,
    text,
    title: null,
    author: item.account?.acct ?? null,
    metrics: { likes: item.favourites_count, reposts: item.reblogs_count, replies: item.replies_count },
    createdAt: item.created_at ?? null,
  };
}

async function fetchTimeline(
  host: string,
  tag: string,
  limit: number,
  fetcher: Fetcher,
): Promise<TimelineResult> {
  const url = `https://${host}/api/v1/timelines/tag/${encodeURIComponent(tag)}?limit=${limit}`;
  try {
    const res = await fetcher(url, { signal: AbortSignal.timeout(ADAPTER_TIMEOUT_MS) });
    if (!res.ok) return { ok: false, host };
    const data = JSON.parse(await res.text()) as unknown;
    return { ok: true, statuses: Array.isArray(data) ? (data as MastodonStatus[]) : [] };
  } catch (e) {
    return { ok: false, host, cause: e };
  }
}

async function search(
  query: string,
  opts: { fetcher: Fetcher; limit?: number; env?: NodeJS.ProcessEnv },
): Promise<AdapterResult> {
  const env = opts.env ?? process.env;
  const instances = instanceHosts({
    env,
    singular: "MASTODON_INSTANCE",
    plural: "MASTODON_INSTANCES",
    defaults: DEFAULT_INSTANCES,
  });
  const limit = opts.limit ?? ADAPTER_DEFAULT_LIMIT;
  const perRequestLimit = Math.min(limit, MAX_LIMIT);
  const tags = keywordTags(query, MAX_TAGS);
  // No alphanumerics anywhere in the query: nothing to ask any instance for.
  // "ok" rather than "error" — nothing failed, there was simply no request to
  // make.
  if (tags.length === 0) return { posts: [], status: "ok" };

  // Instance-major so the first default instance's leading tag is the first
  // request — the same single call this adapter used to make.
  const requests = instances.flatMap((host) => tags.map((tag) => ({ host, tag })));
  const settled = await Promise.allSettled(
    requests.map((r) => fetchTimeline(r.host, r.tag, perRequestLimit, opts.fetcher)),
  );

  const results: TimelineResult[] = settled.map((s, i) =>
    // fetchTimeline never rejects; this is defense-in-depth so one impossible
    // rejection still can't take the other instances' statuses down with it.
    s.status === "fulfilled" ? s.value : { ok: false, host: requests[i].host, cause: s.reason },
  );
  const failures = results.filter((r): r is Extract<TimelineResult, { ok: false }> => !r.ok);

  if (failures.length === results.length) {
    return errorResult(
      SOURCE_NAME,
      failedInstancesNote(failures.map((f) => f.host), instances.length),
      failures.find((f) => f.cause !== undefined)?.cause,
    );
  }

  const statuses = results.flatMap((r) => (r.ok ? r.statuses : []));
  const posts = dedupeByUrl(statuses.map(toAdapterPost).filter((p): p is AdapterPost => p !== null)).slice(0, limit);

  if (failures.length > 0) {
    // At least one instance answered: still "ok" (there ARE results), with
    // the dead instances named in `note` and exactly one warn — the same
    // single-warn discipline as errorResult.
    const note = failedInstancesNote(failures.map((f) => f.host), instances.length);
    console.warn(`${SOURCE_NAME}: ${note}`);
    return { posts, status: "ok", note };
  }
  return { posts, status: "ok" };
}

/**
 * Public Mastodon hashtag timelines (`/api/v1/timelines/tag/…`,
 * unauthenticated — this endpoint only ever returns public posts). No key,
 * but also no cross-instance full-text search, so this fans out instead: the
 * first TWO usable hashtags of the query (see `keywordTags`) against each of
 * several instances (`MASTODON_INSTANCES`, comma-separated, defaulting to
 * `DEFAULT_INSTANCES`), all in parallel, merged and deduped by url. A
 * hashtag timeline is federated — an instance returns the tagged posts it has
 * seen from the whole network, not just its own members — but WHICH posts it
 * has seen depends on who its members follow, so several instances genuinely
 * see different slices of the same tag. That is the entire reason for
 * querying more than one.
 *
 * `MASTODON_INSTANCE` (singular, the original var) still works and OVERRIDES
 * the list, pinning this back to exactly one host. Both are optional, so
 * `requiredEnv` stays unset: this adapter is never gated off.
 *
 * Request count is instances × tags (8 by default). `limit` caps the MERGED
 * result; each individual request asks for `min(limit, 40)`, 40 being the
 * endpoint's documented maximum. One instance failing is absorbed
 * (`status: "ok"`, dead hosts named in `note`); only when every request fails
 * is this `status: "error"`.
 */
export const mastodon: SourceAdapter = {
  name: "mastodon",
  label: "Mastodon",
  tag: "MST",
  search,
};
