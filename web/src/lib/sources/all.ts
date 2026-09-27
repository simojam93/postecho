import { envReady, type SourceAdapter } from "./adapter";
import { bluesky, hackernews } from "./builtin";
import { EXTRA_ADAPTERS } from "./registry";
import { x } from "./x";

/**
 * Every discovery-source adapter the scout pipeline (lib/scout-run.ts) can
 * draw on, in one place: the two original free, open sources
 * (hackernews/bluesky, wrapped into `SourceAdapter` shape by builtin.ts) plus
 * the nine additional ones (registry.ts's `EXTRA_ADAPTERS`). This is the
 * "universe" of sources — see `getEnabledAdapters` for the subset actually
 * usable given the current environment.
 */
// X last: opt-in, with the owner's own paid API key (sources/x.ts).
export const ALL_ADAPTERS: SourceAdapter[] = [hackernews, bluesky, ...EXTRA_ADAPTERS, x];

/**
 * `ALL_ADAPTERS` filtered down to the ones `envReady` for `env` (defaulting
 * to `process.env`) — a keyless adapter (arXiv, GitHub, dev.to, Mastodon,
 * Lobsters, Lemmy, plus hackernews) is always included; a keyed one (Bluesky, YouTube,
 * Product Hunt, X) only once its `requiredEnv` is satisfied. Order
 * mirrors `ALL_ADAPTERS`.
 */
export function getEnabledAdapters(env: NodeJS.ProcessEnv = process.env): SourceAdapter[] {
  return ALL_ADAPTERS.filter((adapter) => envReady(adapter, env));
}

/** Looks up one of `ALL_ADAPTERS` by its machine name (e.g. "arxiv"); undefined when there's no match. */
export function adapterByName(name: string): SourceAdapter | undefined {
  return ALL_ADAPTERS.find((adapter) => adapter.name === name);
}
