"use client";

import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { useRouter } from "next/navigation";
import { SearchBox, scoutResultMessage } from "@/components/search-box";
import { IdeaCard, type Idea } from "@/components/idea-card";
import { NewVideoForm } from "@/components/new-video-form";
import { VideoChips } from "@/components/videos/video-chips";
import { VideoIdeas } from "@/components/videos/video-ideas";
import { FirstSearchBanner } from "@/components/onboarding/first-search-banner";
import { getFirstSearch, IDEAS_CHANGED_EVENT, subscribeFirstSearch } from "@/components/onboarding/first-search";
import { SearchesStrip } from "@/components/searches-strip";
import { SettingsLink } from "@/components/settings/settings-provider";
import { GlowOnce, useHintSeen } from "@/components/onboarding/tab-hints";
import { VideosIntro } from "@/components/videos/videos-intro";
import { WorkProgress } from "@/components/work-progress";
import { postSearch, SEARCH_TYPICAL, searchSteps, type SearchStep } from "@/lib/search-steps";
import { trackWork } from "@/components/work-status";
import { ShowMoreButton, useShowMore } from "@/components/show-more";

// The topics row's one status line — what a chip's ↻ "Search again" (POST
// /api/search) found, or why it couldn't run.
type ScoutMessage = { kind: "info" | "error"; text: string };
type IdeaStatus = "used" | "dismissed" | "archived" | "kept" | "new";

// The three shelves (M2.5 W1 — owner direction, 2026-09-22: "trends e
// videos fanno la parte operativa e devono essere rapidamente ripulibili,
// liked rimangono quelli di valore"), keyed off idea.status with no schema
// change: `new` = Trends/Videos (disposable), `kept`/`used` = Liked (kept
// for good), `archived`/`dismissed` = gone.
type Mode = "trends" | "videos" | "liked";
// Each with the app's tooltip: what it holds, in a sentence (2026-09-27).
const MODES: { key: Mode; label: string; tip: string }[] = [
  { key: "trends", label: "Trends", tip: "Posts your searches found" },
  { key: "videos", label: "Video posts", tip: "X posts in your voice, from a video you paste" },
  { key: "liked", label: "Liked", tip: "Ideas you kept or used" },
];

/**
 * Trends = scouted results still awaiting review, whatever their source —
 * the youtube adapter's included (M3.5 U1, owner direction 2026-09-23: "YT
 * come source lo voglio comunque vedere nella pagina trends"; they show the
 * "YT" pill and a YouTube entry in the filter row). Notes (kind "note" — the
 * owner's own raw seed text) never appear anywhere in Find Ideas ("togli
 * anche le note dalla pagina find ideas"), and neither do the manually
 * pasted x_post/article seeds: a seed is what was searched for, not a
 * result — only scouted rows (source "scout", see lib/scout-run.ts) are
 * results. This is exactly the subset POST /api/ideas/clear archives (a
 * route without a button since 2026-09-23 — a chip's × is the per-topic
 * clear); the source filter row and the recent-search chips count this
 * same subset.
 */
function isTrendsResult(i: Idea): boolean {
  return i.source === "scout" && i.status === "new" && i.kind !== "note";
}

/**
 * Videos = the videos the owner pasted himself (source "manual" — the
 * NewVideoForm / POST /api/videos path) not yet used; a used one moves to
 * Liked like any other idea. Scouted youtube results are NOT videos in this
 * sense — they're Trends results (see isTrendsResult): "videos funziona
 * solo per estrarre posts dai videos".
 */
function isVideo(i: Idea): boolean {
  return i.source === "manual" && i.kind === "youtube" && i.status === "new";
}

/**
 * Liked = ♥ (kept) or Use pressed (used — POST /api/drafts/from-idea marks
 * it), every kind except notes. Ignores the query chips and source filters:
 * it's a shelf, not a search. Never touched by a chip's × (DELETE
 * /api/searches) or by POST /api/ideas/clear.
 */
function isLiked(i: Idea): boolean {
  return (i.status === "kept" || i.status === "used") && i.kind !== "note";
}

// Best-first ordering (Task A0, live-review follow-up 2026-09-22): scouted/
// judged ideas carry Jev's combined quality-aware rank in meta.rank (see
// idea-card.tsx's Idea.meta and lib/scout-run.ts) — sorting by it desc
// surfaces the strongest candidates first. Ideas with no rank (manually
// pasted notes/seeds, plus any pre-rank row that only ever got `score`) sort
// after every ranked idea; newest-first is the tiebreak both within that
// unranked group and for ranked ideas that happen to share a rank value.
function byRankThenRecency(a: Idea, b: Idea): number {
  const aRanked = typeof a.meta.rank === "number";
  const bRanked = typeof b.meta.rank === "number";
  if (aRanked !== bRanked) return aRanked ? -1 : 1;
  if (aRanked && bRanked && a.meta.rank !== b.meta.rank) {
    return (b.meta.rank as number) - (a.meta.rank as number);
  }
  return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
}

// Liked is a shelf, not a ranking: newest first. The M2.5 plan asks for
// newest `updatedAt` first, but `ideas` has no updated_at column (see
// db/schema.ts — only drafts/kv do) and M2.5 makes no schema change, so
// createdAt is the closest available proxy: a ♥ on an older result files it
// by the result's own date rather than by when it was liked.
function byRecency(a: Idea, b: Idea): number {
  return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
}

export default function FindIdeasPage() {
  const router = useRouter();
  const [mode, setMode] = useState<Mode>("trends");
  const [ideas, setIdeas] = useState<Idea[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [scoutMessage, setScoutMessage] = useState<ScoutMessage | null>(null);
  const [selectedQuery, setSelectedQuery] = useState<string | null>(null);
  // The searches, newest first (the chips' own load): the latest is the one
  // selected unless the owner picked another (2026-09-27: "rimane selezionata
  // sempre l'ultima ricerca").
  const [searchQueries, setSearchQueries] = useState<string[]>([]);
  const [searchesRefreshKey, setSearchesRefreshKey] = useState(0);
  // The chip whose ↻ "Search again" is in flight (null when none) — see searchAgain.
  const [searchingAgain, setSearchingAgain] = useState<string | null>(null);
  // Videos explains itself the first time its tab is clicked (2026-09-27).
  const videosHint = useHintSeen("videos");
  const [videosIntro, setVideosIntro] = useState(false);
  // A chip's ↻ as it streams its steps, and when it began (lib/search-steps.ts).
  const [againSteps, setAgainSteps] = useState<SearchStep[]>([]);
  const [againStartedAt, setAgainStartedAt] = useState<number | null>(null);
  const [searchBusy, setSearchBusy] = useState(false);
  // Videos: the chip picked (null = the latest pasted), a ↻ in flight, and a nudge for the ideas below to look again.
  const [selectedVideoId, setSelectedVideoId] = useState<string | null>(null);
  const [videoAgainId, setVideoAgainId] = useState<string | null>(null);
  const [videoRefreshKey, setVideoRefreshKey] = useState(0);
  // The sources without their keys yet (not ones the owner turned off): the
  // source row's "+ More sources" (2026-09-27: "to have better results connect
  // more sources… e li si rimanda ai settings", in the row, not a banner).
  const [missingSources, setMissingSources] = useState<string[]>([]);
  // The ideas in Settings' style inspiration (the cards' Learn from its style — Aa until 2026-09-26, now their right-click menu).
  const [styleIds, setStyleIds] = useState<Set<string>>(() => new Set());

  // Every setState here happens after an await (react-hooks/set-state-in-effect).
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch("/api/style-inspiration");
        if (!res.ok) return;
        const body = await res.json();
        const ids = (body.items as Array<{ ideaId: string | null }>).map((i) => i.ideaId).filter((id): id is string => Boolean(id));
        if (!cancelled) setStyleIds(new Set(ids));
      } catch (e) {
        console.error("failed to load style inspiration:", e);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  /** A card's Learn from its style (its right-click menu): into Settings' style inspiration, or off it (optimistic; put back on failure). */
  async function toggleStyle(idea: Idea, add: boolean) {
    setStyleIds((current) => { const next = new Set(current); if (add) next.add(idea.id); else next.delete(idea.id); return next; });
    const res = await (add
      ? fetch("/api/style-inspiration", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ideaId: idea.id }) })
      : fetch(`/api/style-inspiration?ideaId=${idea.id}`, { method: "DELETE" })).catch(() => null);
    if (!res?.ok) {
      setStyleIds((current) => { const next = new Set(current); if (add) next.delete(idea.id); else next.add(idea.id); return next; });
      setError(add ? "Couldn't add it to your style inspiration." : "Couldn't take it off your style inspiration.");
    }
  }

  const load = useCallback(async () => {
    const res = await fetch("/api/ideas");
    if (res.ok) {
      setIdeas((await res.json()).ideas);
      setError(null);
    } else {
      console.error("failed to load ideas:", res.status);
      setError("Failed to load ideas.");
    }
  }, []);

  // Fetch inline here (rather than calling `load()`) so this effect's own
  // closure doesn't route through a function tagged as "sets state" by
  // react-hooks/set-state-in-effect — `load` is still used for the imperative
  // refreshes below, just never invoked from inside an effect.
  useEffect(() => {
    fetch("/api/ideas").then(async (res) => {
      if (res.ok) {
        setIdeas((await res.json()).ideas);
      } else {
        console.error("failed to load ideas:", res.status);
        setError("Failed to load ideas.");
      }
    });
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/sources").then(async (res) => {
      if (!res.ok) return;
      const rows = (await res.json()).sources as Array<{ label: string; keyedBy: string; ready: boolean; off: boolean }>;
      if (!cancelled) setMissingSources(rows.filter((r) => r.keyedBy !== "none" && !r.ready && !r.off).map((r) => r.label));
    }).catch((e) => console.error("failed to load the sources:", e));
    return () => { cancelled = true; };
  }, [searchesRefreshKey]);

  // The welcome's searches (2026-09-26) finish while the owner reads on: each
  // one reloads the grid and the chips, so Find Ideas fills by itself.
  useEffect(() => {
    const reload = () => {
      void load();
      setSearchesRefreshKey((k) => k + 1);
      setSelectedQuery(null);
    };
    window.addEventListener(IDEAS_CHANGED_EVENT, reload);
    return () => window.removeEventListener(IDEAS_CHANGED_EVENT, reload);
  }, [load]);

  /**
   * ♥ / Dismiss — optimistic (M2.5 W1): the card's status flips in local
   * state first, so a ♥ in Trends moves the card to Liked (a ♥ in Liked
   * returns it to Trends, a Dismiss removes it) the instant it's clicked;
   * the PATCH follows, and only a failure reloads from the server to undo it.
   */
  async function setStatus(id: string, status: IdeaStatus) {
    setIdeas((current) => current.map((i) => (i.id === id ? { ...i, status } : i)));
    const res = await fetch(`/api/ideas/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status }),
    });
    if (res.ok) {
      setError(null);
    } else {
      console.error("failed to update idea status:", res.status);
      setError("Failed to update idea.");
      await load();
    }
  }

  /**
   * "Use" (task A9; the M2.5 W4 entry point): enqueues a generate_from_idea
   * job for this idea — which also marks it `used` server-side, see POST
   * /api/drafts/from-idea — and hands off to Write (`/create?ideaId=`),
   * where the job's progress and takes are shown. Identical from Trends,
   * Videos and Liked: a card that was on Liked stays there as `used` (with
   * its badge) when the owner comes back, since Liked shows kept AND used.
   * No local status flip before the push — this page unmounts on
   * navigation and refetches on return, so flipping here would only flash
   * the card out of the grid. Thrown errors are caught by IdeaCard's
   * handleUse, which shows them inline on the card — this list doesn't need
   * its own error state for it.
   */
  async function useIdea(id: string) {
    const res = await fetch("/api/drafts/from-idea", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ideaId: id }),
    });
    if (!res.ok) throw new Error(`failed to start generation (${res.status})`);
    router.push(`/create?ideaId=${id}`);
  }

  // Called after a search (SearchBox/NewVideoForm) or a chip's ↻ "Search
  // again" (searchAgain): the new idea and/or job won't show up on their own
  // until the next poll/reload, so nudge both right away.
  /** A video pasted: it's the latest, so its chip is the one selected. */
  function onVideoPasted() {
    void load();
    setSelectedVideoId(null);
    setVideoRefreshKey((k) => k + 1);
  }

  /** ↻ on a video chip: new post ideas from it (the unreviewed ones make way). */
  async function videoAgain(video: Idea) {
    if (videoAgainId !== null || !video.url) return;
    setVideoAgainId(video.id);
    try {
      const res = await fetch("/api/videos/ideas", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ url: video.url }) });
      if (!res.ok) console.error("asking the video again failed:", res.status);
      setSelectedVideoId(video.id);
      setVideoRefreshKey((k) => k + 1);
      void load();
    } finally {
      setVideoAgainId(null);
    }
  }

  /** × on a video chip: the video leaves the tab with its ideas still to review; Liked ones stay. */
  async function removeVideo(video: Idea) {
    if (!window.confirm(`Remove “${video.title ?? "this video"}” and its ideas? Liked ones are kept.`)) return;
    await Promise.all([video, ...ideasOfVideo(video.id)].map((i) => setStatus(i.id, i.id === video.id ? "dismissed" : "archived")));
  }

  function onSearchActivity() {
    load();
    setSearchesRefreshKey((k) => k + 1);
    // A new search is the latest: its chip is the one selected.
    setSelectedQuery(null);
  }

  /**
   * ↻ "Search again" on a topic chip (M3.5 U1 — owner direction, 2026-09-23:
   * "per ogni topic devo poterlo… ricercare anche singolarmente"): re-runs
   * POST /api/search with the chip's query as the input — exactly what
   * typing that query into the SearchBox does, so it saves the same kind of
   * seed and lands its new results under the same chip (deriveQuery is a
   * fixed point on its own output — see lib/query.ts's tests). Reports into
   * the topics row's status line, reusing the SearchBox's result wording,
   * then reloads the grid and the chips.
   */
  async function searchAgain(query: string) {
    if (searchingAgain !== null) return;
    setSearchingAgain(query);
    setScoutMessage(null);
    setAgainSteps([]);
    setAgainStartedAt(Date.now());
    try {
      const res = await trackWork("find", postSearch({ input: query }, setAgainSteps), (r) => r.ok);
      const body = res.body;
      if (!res.ok) {
        console.error("search again failed:", res.status);
        setScoutMessage({
          kind: "error",
          text: typeof body?.error === "string" ? body.error : "Failed to run this search again.",
        });
        return;
      }
      setScoutMessage(scoutResultMessage(body.query, body.scout));
      onSearchActivity();
      // ↻ keeps its own chip selected, whether or not it found anything new.
      setSelectedQuery(query);
    } catch (e) {
      console.error("search again request failed:", e);
      setScoutMessage({ kind: "error", text: "Failed to run this search again." });
    } finally {
      setSearchingAgain(null);
    }
  }

  const results = ideas.filter(isTrendsResult);

  // The selected search: the owner's pick while it still exists, else the latest.
  const activeQuery = selectedQuery !== null && searchQueries.includes(selectedQuery) ? selectedQuery : searchQueries[0] ?? null;
  // Trends shows one search at a time (the source filter row went on 2026-09-27: "anche questo va tolto").
  const trendsBase = results.filter((i) => activeQuery === null || i.meta.topic === activeQuery);

  // Per-chip counts for the strip: the same Trends subset, per topic, so a
  // chip and the grid behind it agree — GET /api/searches's own counts also
  // include kept/used results, which now live on the Liked shelf.
  const resultCountsByTopic: Record<string, number> = {};
  for (const i of results) {
    if (typeof i.meta.topic === "string") {
      resultCountsByTopic[i.meta.topic] = (resultCountsByTopic[i.meta.topic] ?? 0) + 1;
    }
  }

  const liked = ideas.filter(isLiked).sort(byRecency);
  // Videos, like Trends' searches (2026-09-27): a chip per pasted video, the
  // latest pasted selected unless the owner picked another, and below it that
  // video's ideas still to review, best first.
  const pastedAt = (i: Idea) => Date.parse(i.meta.pastedAt ?? i.createdAt);
  const videos = ideas.filter(isVideo).sort((a, b) => pastedAt(b) - pastedAt(a));
  // Best first: Jev's ✦ when it scored them (lib/video-posts.ts), else the order Claude gave.
  const ideasOfVideo = (videoId: string) => ideas
    .filter((i) => i.kind === "video_idea" && i.status === "new" && i.meta.videoId === videoId)
    .sort((a, b) => (b.meta.rank ?? -1) - (a.meta.rank ?? -1) || (a.meta.order ?? 0) - (b.meta.order ?? 0));
  const videoCounts = Object.fromEntries(videos.map((v) => [v.id, ideasOfVideo(v.id).length]));
  const activeVideo = videos.find((v) => v.id === selectedVideoId) ?? videos[0] ?? null;

  // Videos shows the selected video's ideas (VideoIdeas) instead of this grid.
  const visible = mode === "liked" ? liked : [...trendsBase].sort(byRankThenRecency);
  // Six cards at a time (2026-09-26), counted per view: tab and search chip.
  const { count: shown, showMore } = useShowMore(`${mode}|${activeQuery ?? ""}`);
  // Placeholder cards while a search runs — the welcome's first one, the box's or a chip's ↻
  // (2026-09-27: "l'animazione della search la lascerei sempre").
  const firstSearch = useSyncExternalStore(subscribeFirstSearch, getFirstSearch, () => null);
  const searching = mode === "trends" && (searchBusy || searchingAgain !== null || firstSearch?.status === "searching");

  return (
    <div className="space-y-6">
      {videosIntro && <VideosIntro onClose={() => setVideosIntro(false)} />}
      {/* The tabs, the box they drive and the two filter rows sit 12px apart, and
          Show more at the cards' own gap: six cards and Show more fit a laptop
          screen, Show more level with the account bar (owner, 2026-09-27: "la
          search venga su qualche pixel… portare tutto su di conseguenza", then
          "è showmore che deve allinearsi con la barra account"). */}
      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex gap-1 rounded-full bg-surface p-1 w-fit">
            {MODES.map(({ key, label, tip }) => (
              <button
                key={key}
                data-tip={tip}
                onClick={() => {
                  setMode(key);
                  setSelectedQuery(null);
                  if (key === "videos" && videosHint.unseen) {
                    videosHint.markSeen();
                    setVideosIntro(true);
                  }
                }}
                className={`rounded-full px-4 py-1.5 text-sm font-medium ${
                  mode === key ? "bg-surface-2 text-text" : "text-text-dim"
                }`}
              >
                {label}
                {key === "liked" && liked.length > 0 && <span className="text-text-dim"> · {liked.length}</span>}
              </button>
            ))}
          </div>
          {/* Right of the tabs, where there's room: the chips row stays one line (2026-09-27). */}
          {mode === "trends" && missingSources.length > 0 && (
            <span className="ml-auto">
              <GlowOnce id="sources">
                <SettingsLink tab="sources" tip={`Connect ${missingSources.join(", ")} for better results.`}
                  className="rounded-full border border-dashed border-border px-3 py-1 text-xs text-text-dim hover:border-text-dim hover:text-text">
                  + More sources
                </SettingsLink>
              </GlowOnce>
            </span>
          )}
        </div>

        {/* Liked has no input of its own: it's fed by ♥ and Use on the other two shelves. */}
        {mode === "trends" && <SearchBox onSearched={onSearchActivity} onBusyChange={setSearchBusy} />}
        {mode === "videos" && <NewVideoForm onSearched={onVideoPasted} />}
        {mode === "videos" && (
          <VideoChips videos={videos} counts={videoCounts} selectedId={activeVideo?.id ?? null} onSelect={setSelectedVideoId}
            onAgain={(video) => void videoAgain(video)} onRemove={(video) => void removeVideo(video)} againId={videoAgainId} />
        )}

        {mode === "trends" && (
          <div className="space-y-3">
            {/* The topics row (M3.5 U1) — Trends-only, since scouted results only
                ever render in Trends (Videos is pasted videos, Liked ignores
                topics): the chips, each with ↻ (searchAgain) and × (the strip's
                own DELETE /api/searches — the grid reloads via onDeleted). The
                row's "Search my topics" / "Clear all" pills and its "All" chip
                went on the owner's request (2026-09-23: "questi toglili pure…
                tanto lo faccio per richiesta"): searches start from the box or a
                chip's ↻, a chip's × clears its topic, clicking a selected chip
                again shows every topic. POST /api/scout-now and POST
                /api/ideas/clear stay as routes (the daily cron scouts the Settings
                topics) — they just have no button here. */}
            <SearchesStrip
              selectedQuery={activeQuery}
              onSelectQuery={setSelectedQuery}
              onLoaded={setSearchQueries}
              refreshKey={searchesRefreshKey}
              counts={resultCountsByTopic}
              onDeleted={() => { load(); }}
              onSearchAgain={searchAgain}
              searchingAgain={searchingAgain}
            />
          </div>
        )}
      </div>

      {mode === "trends" && <FirstSearchBanner />}

      {/* The topics row's status line: a chip's ↻ as it runs, then what it found (or why it couldn't run). */}
      {mode === "trends" && searchingAgain !== null && (
        <WorkProgress steps={searchSteps(againSteps)} startedAt={againStartedAt} typical={SEARCH_TYPICAL} label="Search progress" />
      )}
      {mode === "trends" && scoutMessage && (
        <p
          role="status"
          aria-live="polite"
          className={`text-sm ${scoutMessage.kind === "error" ? "text-danger" : "text-text-dim"}`}
        >
          {scoutMessage.text}
        </p>
      )}

      {error && <p className="text-sm text-danger">{error}</p>}

      {mode === "videos" ? (
        // Nothing to say before the first video: the box says it (2026-09-27: "questo toglilo").
        activeVideo && (
          <VideoIdeas key={activeVideo.id} video={activeVideo} ideas={ideasOfVideo(activeVideo.id)} onStatus={setStatus} onUse={useIdea}
            onChanged={load} refreshKey={videoRefreshKey} />
        )
      ) : (
      <div className="space-y-4">
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {visible.slice(0, shown).map((idea) => (
            <IdeaCard key={idea.id} idea={idea} onStatus={setStatus} onUse={useIdea} inStyle={styleIds.has(idea.id)} onStyle={toggleStyle} />
          ))}
          {searching && [0, 1, 2].map((i) => (
            <div key={i} aria-hidden className="h-56 animate-pulse rounded-2xl border border-border bg-surface" />
          ))}
          {visible.length === 0 && !searching && mode === "liked" && (
            <p className="text-sm text-text-dim">Nothing liked yet: press ♥ on a result in Trends.</p>
          )}
        </div>
        <ShowMoreButton hidden={visible.length - shown} onClick={showMore} />
      </div>
      )}
    </div>
  );
}
