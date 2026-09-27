import { disabledResult, envReady, errorResult, type AdapterPost, type AdapterResult, type SourceAdapter } from "./adapter";
import { searchBluesky } from "./bluesky";
import { searchHackerNews } from "./hackernews";
import type { Fetcher, SourcePost } from "./types";

const BLUESKY_REQUIRED_ENV = ["BLUESKY_IDENTIFIER", "BLUESKY_APP_PASSWORD"];

/**
 * The original two free, open sources (M1.5) — `searchHackerNews`/
 * `searchBluesky` (hackernews.ts/bluesky.ts) predate the `SourceAdapter`
 * shape (registry.ts/adapter.ts) other sources conform to, and keep their
 * own `SourcePost`-returning signatures (and their own tests) unchanged;
 * these wrappers are the ONLY thing that adapts them to `SourceAdapter` so
 * `sources/all.ts` can list all nine sources uniformly.
 *
 * `SourcePost` (id/url/text/author/metrics/createdAt, no `title`) maps onto
 * `AdapterPost` losslessly except for `title`, which neither source has of
 * its own (title is folded into `text` by both) — set to `null`.
 */
function toAdapterPost(p: SourcePost): AdapterPost {
  return { id: p.id, url: p.url, text: p.text, title: null, author: p.author, metrics: p.metrics, createdAt: p.createdAt };
}

async function hackernewsSearch(
  query: string,
  opts: { fetcher: Fetcher; limit?: number },
): Promise<AdapterResult> {
  try {
    const posts = await searchHackerNews(query, { fetcher: opts.fetcher, limit: opts.limit });
    return { posts: posts.map(toAdapterPost), status: "ok" };
  } catch (e) {
    // Defense-in-depth only: searchHackerNews already degrades its own
    // failures to `[]` (see its doc comment) rather than throwing.
    return errorResult("hackernews", "request failed", e);
  }
}

export const hackernews: SourceAdapter = {
  name: "hackernews",
  label: "Hacker News",
  tag: "HN",
  search: hackernewsSearch,
};

async function blueskySearch(
  query: string,
  opts: { fetcher: Fetcher; limit?: number; env?: NodeJS.ProcessEnv },
): Promise<AdapterResult> {
  const env = opts.env ?? process.env;
  // Checked here too (on top of searchBluesky's own identical internal
  // check) so a misconfigured Bluesky never even calls searchBluesky — same
  // "disabled, no fetch" contract every other gated adapter documents (see
  // adapter.ts's envReady doc comment).
  if (!envReady({ requiredEnv: BLUESKY_REQUIRED_ENV }, env)) {
    return disabledResult({ requiredEnv: BLUESKY_REQUIRED_ENV });
  }
  try {
    const posts = await searchBluesky(query, {
      fetcher: opts.fetcher,
      limit: opts.limit,
      credentials: { identifier: env.BLUESKY_IDENTIFIER!.trim(), appPassword: env.BLUESKY_APP_PASSWORD!.trim() },
    });
    return { posts: posts.map(toAdapterPost), status: "ok" };
  } catch (e) {
    // Defense-in-depth only: searchBluesky already degrades its own
    // failures (including a non-ok response even after its 401 retry) to
    // `[]` rather than throwing.
    return errorResult("bluesky", "request failed", e);
  }
}

export const bluesky: SourceAdapter = {
  name: "bluesky",
  label: "Bluesky",
  tag: "BSKY",
  requiredEnv: BLUESKY_REQUIRED_ENV,
  search: blueskySearch,
};
