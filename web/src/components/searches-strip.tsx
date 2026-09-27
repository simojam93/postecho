"use client";

import { useEffect, useState } from "react";

// `seed` (2026-09-24): what the owner typed for that search, when known — the chip's tooltip.
type SearchEntry = { query: string; count: number; lastAt: string; seed?: string | null };

// How many chips show before the rest fold behind "Show more (N)" (owner
// direction, 2026-09-23: "max di 3/4 tipo gli ultimi e poi un show more").
// Three at most, the rest behind Show more (owner, 2026-09-27: "le ricerche
// non devono superare le tre visibili poi le altre vanno nascoste").
const VISIBLE_CHIPS = 3;

/**
 * The topics row: the recent-search chips (M3.5 U1 — owner direction,
 * 2026-09-23: "per ogni topic devo poterlo cancellare o ricercare anche
 * singolarmente… max di 3/4 tipo gli ultimi e poi un show more"). The
 * latest VISIBLE_CHIPS chips, the rest behind **Show more (N)** / **Show
 * less**. One chip is always selected, the latest search unless the owner
 * picks another (2026-09-27: "rimane selezionata sempre l'ultima ricerca"),
 * and the Find Ideas grid shows its topic (idea.meta.topic); ↻ re-runs its
 * search, × removes it. The row used to open with "Search my
 * topics" / "Clear all" pills and an "All" chip; the owner had them removed
 * the same day ("questi toglili pure, secondo me non servono. tanto lo
 * faccio per richiesta"): searches start from the search box or a chip's ↻,
 * and a chip's × is the per-topic clear.
 *
 * Ownership split: the page owns the search — `onSearchAgain` (POST
 * /api/search with the chip's query as its input, i.e. what typing it into
 * the search box does) calls back up and `searchingAgain` comes back down.
 * The one request the strip makes itself, besides loading the chips, is a
 * chip's × (DELETE /api/searches), which only concerns that chip.
 *
 * M1.5 final design: reads straight off scouted ideas via `GET
 * /api/searches` (grouped by `meta.topic`, newest first) instead of polling
 * a jobs table — the scout runs inline within the search request itself, so
 * there's no queued/running job state left to poll for. `refreshKey` nudges
 * an immediate reload right after this session's own search, instead of
 * waiting for the next one.
 *
 * `counts` (M2.5 W1): the per-topic numbers the chips show. The route's own
 * `count` includes every non-dismissed/archived result, kept/used ones too —
 * but those now live on the Liked shelf, so the page passes the count of
 * what Trends actually renders per topic (its `new` scouted results) and a
 * chip agrees with the grid behind it. A topic missing from the map shows
 * 0: its chip stays (something kept/used is behind it, and it can still be
 * removed) but there's nothing left to review.
 */
export function SearchesStrip({
  selectedQuery,
  onSelectQuery,
  refreshKey,
  counts,
  onDeleted,
  onSearchAgain,
  searchingAgain,
  onLoaded,
}: {
  /** The chip shown selected: the page's pick, or the latest search. */
  selectedQuery: string | null;
  onSelectQuery: (query: string) => void;
  /** The searches as loaded, newest first: the page selects the latest by default. */
  onLoaded?: (queries: string[]) => void;
  refreshKey?: number;
  /** Per-topic counts to show instead of the route's own (see the component doc). */
  counts?: Record<string, number>;
  /** A chip was deleted (DELETE /api/searches): its unreviewed results are now archived, so the caller should reload its ideas. */
  onDeleted?: (query: string) => void;
  /**
   * ↻ pressed on a chip — the page re-runs POST /api/search with the chip's
   * query as input; `searchingAgain` is the query being re-run (every ↻ is
   * disabled meanwhile, the running one spins).
   */
  onSearchAgain: (query: string) => void;
  searchingAgain: string | null;
}) {
  const [searches, setSearches] = useState<SearchEntry[]>([]);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);

  // "×" on a chip (owner direction, 2026-09-22: old topics must be
  // deletable). Confirms first — it archives every not-yet-reviewed result
  // of that search, and never touches Liked (kept/used results only lose the
  // topic tag — see DELETE /api/searches) — then drops the chip locally,
  // clears the filter if it was the selected one, and tells the page to
  // reload its ideas.
  async function deleteSearch(query: string) {
    if (deleting) return;
    if (!window.confirm(`Remove “${query}” and archive its unreviewed results? Liked items are kept.`)) return;
    setDeleting(query);
    try {
      const res = await fetch(`/api/searches?query=${encodeURIComponent(query)}`, { method: "DELETE" });
      if (!res.ok) {
        console.error("failed to delete search:", res.status);
        return;
      }
      const next = searches.filter((s) => s.query !== query);
      setSearches(next);
      // The page falls back to the latest one left when this was the selected chip.
      onLoaded?.(next.map((s) => s.query));
      onDeleted?.(query);
    } finally {
      setDeleting(null);
    }
  }

  // Fetch inline here (rather than calling a named loader) so this effect's
  // own closure doesn't route through a function tagged as "sets state" by
  // react-hooks/set-state-in-effect — same pattern as (authed)/page.tsx's
  // mount effect. `cancelled` guards against setting state after this
  // effect's own unmount (e.g. a fast tab switch away from Find Ideas).
  useEffect(() => {
    let cancelled = false;
    fetch("/api/searches").then(async (res) => {
      if (!res.ok) {
        console.error("failed to load recent searches:", res.status);
        return;
      }
      const data = await res.json();
      if (cancelled) return;
      setSearches(data.searches);
      onLoaded?.((data.searches as SearchEntry[]).map((s) => s.query));
    });
    return () => { cancelled = true; };
  }, [refreshKey, onLoaded]);

  // The latest VISIBLE_CHIPS chips (the route returns newest first) unless
  // expanded. A selected chip that would fold away stays visible whatever
  // its position — the grid is filtered by it and the Clear pill reads
  // "Clear this search" because of it, so folding it would leave both
  // unexplained. Derived on render, not synced in an effect: there's
  // nothing to reset when chips come and go.
  const folded = searches.slice(VISIBLE_CHIPS);
  const selectedFolded = folded.find((s) => s.query === selectedQuery);
  const visibleChips = expanded
    ? searches
    : selectedFolded
      ? [...searches.slice(0, VISIBLE_CHIPS), selectedFolded]
      : searches.slice(0, VISIBLE_CHIPS);
  const foldedCount = folded.length - (selectedFolded ? 1 : 0);

  if (searches.length === 0) return null;

  return (
    <div role="status" aria-live="polite" className="flex flex-wrap items-center gap-2">
      {visibleChips.map((s) => {
        const active = selectedQuery === s.query;
        const running = searchingAgain === s.query;
        const count = counts ? (counts[s.query] ?? 0) : s.count;
        return (
          <span
            key={s.query}
            className={`inline-flex items-center rounded-full border text-xs ${
              active ? "border-text-dim bg-surface-2 text-text" : "border-border text-text-dim"
            }`}
          >
            <button
              onClick={() => onSelectQuery(s.query)}
              aria-pressed={active}
              data-tip={s.seed ? `You searched: ${s.seed}` : "Show this search's results"}
              className="rounded-l-full py-1 pl-3 pr-1 hover:text-text"
            >
              &ldquo;{s.query}&rdquo; <span className="text-text-dim">· {count}</span>
            </button>
            <button
              onClick={() => onSearchAgain(s.query)}
              disabled={searchingAgain !== null}
              aria-busy={running || undefined}
              data-tip="Search again for new posts"
              aria-label={`Search again: ${s.query}`}
              className={`px-1 py-1 text-text-dim ${running ? "animate-spin text-text" : "hover:text-text disabled:opacity-50"}`}
            >
              ↻
            </button>
            <button
              onClick={() => deleteSearch(s.query)}
              disabled={deleting !== null}
              data-tip="Remove this search; Liked posts stay"
              aria-label={`Remove search ${s.query}`}
              className="rounded-r-full py-1 pl-1 pr-2.5 text-text-dim hover:text-danger disabled:opacity-50"
            >
              ×
            </button>
          </span>
        );
      })}
      {!expanded && foldedCount > 0 && (
        <button
          onClick={() => setExpanded(true)}
          className="rounded-full border border-border px-3 py-1 text-xs text-text-dim hover:text-text"
        >
          Show more ({foldedCount})
        </button>
      )}
      {expanded && folded.length > 0 && (
        <button
          onClick={() => setExpanded(false)}
          className="rounded-full border border-border px-3 py-1 text-xs text-text-dim hover:text-text"
        >
          Show less
        </button>
      )}
    </div>
  );
}
