import {
  ADAPTER_DEFAULT_LIMIT,
  ADAPTER_TIMEOUT_MS,
  ADAPTER_USER_AGENT,
  clampText,
  dedupeByUrl,
  errorResult,
  failedInstancesNote,
  instanceHosts,
  type AdapterPost,
  type AdapterResult,
  type SourceAdapter,
} from "./adapter";
import type { Fetcher } from "./types";

/**
 * The instances queried when neither LEMMY_INSTANCES nor LEMMY_INSTANCE is
 * set — the four largest general/technical servers that answered
 * `/api/v3/search` cleanly on 2026-09-22. lemm.ee is deliberately ABSENT:
 * its request failed outright on that check.
 *
 * programming.dev IS included even though it returned 0 posts for the
 * "indie saas" probe: re-checked with `q=rust` and `q=javascript` it returns
 * a full 50 on BOTH sorts, so those zeros were a real no-match on a healthy
 * server, not a broken host — and a dev-focused instance federates exactly
 * the communities this product cares about.
 */
const DEFAULT_INSTANCES = ["lemmy.world", "lemmy.ml", "sh.itjust.works", "programming.dev"];
/**
 * Both sorts, per instance. `TopAll` FIRST because it is the one that
 * actually answers: on 2026-09-22 `TopMonth` returned 0 posts for
 * "indie saas" on every instance tried while `TopAll` returned 2-3 — sorting
 * a niche query by "top this month" filters away nearly everything. TopMonth
 * is kept as the second pass purely for recency on queries broad enough to
 * have a busy month.
 */
const SORTS = ["TopAll", "TopMonth"] as const;
/** Lemmy's hard cap: `limit=51` answers 400 `{"error":"unknown","message":"Fetch limit is > 50"}` (verified live 2026-09-22). */
const MAX_LIMIT = 50;
const SOURCE_NAME = "lemmy";
/** Post bodies are markdown essays at times — cap them like reddit.ts caps selftext, so the title stays the lead. */
const BODY_MAX_CHARS = 500;

type LemmySort = (typeof SORTS)[number];

type LemmyPost = {
  id?: number;
  name?: string;
  body?: string | null;
  url?: string | null;
  ap_id?: string;
  published?: string | null;
  nsfw?: boolean;
  removed?: boolean;
  deleted?: boolean;
};

type LemmyPostView = {
  post?: LemmyPost;
  creator?: { name?: string };
  counts?: { score?: number; comments?: number; upvotes?: number };
};

type LemmySearchResponse = { posts?: LemmyPostView[] };

/** One instance+sort request, degraded to a value rather than thrown so the others survive it (see `search`). */
type SearchRequestResult =
  | { ok: true; views: LemmyPostView[] }
  | { ok: false; host: string; cause?: unknown };

function toAdapterPost(view: LemmyPostView): AdapterPost | null {
  const post = view.post;
  if (!post || typeof post.id !== "number" || !post.name) return null;
  // Not what a content-ideas feed should surface: NSFW-flagged posts, and
  // posts their mods removed or authors deleted (search normally omits the
  // latter two already — this is belt-and-braces).
  if (post.nsfw || post.removed || post.deleted) return null;
  // Link posts carry the linked page as `url`; text posts have none, so link
  // to the post itself — its ActivityPub id IS its canonical page on the
  // instance it was posted to.
  const url = post.url?.trim() || post.ap_id;
  if (!url) return null;
  const body = post.body ? clampText(post.body, BODY_MAX_CHARS) : "";
  return {
    id: String(post.id),
    url,
    text: clampText(body ? `${post.name} — ${body}` : post.name),
    title: post.name,
    author: view.creator?.name ?? null,
    metrics: { likes: view.counts?.score, replies: view.counts?.comments },
    createdAt: post.published ?? null,
  };
}

async function fetchSearch(
  host: string,
  sort: LemmySort,
  query: string,
  limit: number,
  fetcher: Fetcher,
): Promise<SearchRequestResult> {
  const url =
    `https://${host}/api/v3/search?q=${encodeURIComponent(query)}` +
    `&type_=Posts&sort=${sort}&listing_type=All&limit=${limit}`;
  try {
    const res = await fetcher(url, {
      headers: { "User-Agent": ADAPTER_USER_AGENT },
      signal: AbortSignal.timeout(ADAPTER_TIMEOUT_MS),
    });
    if (!res.ok) return { ok: false, host };
    const data = JSON.parse(await res.text()) as LemmySearchResponse | null;
    return { ok: true, views: Array.isArray(data?.posts) ? data.posts : [] };
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
    singular: "LEMMY_INSTANCE",
    plural: "LEMMY_INSTANCES",
    defaults: DEFAULT_INSTANCES,
  });
  const limit = opts.limit ?? ADAPTER_DEFAULT_LIMIT;
  const perRequestLimit = Math.min(limit, MAX_LIMIT);

  // Instance-major, TopAll before TopMonth, so the first default instance's
  // TopAll is the first request.
  const requests = instances.flatMap((host) => SORTS.map((sort) => ({ host, sort })));
  const settled = await Promise.allSettled(
    requests.map((r) => fetchSearch(r.host, r.sort, query, perRequestLimit, opts.fetcher)),
  );

  const results: SearchRequestResult[] = settled.map((s, i) =>
    // fetchSearch never rejects; this is defense-in-depth so one impossible
    // rejection still can't take the other instances' posts down with it.
    s.status === "fulfilled" ? s.value : { ok: false, host: requests[i].host, cause: s.reason },
  );
  const failures = results.filter((r): r is Extract<SearchRequestResult, { ok: false }> => !r.ok);

  if (failures.length === results.length) {
    return errorResult(
      SOURCE_NAME,
      failedInstancesNote(failures.map((f) => f.host), instances.length),
      failures.find((f) => f.cause !== undefined)?.cause,
    );
  }

  const views = results.flatMap((r) => (r.ok ? r.views : []));
  const posts = dedupeByUrl(views.map(toAdapterPost).filter((p): p is AdapterPost => p !== null)).slice(0, limit);

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
 * Lemmy's public search API (`/api/v3/search?type_=Posts&listing_type=All`,
 * no key — the response is `{ posts: [{ post, creator, counts, … }] }`).
 * Full-text over post titles and bodies across every community the instance
 * federates with. Because a Lemmy instance only searches what IT has
 * federated, this fans out: every instance in `LEMMY_INSTANCES`
 * (comma-separated, defaulting to `DEFAULT_INSTANCES`) is queried on BOTH
 * `SORTS`, all in parallel, merged and deduped by url.
 *
 * `LEMMY_INSTANCE` (singular, the original var) still works and OVERRIDES the
 * list, pinning this back to exactly one host. Both are optional, so
 * `requiredEnv` stays unset: this adapter is never gated off.
 *
 * Request count is instances × sorts (8 by default). `limit` caps the MERGED
 * result; each individual request asks for `min(limit, 50)`, 50 being the
 * API's maximum. Sends a descriptive User-Agent, as Lemmy asks API clients
 * to. One instance failing is absorbed (`status: "ok"`, dead hosts named in
 * `note`); only when every request fails is this `status: "error"`.
 * `counts.score`/`counts.comments` map to `metrics.likes`/`replies` — the
 * shape `AdapterPost.metrics` has, same convention as hackernews.ts/reddit.ts.
 */
export const lemmy: SourceAdapter = {
  name: "lemmy",
  label: "Lemmy",
  tag: "LEM",
  search,
};
