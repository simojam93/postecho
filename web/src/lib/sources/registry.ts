import { disabledResult, envReady, type AdapterResult, type SourceAdapter } from "./adapter";
import { arxiv } from "./arxiv";
import { devto } from "./devto";
import { github } from "./github";
import { lemmy } from "./lemmy";
import { lobsters } from "./lobsters";
import { mastodon } from "./mastodon";
import { producthunt } from "./producthunt";
import type { Fetcher } from "./types";
import { youtube } from "./youtube";

/**
 * Every discovery-source adapter beyond builtin.ts's original two, in one
 * place. The order here IS `ALL_ADAPTERS`' order after hackernews/bluesky
 * (sources/all.ts, mirrored by labels.ts's filter-row order): the keyless
 * adapters first (arXiv, GitHub, dev.to, Mastodon, Lobsters, Lemmy), then
 * the keyed ones (YouTube, Product Hunt). Reddit was taken out (owner, 2026-09-25).
 */
export const EXTRA_ADAPTERS: SourceAdapter[] = [arxiv, github, devto, mastodon, lobsters, lemmy, youtube, producthunt];

/**
 * Fans a query out to every given adapter in parallel via `Promise.
 * allSettled` and reports each one's `AdapterResult`, keyed by
 * `adapter.name`.
 *
 * Two layers of defense make one bad adapter harmless to the rest:
 *  - `envReady` is checked here BEFORE calling `search()` at all, so a
 *    misconfigured (missing-env) adapter never even makes a request — this
 *    is on top of each adapter's own identical internal check (see each
 *    adapter's doc comment), so the same "disabled, no fetch" outcome holds
 *    whether an adapter is driven through this registry or called directly.
 *  - `Promise.allSettled` means that even if an adapter's `search()` ever
 *    threw instead of following its documented degrade-to-`AdapterResult`
 *    contract, that alone can't stop the other adapters' results from
 *    coming back — the offending one just reports `status: "error"`.
 */
export async function runAdapters(
  adapters: SourceAdapter[],
  query: string,
  opts: { fetcher: Fetcher; limit?: number; env?: NodeJS.ProcessEnv },
): Promise<{ results: Record<string, AdapterResult> }> {
  const env = opts.env ?? process.env;

  const settled = await Promise.allSettled(
    adapters.map((adapter) =>
      envReady(adapter, env)
        ? adapter.search(query, { fetcher: opts.fetcher, limit: opts.limit, env })
        : Promise.resolve(disabledResult(adapter)),
    ),
  );

  const results: Record<string, AdapterResult> = {};
  settled.forEach((settledResult, i) => {
    const adapter = adapters[i];
    results[adapter.name] =
      settledResult.status === "fulfilled"
        ? settledResult.value
        : {
            posts: [],
            status: "error",
            note: settledResult.reason instanceof Error ? settledResult.reason.message : String(settledResult.reason),
          };
  });
  return { results };
}
