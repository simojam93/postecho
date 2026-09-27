"use client";

import { useState } from "react";

/**
 * Six cards at a time (owner, 2026-09-26: "in search ideas forse farei vedere
 * max 6 cards e poi serve un more"): a grid shows the first six, and "Show
 * more" adds six each time. A new view (another tab, search or source) starts
 * from six again: the count belongs to the view it was raised in.
 */
export const CARDS_PER_PAGE = 6;

type Shown = { view: string; count: number };

/** How many cards the view shows: its raised count, or six for a view it wasn't raised in. */
export function shownCount(state: Shown, view: string): number {
  return state.view === view ? state.count : CARDS_PER_PAGE;
}

export function useShowMore(view: string) {
  const [state, setState] = useState<Shown>({ view, count: CARDS_PER_PAGE });
  const count = shownCount(state, view);
  return { count, showMore: () => setState({ view, count: count + CARDS_PER_PAGE }) };
}

export function ShowMoreButton({ hidden, onClick }: { hidden: number; onClick: () => void }) {
  if (hidden <= 0) return null;
  return (
    <div className="flex justify-center">
      <button type="button" onClick={onClick} className="rounded-full border border-border px-5 py-2 text-sm font-medium text-text-dim hover:text-text">
        Show more · {hidden} left
      </button>
    </div>
  );
}
