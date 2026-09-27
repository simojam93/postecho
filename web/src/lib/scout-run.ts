import { and, eq, inArray } from "drizzle-orm";
import { judgePosts, rateAiStyle as jevRateAiStyle, sortByRank, type JevClient, type PostJudgment } from "jev-judge";
import { ideas } from "@/db/schema";
import { deepRead as readCard, deepReadPatch, isDiscussionKind } from "@/lib/deep-read";
import { decodeEntities } from "@/lib/enrich";
import { jevClient } from "@/lib/connections";
import { jevKinds, RELEVANCE_GATE } from "@/lib/find-kinds";
import { saveIdeaFromInput } from "@/lib/ideas";
import { queryVariants } from "@/lib/query";
import type { SearchStep } from "@/lib/search-steps";
import { getSetting } from "@/lib/settings";
import { envReady, type AdapterPost, type SourceAdapter } from "@/lib/sources/adapter";
import { ALL_ADAPTERS } from "@/lib/sources/all";
import { loadTasteExamples } from "@/lib/taste";
import { scoutEnv } from "@/lib/x-config";
import type { Fetcher, SourceName, SourcePost, SourceStatus } from "@/lib/sources/types";
import type { db as Db } from "@/db";

export type PerSourceSummary = {
  /** This adapter's outcome for this run — see SourceStatus. A "disabled" (missing required env) or "error" (a variant attempt failed) adapter is still reported here — disabled ones with every count below left at 0 — so the UI can show what's off (see search-box.tsx/sources/labels.ts). */
  status: SourceStatus;
  /** Deduped-by-url candidates collected from this source, cumulative across rounds. */
  candidates: number;
  /** Candidates Jev returned a judgment for, cumulative across rounds. */
  judged: number;
  /** Judgments that are non-spam AND `rank >= minScore` — the only candidates eligible for insertion — cumulative across rounds. The run keeps searching until these add up to `resultsTotal` across all sources (see runScoutSearch). */
  strong: number;
  inserted: number;
  skippedDuplicates: number;
  /**
   * Query variants that went DEAD for this source — at least
   * VARIANT_DEAD_MIN_JUDGED of the candidates they produced here judged, none
   * strong — and so were never queried here again (see collectRound). With
   * ScoutRunSummary.variantsTried, how much pruning a run did. Optional in
   * the type only so summaries typed before the field existed (the route
   * tests' fixtures) still compile; runScoutSearch always sets it.
   */
  deadVariants?: number;
  /** Why the source failed, when it said (a paid source's key or credits — search-box.tsx shows X's). */
  note?: string;
  /** A source billed per read (X): what this search read from it — its posts, and the authors looked up after the pick. */
  billed?: { posts: number; users: number };
};

export type ScoutRunSummary = {
  query: string;
  candidates: number;
  judged: number;
  inserted: number;
  skippedDuplicates: number;
  /** How many collect→judge rounds this run made (1..MAX_ROUNDS) — see runScoutSearch. */
  rounds: number;
  /** The ✦ rank cutoff this run applied: deps.minScore ?? the `scoutMinScore` kv setting. */
  minScore: number;
  /** How many strong results this run aimed to end up with, best-first across all sources: deps.resultsTotal ?? the `scoutResultsTotal` kv setting. */
  resultsTotal: number;
  /** Distinct (source, variant) pairs this run actually queried, over all its rounds — the denominator for the per-source `deadVariants`. Optional in the type for the same reason as PerSourceSummary.deadVariants; always set. */
  variantsTried?: number;
  /** Per-adapter breakdown (M1.5 result rules, generalized to all nine sources — seven-adapters wiring, 2026-09-22), keyed by adapter name — one entry for every adapter this run considered (`deps.adapters` ?? every adapter in sources/all.ts's ALL_ADAPTERS), including disabled/errored ones. */
  perSource: Record<string, PerSourceSummary>;
  note?: string;
};

export type RunScoutSearchInput = {
  /** Keyword query sent to every enabled source (and expanded into variants — see lib/query.ts's queryVariants), and the value stored as each inserted idea's `meta.topic`. */
  query: string;
  /** Topic text Jev judges relevance against — the seed's full text for a Search, or the topic itself for "Search my topics"/cron. */
  judgeTopic: string;
  /**
   * The seed idea's id, when this run was triggered by POST /api/search.
   * Accepted for parity with the caller (which always has one on hand) but
   * currently unused: a scouted idea's meta only records
   * {score, quality, tasteFit, rank, topic, sourceName, metrics,
   * queryVariant} (see the insert step below), not its seed's id.
   */
  seedIdeaId?: string;
};

export type RunScoutSearchDeps = {
  /** Told as the search moves on (POST /api/search streams it to the page); a listener that throws never stops it. */
  onStep?: (step: SearchStep) => void;
  fetcher?: Fetcher;
  jev?: JevClient;
  /** Overrides the `scoutMinScore` kv setting (minimum ✦ `rank` a candidate needs to be saved). */
  minScore?: number;
  /** Overrides the `scoutResultsTotal` kv setting (how many strong results to end up with, best-first across all sources). */
  resultsTotal?: number;
  /** Overrides the `scoutCandidatesPerSource` kv setting (per-source accumulation cap for round 1 — round N's cap, and the `limit` passed to adapters, is N times it). */
  candidatesPerSource?: number;
  /**
   * Overrides the universe of adapters this run considers — defaults to
   * every adapter in `sources/all.ts`'s `ALL_ADAPTERS` (nine real sources).
   * Tests inject a small fake list instead of hitting real network APIs;
   * production always leaves this unset.
   */
  adapters?: SourceAdapter[];
  /** The clock (ms) the round loop's time budget reads — defaults to Date.now; tests inject a scripted one. */
  now?: () => number;
  /**
   * Reads a discussion card's article and comments for its summary
   * (lib/deep-read.ts's deepRead) — tests inject a fake; production leaves
   * it unset.
   */
  deepRead?: typeof readCard;
  /** Jev's batched AI-style rating (jev-judge's rateAiStyle) — tests inject a fake; production leaves it unset. */
  rateAiStyle?: typeof jevRateAiStyle;
  /** The env adapters read — defaults to process.env plus the X key saved in Settings (lib/x-config.ts's scoutEnv). */
  env?: NodeJS.ProcessEnv;
};

/**
 * Card summaries for the discussion sources (owner, 2026-09-23: "per HN ha
 * senso dare un mini summary di cosa c'è dentro") run after the pick, in
 * parallel, only if this much of the request's 60 s is still unspent — each
 * read is at most two requests of SUMMARY_FETCH_TIMEOUT_MS.
 */
const SUMMARY_DEADLINE_MS = 44_000;
/**
 * The cards' human score (owner, 2026-09-24: "sarebbe figo se anche i post
 * cercati nel find ideas avessero un check di jev se sono AI slop o no,
 * almeno posso partire da quelli già migliori"): rated in one batch after the
 * summaries — about three Jev calls for twenty cards — only while this much
 * of the request's 60 s is unspent. A text shorter than AI_STYLE_MIN_CHARS
 * (a bare Hacker News title) has no style to judge and stays unrated.
 */
const AI_STYLE_DEADLINE_MS = 52_000;
const AI_STYLE_MIN_CHARS = 80;
const SUMMARY_FETCH_TIMEOUT_MS = 4000;
type IdeaRow = typeof ideas.$inferSelect;

// "Keep total API calls bounded" (M1.5 result rules) — a hard architectural
// cap, not a setting: even if queryVariants ever returns more, an adapter's
// collection loop tries at most this many per round before giving up.
const MAX_VARIANTS_PER_SOURCE = 5;
/**
 * A query variant is DEAD for a source once at least this many of the
 * candidates it produced there have been judged and none was strong: for
 * that source it's off-topic, and re-querying it with a bigger limit would
 * only feed Jev more of the same. Measured live (2026-09-22): a 4-round
 * search across 10 sources that kept descending into 2- and 1-term variants
 * ("pricing", "founders") judged 774 candidates for 6 strong; a 2-round one
 * that stayed on the specific variants judged 169 for 12. Six is a low bar
 * on purpose — cutting an off-topic variant early is worth occasionally
 * retiring a merely average one, since the full query is where the strong
 * material comes from anyway. See collectRound for how it's applied.
 */
export const VARIANT_DEAD_MIN_JUDGED = 6;
/**
 * Hard cap on collect→judge rounds per run (owner direction, 2026-09-22) —
 * with a candidate cap that grows linearly per round, round 4 already
 * asks every source for 4× `scoutCandidatesPerSource`.
 */
export const MAX_ROUNDS = 4;
/**
 * Wall-clock ceiling for the whole run. A new round STARTS only if the time
 * already spent plus a pessimistic estimate of the next round (twice the
 * previous one — candidates double each round, and so does Jev's batch)
 * still fits inside it. Observed live (2026-09-22): with a plain
 * "don't start past 40s" check the final round alone ran 20s+ and the
 * request took 63s — past POST /api/search's `maxDuration = 60`, which
 * would kill it on Vercel. 50s leaves room for the inserts and the
 * response. A round already under way is never cut short.
 */
export const TIME_BUDGET_MS = 50_000;
// Below this many combined kept+skipped examples, taste signal is too thin
// to be worth personalizing rank with — omit `taste` entirely rather than
// pass jev-judge a near-empty {kept: [], skipped: []}.
const MIN_TASTE_EXAMPLES = 3;
const NO_CANDIDATES_NOTE = "no candidates";
/**
 * A search without Jev (no key set): what the free sources found, saved
 * unranked, the sources taken in turn (owner, 2026-09-27: "ok jev
 * opzionale"). The search box says what a key adds.
 */
export const UNRANKED_NOTE = "unranked: TYPESAFE_API_KEY not set";
/** Prefix of the note set when a round's Jev call throws (timeout, network, 5xx after retries) — see runScoutSearch. */
export const JUDGING_FAILED_NOTE_PREFIX = "judging failed";

const defaultFetcher: Fetcher = (url, init) => fetch(url, init);

/** Every adapter but the ones the owner disconnected (Settings' disabledSources). */
export async function connectedAdapters(db: typeof Db): Promise<SourceAdapter[]> {
  const off = new Set(await getSetting(db as never, "disabledSources"));
  return ALL_ADAPTERS.filter((adapter) => !off.has(adapter.name));
}

/**
 * Maps one adapter's `AdapterPost` into the pipeline's source-tagged
 * `SourcePost`, prefixing `id` with the adapter's own name (e.g.
 * "arxiv:12345") — every adapter mints its own ids independently (an
 * arXiv id and a GitHub repo id can otherwise collide once merged into one
 * candidate pool), so the prefix is what keeps them unique across sources
 * once merged. `source` is cast to `SourceName`: true for every real adapter
 * `sources/all.ts` lists; a caller-injected test double may use an arbitrary
 * name (see scout-run.test.ts) — `SourcePost.source` is just a plain string
 * at runtime, so this is a deliberate, narrow widening of the type checker's
 * view rather than a real risk.
 */
export function adapterPostToSourcePost(adapterName: string, post: AdapterPost): SourcePost {
  return {
    id: `${adapterName}:${post.id}`,
    source: adapterName as SourceName,
    url: post.url,
    // Some feeds (HN Algolia, Lobsters) ship HTML entities in plain text (`&#x27;`, `&#x2F;`); decode once, at the source.
    text: decodeEntities(post.text),
    author: post.author,
    ...(post.authorId ? { authorId: post.authorId } : {}),
    metrics: post.metrics,
    createdAt: post.createdAt,
  };
}

type Collected = {
  post: SourcePost;
  /** Which query variant produced this candidate — surfaced as the inserted idea's meta.queryVariant. */
  variant: string;
};

/** What one query variant has yielded for one source so far — the per-(source, variant) bookkeeping behind collectRound's pruning rules. */
type VariantYield = {
  /**
   * Set when a query that didn't fail added no new candidate: the source
   * has nothing more under this variant (a bigger limit next round would
   * re-return the same posts), so it's never queried here again this run —
   * the per-variant twin of SourceState.exhausted. A failed attempt (thrown,
   * or an "error" result) doesn't count and is retried next round, as before.
   */
  drained: boolean;
  /** Judgments received for this variant's candidates here, cumulative across rounds. */
  judged: number;
  /** Of those, the strong ones (isStrong) — `judged >= VARIANT_DEAD_MIN_JUDGED` with 0 of these is what makes a variant dead. */
  strong: number;
};

/** Everything one adapter accumulates over a run's rounds — see runScoutSearch. */
type SourceState = {
  adapter: SourceAdapter;
  status: SourceStatus;
  /** Every candidate collected so far, keyed by SourcePost.id, in collection order. */
  collected: Map<string, Collected>;
  /** Url-dedupe across variants AND rounds — a later round's bigger `limit` re-returns everything an earlier one did. */
  seenUrls: Set<string>;
  /** Jev's judgments for this source's candidates, cumulative across rounds. */
  judgments: PostJudgment[];
  /** Set when a round adds nothing new — or when every variant this source may use is spent (see isSpent): this source has nothing more to give for this query, so it's never queried again this run. */
  exhausted: boolean;
  /** Per query variant, what it has yielded HERE — an entry exists once the variant has been queried for this source (so `.size` is this source's share of ScoutRunSummary.variantsTried). Read by collectRound's pruning rules. */
  variants: Map<string, VariantYield>;
  inserted: number;
  skippedDuplicates: number;
  /** The last error note the source gave (AdapterResult.note). */
  note?: string;
  /** A paid source's reads this run (SourceAdapter.postsPerSearch / finalizePicked). */
  postsRead: number;
  usersRead: number;
};

/**
 * `envReady` is checked once here, same as registry.ts's `runAdapters`: a
 * misconfigured (missing-env) adapter starts out "disabled", is never
 * queried in any round, and reports zero for every count.
 */
function newSourceState(adapter: SourceAdapter, env: NodeJS.ProcessEnv): SourceState {
  return {
    adapter,
    status: envReady(adapter, env) ? "ok" : "disabled",
    collected: new Map(),
    seenUrls: new Set(),
    judgments: [],
    exhausted: false,
    variants: new Map(),
    inserted: 0,
    skippedDuplicates: 0,
    postsRead: 0,
    usersRead: 0,
  };
}

/** The insertion-eligibility rule — non-spam AND at or above the ✦ rank cutoff; strongOf and the per-variant tally in runScoutSearch both apply it. */
function isStrong(j: PostJudgment, minScore: number): boolean {
  return !j.isSpam && j.rank >= minScore;
}

/** The judgments eligible for insertion — see isStrong. */
function strongOf(state: SourceState, minScore: number): PostJudgment[] {
  return state.judgments.filter((j) => isStrong(j, minScore));
}

/** Dead for its source: enough of its candidates judged there, none strong — see VARIANT_DEAD_MIN_JUDGED. */
function isDead(y: VariantYield | undefined): boolean {
  return y !== undefined && y.judged >= VARIANT_DEAD_MIN_JUDGED && y.strong === 0;
}

/** Nothing more to get from this variant for its source: dead, or drained. A variant never queried there is neither — it's still live. */
function isSpent(y: VariantYield | undefined): boolean {
  return y !== undefined && (y.drained || isDead(y));
}

/** One term, split on whitespace — the broad, off-topic-prone tail of queryVariants' output ("pricing", "founders"). */
function isSingleTerm(variant: string): boolean {
  return variant.trim().split(/\s+/).length === 1;
}

/** The variants one source may query at all this run: the first MAX_VARIANTS_PER_SOURCE. */
function usableVariants(variants: string[]): string[] {
  return variants.slice(0, MAX_VARIANTS_PER_SOURCE);
}

/**
 * One round of one adapter's query-variant expansion loop (M1.5 result
 * rules, owner direction 2026-09-21, generalized to every adapter in the
 * seven-adapters wiring): tries `variants` in order — the full derived
 * query, then progressively narrower ones (see lib/query.ts's
 * queryVariants) — accumulating deduped-by-url candidates into `state`
 * until the source holds `cap` of them or variants run out, considering at
 * most `MAX_VARIANTS_PER_SOURCE` variants regardless. `cap` is also the
 * `limit` each adapter call asks for, so a later round (bigger cap) surfaces
 * results an earlier one didn't reach; anything already collected is
 * skipped by url. Returns just the candidates this round added.
 *
 * Pruning (owner direction, 2026-09-22 — see VARIANT_DEAD_MIN_JUDGED for
 * the live numbers): the walk skips any variant that is SPENT for this
 * source — dead (judged enough here, never strong) or drained (a query that
 * didn't fail added nothing new) — and, from round 2 on, treats a
 * single-term variant as a last resort: it's queried only once every
 * multi-term variant is spent, counting the queries they just got this
 * round. Round 1 has nothing judged yet, so it keeps the old behaviour and
 * may fall through to a single-term variant rather than leave the source
 * empty. The bookkeeping lives in `state.variants`: an entry per variant
 * queried here, its `judged`/`strong` filled in by runScoutSearch as
 * judgments land.
 *
 * Each adapter's own `search` already degrades its own request/parse
 * failures to a resolved `{ posts: [], status: "error" }` rather than
 * throwing (see adapter.ts's `errorResult`) — the try/catch below is
 * defense-in-depth on top of that, same spirit as registry.ts's
 * `Promise.allSettled`: one variant attempt throwing marks this adapter
 * "error" but doesn't abandon its remaining variant attempts, and can never
 * fail the whole run (every other adapter collects independently, in
 * parallel — see collectAll).
 *
 * A source billed per post read (X — SourceAdapter.postsPerSearch) is read in
 * round 1 only: its variants are walked while at least `minPerRequest` posts
 * of its budget are left, each call asking for no more than what's left, and
 * everything it returns is kept (it was paid for). An error ends its walk.
 */
async function collectRound(
  state: SourceState,
  variants: string[],
  fetcher: Fetcher,
  env: NodeJS.ProcessEnv,
  cap: number,
  round: number,
): Promise<SourcePost[]> {
  const added: SourcePost[] = [];
  const budget = state.adapter.postsPerSearch?.(env);
  if (budget !== undefined && round > 1) return added;
  const room = budget ?? cap;
  const usable = usableVariants(variants);
  const multiTerm = usable.filter((v) => !isSingleTerm(v));
  for (const variant of usable) {
    if (state.collected.size >= room) break;
    if (isSpent(state.variants.get(variant))) continue;
    if (round > 1 && isSingleTerm(variant) && !multiTerm.every((v) => isSpent(state.variants.get(v)))) continue;
    let limit = cap;
    if (budget !== undefined) {
      const left = budget - state.postsRead;
      if (left < (state.adapter.minPerRequest ?? 1)) break;
      limit = left;
    }
    const yielded = state.variants.get(variant) ?? { drained: false, judged: 0, strong: 0 };
    state.variants.set(variant, yielded);
    let addedByVariant = 0;
    try {
      const result = await state.adapter.search(variant, { fetcher, limit, env });
      if (budget !== undefined) state.postsRead += result.posts.length;
      if (result.status === "error") {
        state.status = "error";
        if (result.note) state.note = result.note;
        if (budget !== undefined) break;
      }
      for (const p of result.posts) {
        if (state.collected.size >= room) break;
        const post = adapterPostToSourcePost(state.adapter.name, p);
        if (state.seenUrls.has(post.url) || state.collected.has(post.id)) continue;
        state.seenUrls.add(post.url);
        state.collected.set(post.id, { post, variant });
        added.push(post);
        addedByVariant++;
      }
      // A variant is only ever queried with room left under the cap, so
      // adding nothing means everything it returned was already collected.
      if (result.status !== "error" && addedByVariant === 0) yielded.drained = true;
    } catch {
      state.status = "error";
    }
  }
  return added;
}

/**
 * Runs `collectRound` for every `active` source in parallel, marks any
 * that added nothing as exhausted, and returns the round's new candidates
 * (in `active` order) — the only ones the round then has Jev judge.
 */
async function collectAll(
  active: SourceState[],
  variants: string[],
  fetcher: Fetcher,
  env: NodeJS.ProcessEnv,
  cap: number,
  round: number,
): Promise<SourcePost[]> {
  const added = await Promise.all(active.map((state) => collectRound(state, variants, fetcher, env, cap, round)));
  const roundCandidates: SourcePost[] = [];
  active.forEach((state, i) => {
    if (added[i].length === 0) state.exhausted = true;
    roundCandidates.push(...added[i]);
  });
  return roundCandidates;
}

/**
 * Runs one scout search inline, in ROUNDS, until it has enough strong
 * matches (owner direction, 2026-09-22 — "at least 20 articles per thing I
 * write, the best ones; if 8 are from HN even better, I want the top across
 * every channel"):
 *
 * Round 1 expands `query` into search-engine-friendly variants (lib/query.ts's
 * queryVariants) and fans them out, per adapter, to every enabled discovery
 * source (sources/all.ts's ALL_ADAPTERS, or an injected list — see
 * RunScoutSearchDeps.adapters) until each holds `candidatesPerSource`
 * candidates; then has Jev judge every candidate's relevance to
 * `judgeTopic`, quality, spam likelihood, and (once the owner has enough
 * kept/dismissed history — see lib/taste.ts; loaded once per run) fit
 * against their taste. A candidate is STRONG when it's non-spam with
 * `rank >= minScore` (`scoutMinScore` — the ✦ number the card shows; a hard
 * cutoff, never a display hint). If the strong ones across ALL sources add
 * up to fewer than `resultsTotal` (`scoutResultsTotal`), another round asks
 * every enabled, not-yet-exhausted source again — same variants, a cap (and
 * adapter `limit`) of `candidatesPerSource × round`, everything already
 * collected skipped by url — and has Jev judge ONLY the new candidates (one
 * judgePosts call per round, all sources together). A source that adds
 * nothing in a round is exhausted and never queried again. Within a source,
 * later rounds skip the variants that have proven dead
 * (VARIANT_DEAD_MIN_JUDGED) or drained and hold single-term variants back
 * until every multi-term one is spent (see collectRound); a source with no
 * live variant left is exhausted right after judging, without an empty
 * round to find that out. Rounds stop when the run has `resultsTotal`
 * strong matches, every source is exhausted, `MAX_ROUNDS` is reached, or
 * the `TIME_BUDGET_MS` clock says not to start another one.
 *
 * Finally it inserts the top `resultsTotal` strong candidates by combined
 * `rank` — ONE pool across all sources, so a source with more strong
 * material takes more slots — as `source: "scout"` ideas (url-deduped by
 * saveIdeaFromInput). Nothing under `minScore` is ever inserted, not even
 * to fill the quota. See docs/specs/2026-09-19-postecho-design.md
 * §11 item 2's "Result rules" (owner direction, 2026-09-21) for the
 * candidate-collection half; the selection rule above supersedes its
 * per-source top-N.
 *
 * Replaces the old enqueue-a-job-for-the-worker flow (M1.5 final design):
 * this runs synchronously inside the caller's own request (POST
 * /api/search, POST /api/scout-now, GET /api/cron/scout), so there is no
 * job/queue involved and no separate worker to poll.
 */
export async function runScoutSearch(
  db: typeof Db,
  input: RunScoutSearchInput,
  deps: RunScoutSearchDeps = {},
): Promise<ScoutRunSummary> {
  const now = deps.now ?? Date.now;
  const startedAt = now();
  const { query, judgeTopic } = input;
  // The sources the owner disconnected in Settings are left out (2026-09-25).
  const adapters = deps.adapters ?? await connectedAdapters(db);
  const fetcher = deps.fetcher ?? defaultFetcher;
  const env = deps.env ?? await scoutEnv(db);

  const [candidatesPerSource, minScore, resultsTotal, findOrder] = await Promise.all([
    deps.candidatesPerSource ?? getSetting(db as never, "scoutCandidatesPerSource"),
    deps.minScore ?? getSetting(db as never, "scoutMinScore"),
    deps.resultsTotal ?? getSetting(db as never, "scoutResultsTotal"),
    getSetting(db as never, "findOrder"),
  ]);
  // What the owner wants first (Settings' order, 2026-09-26), as Jev's weighted kinds.
  const kinds = jevKinds(findOrder);
  const variants = queryVariants(query);
  const usable = usableVariants(variants);
  const states = adapters.map((adapter) => newSourceState(adapter, env));
  const stateByName = new Map(states.map((state) => [state.adapter.name, state]));
  // Which source each judged candidate came from — filled as judgments land, read by the insert step.
  const stateByPostId = new Map<string, SourceState>();
  let rounds = 0;
  const step = (next: SearchStep) => {
    try {
      deps.onStep?.(next);
    } catch {
      // The page following along is a courtesy; the search goes on.
    }
  };

  const summarize = (note?: string): ScoutRunSummary => {
    const perSource: Record<string, PerSourceSummary> = {};
    for (const state of states) {
      perSource[state.adapter.name] = {
        status: state.status,
        candidates: state.collected.size,
        judged: state.judgments.length,
        strong: strongOf(state, minScore).length,
        inserted: state.inserted,
        skippedDuplicates: state.skippedDuplicates,
        deadVariants: [...state.variants.values()].filter(isDead).length,
        ...(state.note ? { note: state.note } : {}),
        ...(state.adapter.postsPerSearch ? { billed: { posts: state.postsRead, users: state.usersRead } } : {}),
      };
    }
    const total = (key: "candidates" | "judged" | "inserted" | "skippedDuplicates") =>
      Object.values(perSource).reduce((n, s) => n + s[key], 0);
    return {
      query,
      candidates: total("candidates"),
      judged: total("judged"),
      inserted: total("inserted"),
      skippedDuplicates: total("skippedDuplicates"),
      rounds,
      minScore,
      resultsTotal,
      variantsTried: states.reduce((n, state) => n + state.variants.size, 0),
      perSource,
      ...(note ? { note } : {}),
    };
  };

  rounds = 1;
  let roundStartedAt = now();
  const searched = states.filter((state) => state.status !== "disabled");
  step({ step: "searching", round: 1, sources: searched.length });
  let roundCandidates = await collectAll(searched, variants, fetcher, env, candidatesPerSource, 1);
  if (roundCandidates.length === 0) return summarize(NO_CANDIDATES_NOTE);

  // A caller-supplied client always wins (tests, and any future caller that
  // wants its own client config); otherwise jevClient() builds one only when a
  // key is set, in the app or on the server: the SDK doesn't check the key
  // up front, so this gate is what keeps judging opt-in.
  const client = deps.jev ?? await jevClient(db);

  // Saving one post the search keeps, judged or not: new, found again (revived or refreshed), counted.
  // The saved discussion-source rows still without a read get their card summary below.
  const toSummarize: IdeaRow[] = [];
  // Every saved row, for the cards' human score after the summaries.
  const savedIds: string[] = [];
  const save = async (state: SourceState, { post, variant }: Collected, judged: Record<string, unknown>) => {
    const meta = {
      ...judged,
      topic: query,
      sourceName: post.source,
      // The source's own id for the post (HN objectID, Lobsters short_id…):
      // lib/deep-read.ts reads the discussion from it at Use time.
      sourceId: post.id,
      metrics: post.metrics,
      queryVariant: variant,
    };
    const saved = await saveIdeaFromInput(db, {
      url: post.url,
      source: "scout",
      meta,
      enriched: { kind: post.source, title: null, content: post.text, author: post.author, meta: {} },
    });
    const found = saved.existing ? await refreshFound(db, saved.idea, meta, post.text) : null;
    const idea = found?.row ?? saved.idea;
    if (saved.existing && !found?.revived) state.skippedDuplicates++;
    else state.inserted++;
    if (isDiscussionKind(idea.kind) && !idea.meta.deepReadAt) toSummarize.push(idea);
    savedIds.push(idea.id);
  };
  const summarizeSaved = async () => {
    // A Hacker News (or Lobsters) card is a bare title: the story's text lives
    // in the article it links to and in its comments. Read those now for the
    // cards that made the pick, so the card shows "title — summary" like every
    // other source and Use has the full text ready (meta.deepReadText). Best
    // effort and bounded: skipped when the rounds spent the time budget.
    if (toSummarize.length > 0 && now() - startedAt < SUMMARY_DEADLINE_MS) {
      step({ step: "summaries", count: toSummarize.length });
      await summarizeCards(db, toSummarize, deps.deepRead ?? readCard);
    }
  };

  if (!client) {
    const picked = inTurn(searched, resultsTotal);
    if (picked.length > 0) step({ step: "saving", count: picked.length });
    await finalizePicked(picked.map(({ post }) => post.id), searched, fetcher, env);
    for (const entry of picked) await save(stateByName.get(entry.post.source)!, entry, { unranked: true });
    await summarizeSaved();
    return summarize(UNRANKED_NOTE);
  }

  // Taste examples from the owner's own kept/dismissed history (lib/taste.ts)
  // personalize Jev's rank via tasteFit — but only once there's enough of
  // them; see MIN_TASTE_EXAMPLES. Loaded once, reused by every round.
  const taste = await loadTasteExamples(db);
  const hasTaste = taste.kept.length + taste.skipped.length >= MIN_TASTE_EXAMPLES;

  // Set when a round's Jev call throws: the run stops collecting, keeps every
  // judgment already made, and still inserts the strong candidates it has —
  // a degraded search is better than a 500. Observed live (2026-09-22): a
  // ~50s network stall timed out every source AND the SDK's own 10s Jev
  // timeout (APITimeoutError, not a 429/529 jev-judge retries), which
  // previously escaped runScoutSearch and failed the whole request.
  let judgingFailedNote: string | undefined;

  while (true) {
    // Only this round's NEW candidates go to Jev — earlier rounds' judgments
    // are already on their SourceState. A later round in which every queried
    // source came back exhausted has nothing to judge.
    if (roundCandidates.length > 0) {
      step({ step: "ranking", round: rounds, posts: roundCandidates.length });
      let judgments: PostJudgment[];
      try {
        judgments = await judgePosts(client, {
          topic: judgeTopic,
          posts: roundCandidates.map((c) => ({ id: c.id, text: c.text, author: c.author ?? undefined, metrics: c.metrics })),
          ...(hasTaste ? { taste } : {}),
          // Content first, inside the owner's area (owner, 2026-09-26): the kinds they
          // rank highest weigh most, and the gate keeps what's off topic out.
          kinds,
          options: { relevanceGate: RELEVANCE_GATE },
        });
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        judgingFailedNote = `${JUDGING_FAILED_NOTE_PREFIX} in round ${rounds}: ${message}`;
        console.error(`runScoutSearch: ${judgingFailedNote}`);
        break;
      }
      const candidateById = new Map(roundCandidates.map((c) => [c.id, c]));
      for (const j of judgments) {
        // Defensive only: judgePosts always echoes back the ids it was given.
        const candidate = candidateById.get(j.id);
        const state = candidate && stateByName.get(candidate.source);
        if (!state) continue;
        state.judgments.push(j);
        stateByPostId.set(j.id, state);
        // The per-variant yield collectRound's dead-variant rule reads.
        const variant = state.collected.get(j.id)?.variant;
        const yielded = variant === undefined ? undefined : state.variants.get(variant);
        if (yielded) {
          yielded.judged++;
          if (isStrong(j, minScore)) yielded.strong++;
        }
      }
    }

    // A source with no live variant left — every one it may use is dead or
    // drained — is exhausted now, not after an empty round: `remaining`
    // below drops it, and once no source is left the loop ends right here.
    for (const state of states) {
      if (usable.every((v) => isSpent(state.variants.get(v)))) state.exhausted = true;
    }

    const strongTotal = states.reduce((n, state) => n + strongOf(state, minScore).length, 0);
    const remaining = states.filter((state) => state.status !== "disabled" && !state.exhausted);
    const t = now();
    const lastRoundMs = t - roundStartedAt;
    const elapsedMs = t - startedAt;
    const nextRoundWouldOverrun = elapsedMs + 2 * lastRoundMs > TIME_BUDGET_MS;
    if (strongTotal >= resultsTotal || remaining.length === 0 || rounds >= MAX_ROUNDS || nextRoundWouldOverrun) break;

    rounds++;
    roundStartedAt = now();
    step({ step: "searching", round: rounds, sources: remaining.length });
    // Geometric growth (12 → 24 → 48 → 96 at the default 12): a broad topic
    // passes the ✦ ≥ 60 bar for only ~7% of candidates (live, 2026-09-22:
    // 12 strong out of 169), so linear growth ran out of time long before
    // the 20-result quota. Stays under Bluesky's hard limit of 100 at the
    // default; sources with a lower API cap simply exhaust earlier.
    roundCandidates = await collectAll(remaining, variants, fetcher, env, candidatesPerSource * 2 ** (rounds - 1), rounds);
  }

  // The global pick: ONE pool across all sources, best rank first,
  // `resultsTotal` deep. Only strong candidates are in it, so a weak one
  // never fills a spare slot.
  const strong = states.flatMap((state) => strongOf(state, minScore));
  const picked = sortByRank(strong).slice(0, resultsTotal);
  if (picked.length > 0) step({ step: "saving", count: picked.length });
  await finalizePicked(picked.map((j) => j.id), states, fetcher, env, stateByPostId);
  for (const j of picked) {
    const state = stateByPostId.get(j.id);
    const entry = state?.collected.get(j.id);
    if (!state || !entry) continue; // Defensive only: every judgment came from a collected candidate.
    await save(state, entry, {
      score: j.relevance,
      quality: j.quality,
      tasteFit: j.tasteFit,
      rank: j.rank,
      // The kind of post Jev read it as (lib/find-kinds.ts); Settings counts Plan's votes by it.
      postKind: j.kind ?? null,
      kindFit: j.kindFit ?? null,
    });
  }
  await summarizeSaved();

  if (savedIds.length > 0 && now() - startedAt < AI_STYLE_DEADLINE_MS) {
    step({ step: "scoring", count: savedIds.length });
    await rateCards(db, client, savedIds, deps.rateAiStyle ?? jevRateAiStyle);
  }

  return summarize(judgingFailedNote);
}

/** The source had cut the card's text (YouTube's search did, with "..."), and this search brought more of it. */
function textWasCut(saved: string | null, fresh: string): boolean {
  return saved !== null && /(\.\.\.|…)\s*$/.test(saved) && fresh.length > saved.length;
}

/**
 * A post this search found again, when it's a Trends card or one a cleared
 * search archived (× on a chip): an archived one comes back to Trends with
 * this search's judgment and topic (owner, 2026-09-27: "ho cancellato la prima
 * search… e quindi non mi prende più dei post che mi aveva già dato?"), and a
 * text the source had cut takes the whole one ("perché non vedo il more
 * qui?") — a summarized discussion card keeps its summary. Dismissed and Liked
 * posts are never touched. Null when there's nothing to change.
 */
async function refreshFound(
  db: typeof Db,
  idea: IdeaRow,
  meta: Record<string, unknown>,
  text: string,
): Promise<{ row: IdeaRow; revived: boolean } | null> {
  const revive = idea.status === "archived";
  const summarized = isDiscussionKind(idea.kind) && Boolean(idea.meta.deepReadAt);
  const refreshText = (revive || idea.status === "new") && !summarized && textWasCut(idea.content, text);
  if (!revive && !refreshText) return null;
  const [row] = await db.update(ideas)
    .set({ ...(revive ? { status: "new" as const, meta: { ...idea.meta, ...meta } } : {}), ...(refreshText ? { content: text } : {}) })
    .where(and(eq(ideas.id, idea.id), inArray(ideas.status, ["new", "archived"])))
    .returning();
  return row ? { row, revived: revive } : null;
}

/**
 * Without Jev, what the search keeps: each source's candidates in the order it
 * gave them, the sources taken in turn so none crowds the others out, up to
 * `total`.
 */
function inTurn(states: SourceState[], total: number): Collected[] {
  const queues = states.map((state) => [...state.collected.values()]);
  const picked: Collected[] = [];
  for (let i = 0; picked.length < total && queues.some((queue) => i < queue.length); i++) {
    for (const queue of queues) {
      if (i < queue.length && picked.length < total) picked.push(queue[i]);
    }
  }
  return picked;
}

/**
 * The lookups a source defers to the posts that made the pick
 * (SourceAdapter.finalizePicked — X's authors, billed per user read): one call
 * per such source, its picked candidates updated in place. Best effort.
 * `ids` are the picked posts' ids; each is found in its source's state.
 */
async function finalizePicked(
  ids: string[],
  states: SourceState[],
  fetcher: Fetcher,
  env: NodeJS.ProcessEnv,
  stateByPostId?: Map<string, SourceState>,
): Promise<void> {
  const bySource = new Map<SourceState, Collected[]>();
  for (const id of ids) {
    const state = stateByPostId?.get(id) ?? states.find((s) => s.collected.has(id));
    const entry = state?.collected.get(id);
    if (!state?.adapter.finalizePicked || !entry) continue;
    bySource.set(state, [...(bySource.get(state) ?? []), entry]);
  }
  await Promise.all([...bySource].map(async ([state, entries]) => {
    try {
      const updated = await state.adapter.finalizePicked!(entries.map((e) => e.post), { fetcher, env });
      const byId = new Map(updated.map((post) => [post.id, post]));
      for (const entry of entries) {
        const post = byId.get(entry.post.id);
        if (post) entry.post = post;
      }
      state.usersRead += new Set(entries.filter((e) => e.post.authorId && e.post.author).map((e) => e.post.authorId)).size;
    } catch (e) {
      console.warn(`[scout] ${state.adapter.name}: finishing the picked posts failed`, e);
    }
  }));
}

/**
 * Jev's AI-style verdict for the saved cards that don't have one yet, read
 * after the summaries so a Hacker News card is judged on its article's
 * opening rather than a bare title; stored as meta.aiStyle, which the card
 * shows as "Human 8/10" (lib/human-score.ts). Best effort: a failed batch
 * leaves the cards unrated and the search's results stand.
 */
async function rateCards(db: typeof Db, client: JevClient, ids: string[], rate: typeof jevRateAiStyle): Promise<void> {
  const rows = (await db.select().from(ideas).where(inArray(ideas.id, ids)))
    .filter((row) => !row.meta.aiStyle && (row.content?.trim().length ?? 0) >= AI_STYLE_MIN_CHARS);
  if (rows.length === 0) return;
  try {
    const ratings = await rate(client, { posts: rows.map((row) => ({ id: row.id, text: row.content! })) });
    const at = new Date().toISOString();
    const byId = new Map(rows.map((row) => [row.id, row]));
    await Promise.all(ratings.map((rating) => {
      const row = byId.get(rating.id);
      if (!row || rating.slopScore === null) return null;
      return db.update(ideas)
        .set({ meta: { ...row.meta, aiStyle: { slopScore: rating.slopScore, verdict: rating.verdict, at } } })
        .where(eq(ideas.id, row.id));
    }));
  } catch (e) {
    console.warn(`[scout] AI-style rating skipped: ${e instanceof Error ? e.message : String(e)}`);
  }
}

async function summarizeCards(db: typeof Db, rows: IdeaRow[], read: typeof readCard): Promise<void> {
  const results = await Promise.allSettled(
    rows.map(async (row) => {
      const got = await read(row, undefined, { timeoutMs: SUMMARY_FETCH_TIMEOUT_MS });
      if (!got) return false;
      await db.update(ideas).set(deepReadPatch(row, got)).where(eq(ideas.id, row.id));
      return true;
    }),
  );
  const done = results.filter((r) => r.status === "fulfilled" && r.value).length;
  const failed = results.filter((r) => r.status === "rejected");
  if (failed.length > 0) {
    const reasons = failed.map((r) => (r.reason instanceof Error ? r.reason.message : String(r.reason))).join("; ");
    console.warn(`[scout] card summaries: ${done}/${rows.length} read, ${failed.length} failed — ${reasons}`);
  }
}
