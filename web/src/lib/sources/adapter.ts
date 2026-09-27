import type { Fetcher, SourcePost } from "./types";

/**
 * Shared shape for the *additional* discovery-source adapters (arXiv,
 * GitHub, dev.to, Mastodon, YouTube, Reddit, Product Hunt — see
 * registry.ts). Deliberately separate from lib/sources/types.ts's
 * SourcePost/SourceName/Fetcher-consumers (bluesky.ts/hackernews.ts/
 * index.ts) — this is a purely additive change: nothing here is wired into
 * `searchAllSources` yet, and none of those existing files are touched.
 * `Fetcher` itself is reused as-is from lib/sources/types.ts.
 */
export type AdapterPost = {
  id: string;
  url: string;
  text: string;
  title?: string | null;
  author: string | null;
  /** See SourcePost.authorId. */
  authorId?: string | null;
  metrics: { likes?: number; reposts?: number; replies?: number };
  createdAt: string | null;
};

export type AdapterStatus = "ok" | "disabled" | "error";

export type AdapterResult = { posts: AdapterPost[]; status: AdapterStatus; note?: string };

export type SourceAdapter = {
  name: string; // machine name, e.g. "arxiv"
  label: string; // UI label, e.g. "arXiv"
  tag: string; // short filter tag, e.g. "AX"
  requiredEnv?: string[]; // env vars that must be set, else status "disabled"
  search(query: string, opts: { fetcher: Fetcher; limit?: number; env?: NodeJS.ProcessEnv }): Promise<AdapterResult>;
  /**
   * A source billed per post read (X, 2026-09-24): the most posts one whole
   * search may read from it, every query variant together. lib/scout-run.ts
   * reads it in round 1 only, never asks for more than what's left, and
   * stops once less than `minPerRequest` is left.
   */
  postsPerSearch?: (env: NodeJS.ProcessEnv) => number;
  /** The smallest page the source's API will return (X: 10). */
  minPerRequest?: number;
  /**
   * Lookups deferred to the posts that made the pick (X bills every author
   * it returns): fills in their author and url. Best effort — a failure
   * leaves the posts as they were.
   */
  finalizePicked?: (posts: SourcePost[], opts: { fetcher: Fetcher; env: NodeJS.ProcessEnv }) => Promise<SourcePost[]>;
};

/**
 * True when every one of `adapter.requiredEnv` is a non-empty (post-trim)
 * string in `env`; vacuously true when `requiredEnv` is absent/empty (the
 * keyless adapters). Each adapter's own `search()` also runs this same
 * check internally (see the "Every adapter" contract in each file's doc
 * comment) so it degrades correctly even when called directly rather than
 * through `runAdapters` — this export lets registry.ts (and tests) apply
 * the identical rule without duplicating it. Takes just the `requiredEnv`
 * slice of `SourceAdapter` (any full `SourceAdapter` still satisfies this,
 * since it always has that property) so a keyed adapter's own `search()`
 * can call it without constructing a whole adapter object.
 */
export function envReady(adapter: Pick<SourceAdapter, "requiredEnv">, env: NodeJS.ProcessEnv): boolean {
  if (!adapter.requiredEnv || adapter.requiredEnv.length === 0) return true;
  return adapter.requiredEnv.every((key) => Boolean(env[key]?.trim()));
}

// ---------------------------------------------------------------------------
// Shared helpers used by every adapter in this directory.
//
// lib/enrich.ts already has equivalent decodeEntities/stripTags helpers, but
// they're module-private there (not exported), and this task is a purely
// additive change — only new files under lib/sources/, nothing existing
// touched — so rather than edit enrich.ts to export them, each adapter here
// reuses this local, equivalent implementation instead.
// ---------------------------------------------------------------------------

/** Default `limit` every adapter uses when the caller doesn't pass one. */
export const ADAPTER_DEFAULT_LIMIT = 25;

/** Every adapter's fetch timeout, via `AbortSignal.timeout(ADAPTER_TIMEOUT_MS)`. */
export const ADAPTER_TIMEOUT_MS = 8000;

/** Every adapter's `AdapterPost.text` is capped at this many characters. */
export const ADAPTER_MAX_TEXT_CHARS = 600;

/**
 * The descriptive User-Agent the adapters that identify themselves send
 * (lobsters.ts, lemmy.ts — both APIs ask clients for one). github.ts
 * predates this and sends a bare "PostEcho"; reddit.ts has its own
 * Reddit-mandated `platform:app:version (by /u/name)` format.
 */
export const ADAPTER_USER_AGENT = "PostEcho/0.1 (+https://github.com/simojam93/PostEcho)";

// "&amp;" is decoded LAST, after every other entity — see lib/enrich.ts's
// decodeEntities for why (decoding it first can turn a literal
// "&amp;lt;" into "&lt;", which the "&lt;" replace would then wrongly
// re-decode into "<").
export function decodeEntities(s: string): string {
  return s
    .replace(/&mdash;/g, "—")
    .replace(/&ndash;/g, "–")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0*39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

export function stripTags(html: string): string {
  const noTags = html.replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, "");
  return decodeEntities(noTags).trim();
}

/**
 * Trims and caps at `max` (defaults to the shared 600-char contract). A
 * longer text is cut after its last whole sentence, else at a word with "…",
 * so a card's "more" never ends mid-word (owner, 2026-09-27: "mi controlli
 * che i more and less funzionino come si deve?").
 */
export function clampText(s: string, max: number = ADAPTER_MAX_TEXT_CHARS): string {
  const trimmed = s.trim();
  if (trimmed.length <= max) return trimmed;
  const head = trimmed.slice(0, max);
  const sentenceEnd = Math.max(...[". ", "! ", "? ", ".\n", "!\n", "?\n"].map((mark) => head.lastIndexOf(mark)));
  if (sentenceEnd >= max / 2) return head.slice(0, sentenceEnd + 1);
  const wordEnd = head.search(/\s\S*$/);
  return wordEnd >= max / 2 ? `${head.slice(0, wordEnd).trimEnd()}…` : `${head.slice(0, max - 1)}…`;
}

/**
 * The first whitespace-delimited token of `query`, lowercased and stripped
 * to `[a-z0-9]` only — the "tag" a couple of adapters (dev.to, Mastodon)
 * filter on since neither's public API supports full-text search. Safe to
 * drop straight into a URL path segment or query param.
 */
export function firstKeywordTag(query: string): string {
  const first = query.trim().split(/\s+/)[0] ?? "";
  return first.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * The shortest token `keywordTags` will accept. Two-letter and one-letter
 * tokens ("ai", "in", "a") are hashtags on essentially every instance, so
 * they filter nothing — dropping them is what makes the SECOND tag worth
 * requesting at all.
 */
export const MIN_KEYWORD_TAG_CHARS = 3;

/**
 * Up to `max` distinct hashtags for `query`, applying `firstKeywordTag`'s
 * normalisation (lowercase, `[a-z0-9]` only) to EVERY whitespace-delimited
 * token rather than just the first, then dropping anything shorter than
 * `MIN_KEYWORD_TAG_CHARS`. Order is the query's own, so `[0]` is still the
 * leading keyword `firstKeywordTag` would have returned (whenever that one
 * is long enough).
 *
 * FALLBACK: when no token survives the length filter the short ones are used
 * anyway — a search for "ai" should still search *something*, and returning
 * `[]` there would silently turn the whole source off. Only a query with no
 * alphanumerics at all yields `[]`, and the callers treat that as "nothing
 * to ask for" rather than an error.
 */
export function keywordTags(query: string, max: number): string[] {
  const tokens = query
    .trim()
    .split(/\s+/)
    .map((token) => token.toLowerCase().replace(/[^a-z0-9]/g, ""))
    .filter((token) => token.length > 0);
  const distinct = Array.from(new Set(tokens));
  const longEnough = distinct.filter((token) => token.length >= MIN_KEYWORD_TAG_CHARS);
  return (longEnough.length > 0 ? longEnough : distinct).slice(0, max);
}

/**
 * The list of hosts a federated source should query, for the two adapters
 * (mastodon.ts, lemmy.ts) that fan out across instances. Precedence, highest
 * first:
 *
 *  1. `singular` (MASTODON_INSTANCE / LEMMY_INSTANCE) — the ORIGINAL
 *     one-instance env var. Still honoured, and still wins outright, so an
 *     existing deployment that pinned one instance keeps behaving exactly as
 *     it did before this fan-out existed.
 *  2. `plural` (MASTODON_INSTANCES / LEMMY_INSTANCES) — comma-separated
 *     hosts; blank entries and duplicates are dropped.
 *  3. `defaults`.
 *
 * Hosts only (no scheme, no path): each adapter builds `https://<host>/…`.
 */
export function instanceHosts(params: {
  env: NodeJS.ProcessEnv;
  singular: string;
  plural: string;
  defaults: string[];
}): string[] {
  const pinned = params.env[params.singular]?.trim();
  if (pinned) return [pinned];

  const list = params.env[params.plural]?.trim();
  if (list) {
    const hosts = Array.from(new Set(list.split(",").map((host) => host.trim()).filter(Boolean)));
    if (hosts.length > 0) return hosts;
  }
  return params.defaults;
}

/**
 * The shared `note` the fanning-out adapters report when some (or all) of
 * their instances fail: "2 of 4 instances failed: hachyderm.io, mas.to".
 * Counts INSTANCES, not requests — an instance that fails both of its
 * requests is one dead server, and that is the number worth reading.
 */
export function failedInstancesNote(failedHosts: string[], totalInstances: number): string {
  const unique = Array.from(new Set(failedHosts));
  return `${unique.length} of ${totalInstances} instances failed: ${unique.join(", ")}`;
}

/** Dedupes by `url`, keeping the first occurrence — same contract as lib/sources/index.ts's searchAllSources. */
export function dedupeByUrl<T extends { url: string }>(items: T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const item of items) {
    if (seen.has(item.url)) continue;
    seen.add(item.url);
    out.push(item);
  }
  return out;
}

/** `{ posts: [], status: "disabled", note: "set X, Y" }` — the shared shape every adapter returns when `requiredEnv` isn't satisfied, without making any fetch. */
export function disabledResult(adapter: Pick<SourceAdapter, "requiredEnv">): AdapterResult {
  return { posts: [], status: "disabled", note: `set ${(adapter.requiredEnv ?? []).join(", ")}` };
}

/**
 * Logs exactly one `console.warn` and returns `{ posts: [], status: "error",
 * note }` — the shared failure contract every adapter's catch block (and
 * non-ok-response branch) uses. `cause` is omitted from the log when there
 * isn't one (e.g. a non-ok HTTP status, where `note` already says it all).
 */
export function errorResult(sourceName: string, note: string, cause?: unknown): AdapterResult {
  if (cause !== undefined) {
    console.warn(`${sourceName}: ${note}`, cause);
  } else {
    console.warn(`${sourceName}: ${note}`);
  }
  return { posts: [], status: "error", note };
}
