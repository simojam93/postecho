"use client";

import { useSyncExternalStore } from "react";
import { SettingsLink } from "@/components/settings/settings-provider";
import { WorkProgress } from "@/components/work-progress";
import { SEARCH_TYPICAL, searchSteps } from "@/lib/search-steps";
import { getFirstSearch, subscribeFirstSearch, type FirstSearch } from "./first-search";

const pillCls = "shrink-0 rounded-full border border-border px-3 py-1 text-xs font-medium text-text hover:border-text-dim";

/**
 * What Find Ideas says about the welcome's first search, taking no room once
 * it's done (owner, 2026-09-27: "il suggerimento mi toglie il show more"):
 * the moving bar while it runs, then only what needs doing — Jev to rank the
 * posts it saved unranked, or nothing found. The sources that would find more are the "+ More sources"
 * pill in the source row instead. Pure, so it's tested without the store.
 */
export function FirstSearchNotice({ search }: { search: FirstSearch }) {
  if (search.status === "searching") {
    return <WorkProgress steps={searchSteps(search.steps)} startedAt={search.startedAt} typical={SEARCH_TYPICAL} label="First search progress" />;
  }
  if (search.status === "failed") return <p role="status" className="text-sm text-danger">The first search didn&apos;t work. Try it again in the box above.</p>;
  if (search.unranked) {
    return (
      <div role="status" className="flex flex-wrap items-center gap-3 text-sm">
        <p className="text-text-dim">These posts are unranked: Jev picks the ones worth reacting to and filters spam.</p>
        <SettingsLink tab="agent" className={pillCls}>Connect Jev</SettingsLink>
      </div>
    );
  }
  return search.found === 0 ? <p role="status" className="text-sm text-text-dim">{search.message}</p> : null;
}

/** Find Ideas' line about the welcome's first search. */
export function FirstSearchBanner() {
  const search = useSyncExternalStore(subscribeFirstSearch, getFirstSearch, () => null);
  return search ? <FirstSearchNotice search={search} /> : null;
}
