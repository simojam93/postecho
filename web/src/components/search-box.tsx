"use client";

import { useState } from "react";
import { WorkProgress } from "@/components/work-progress";
import type { PerSourceSummary } from "@/lib/scout-run";
import { postSearch, SEARCH_TYPICAL, searchSteps, type SearchStep } from "@/lib/search-steps";
import { trackWork } from "@/components/work-status";
import { X_PRICES_USD, X_SOURCE_NAME } from "@/lib/sources/x";

type Message = { kind: "info" | "error"; text: string };
export type ScoutSummary = {
  candidates: number;
  judged: number;
  inserted: number;
  skippedDuplicates: number;
  note?: string;
  perSource?: Record<string, PerSourceSummary>;
  // The round/quota fields lib/scout-run.ts reports (2026-09-22) — optional
  // here only so an older or partial payload still renders the counts above.
  rounds?: number;
  minScore?: number;
  resultsTotal?: number;
};

/**
 * What X did in this search (lib/sources/x.ts, with the owner's own key):
 * why it failed, or what it read and roughly what X bills for that — null
 * when X is off.
 */
export function xSearchLine(perSource: Record<string, PerSourceSummary>): Message | null {
  const x = perSource[X_SOURCE_NAME];
  if (!x || x.status === "disabled") return null;
  if (x.status === "error") return { kind: "error", text: x.note ?? "X didn't answer this search." };
  if (!x.billed) return null;
  const { posts, users } = x.billed;
  const cost = posts * X_PRICES_USD.postRead + users * X_PRICES_USD.userRead;
  const authors = users > 0 ? ` and ${users} ${users === 1 ? "author" : "authors"}` : "";
  return { kind: "info", text: `X: read ${posts} ${posts === 1 ? "post" : "posts"}${authors}, about $${cost.toFixed(2)}` };
}

/**
 * What a search (POST /api/search) has to say once it's done: only what the
 * owner can act on — nothing found, or, without Jev, that the posts are
 * unranked and what a key adds. When it found posts with Jev, nothing: the
 * cards, the source row and the chip's count say it (owner, 2026-09-27:
 * "questo non mi serve vederlo, lo so già come info"). Exported for
 * (authed)/page.tsx's ↻ "Search again" on a chip and the welcome's first
 * search.
 */
export function scoutResultMessage(query: string, scout: ScoutSummary): Message | null {
  if (scout.candidates === 0) {
    return { kind: "info", text: `No posts found for “${query}” — try different words.` };
  }
  if (scout.note?.startsWith("unranked")) {
    return { kind: "info", text: "Unranked: add a Jev key in Settings › AI tools to rank them and filter spam." };
  }
  return null;
}

/**
 * The Trends half of search-first Find Ideas: a pasted seed (X post link,
 * article link, or a raw idea) becomes a saved card, and the scout runs
 * inline against every enabled discovery source (sources/all.ts's
 * ALL_ADAPTERS — Hacker News, Bluesky, arXiv, GitHub, dev.to, Mastodon,
 * YouTube, Product Hunt) judged by Jev — see POST /api/search. X
 * is searched too once the owner adds their own X API key in Settings (paid
 * per post read, capped per search — lib/sources/x.ts); without one, X posts
 * come in only when the owner pastes one.
 *
 * Under the box, only what needs doing (scoutResultMessage) and what X
 * billed, if X is on (2026-09-27). The sources still to connect are the
 * source row's "+ More sources".
 */
export function SearchBox({ onSearched, onBusyChange }: {
  onSearched: () => void;
  /** Told when a search starts and ends: Find Ideas shows placeholder cards meanwhile. */
  onBusyChange?: (busy: boolean) => void;
}) {
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<Message | null>(null);
  const [xLine, setXLine] = useState<Message | null>(null);
  // The search's steps as it streams them, and when it began (lib/search-steps.ts).
  const [steps, setSteps] = useState<SearchStep[]>([]);
  const [startedAt, setStartedAt] = useState<number | null>(null);

  async function search() {
    if (!value.trim() || busy) return;
    setBusy(true);
    onBusyChange?.(true);
    setMessage(null);
    setSteps([]);
    setStartedAt(Date.now());
    try {
      const res = await trackWork("find", postSearch({ input: value.trim(), mode: "trends" }, setSteps), (r) => r.ok);
      const body = res.body;
      if (!res.ok) {
        setMessage({ kind: "error", text: typeof body?.error === "string" ? body.error : "something went wrong" });
        return;
      }
      setMessage(scoutResultMessage(body.query, body.scout));
      setXLine(body.scout?.perSource ? xSearchLine(body.scout.perSource) : null);
      setValue("");
      onSearched();
    } catch (e) {
      console.error("search request failed:", e);
      setMessage({ kind: "error", text: "something went wrong" });
    } finally {
      setBusy(false);
      onBusyChange?.(false);
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex gap-2">
        <input
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && search()}
          placeholder="Paste an X post, an article link, or describe an idea — to find similar ideas"
          className="flex-1 rounded-lg border border-border bg-surface px-3 py-2 text-sm outline-none focus:border-text-dim"
        />
        <button
          onClick={search}
          data-tip="Find posts like this across your sources"
          disabled={busy}
          className="rounded-full bg-accent px-4 py-2 text-sm font-medium text-accent-ink disabled:opacity-50"
        >
          {busy ? "Searching…" : "Search"}
        </button>
      </div>
      {busy && <WorkProgress steps={searchSteps(steps)} startedAt={startedAt} typical={SEARCH_TYPICAL} label="Search progress" />}
      {!busy && message && (
        <p role="status" aria-live="polite" className={`text-sm ${message.kind === "error" ? "text-danger" : "text-text-dim"}`}>
          {message.text}
        </p>
      )}
      {!busy && xLine && (
        <p role="status" className={`text-xs ${xLine.kind === "error" ? "text-danger" : "text-text-dim"}`}>
          {xLine.text}
        </p>
      )}
    </div>
  );
}
