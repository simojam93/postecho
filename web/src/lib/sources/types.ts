export type SourceName =
  | "hackernews"
  | "bluesky"
  | "arxiv"
  | "github"
  | "devto"
  | "mastodon"
  | "lobsters"
  | "lemmy"
  | "youtube"
  | "producthunt"
  // X (2026-09-24), opt-in with the owner's own API key: its scouted ideas
  // reuse the existing "x_post" idea kind, so no migration.
  | "x_post";

/**
 * Per-source outcome of one `searchAllSources` fan-out: "ok" (the request
 * pipeline ran, whether or not it found anything), "disabled" (Bluesky only
 * — no BLUESKY_IDENTIFIER/BLUESKY_APP_PASSWORD configured, so it never even
 * tried), or "error" (the source's call rejected — defense-in-depth, since
 * each source degrades its own failures to `[]` rather than throwing; see
 * bluesky.ts/hackernews.ts).
 */
export type SourceStatus = "ok" | "disabled" | "error";

export type SourcePost = {
  id: string;
  source: SourceName;
  url: string;
  text: string;
  author: string | null;
  /** The source's own id for the author, when its author name needs a lookup after the pick (X). */
  authorId?: string | null;
  metrics: { likes?: number; reposts?: number; replies?: number };
  createdAt: string | null;
};

/**
 * Same shape as `lib/enrich.ts`'s `Fetcher`, plus an optional `init` so
 * callers can pass `AbortSignal.timeout(...)` through to the real `fetch`.
 */
export type Fetcher = (
  url: string,
  init?: RequestInit,
) => Promise<{ ok: boolean; status: number; text: () => Promise<string> }>;
