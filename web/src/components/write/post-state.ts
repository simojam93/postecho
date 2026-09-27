import { decodeEntities } from "@/lib/enrich";
import { keptTakes, MAX_TAKES } from "@/lib/takes";
import type { SlopResult } from "@/components/slop-badge";
import type { WorkStep } from "@/components/work-progress";
import type { Draft, JobInfo, Platform } from "./types";

/**
 * Pure helpers behind the Write page's status dance (M2.5 plan, task W3) —
 * no React, no fetch — so the pick/revision rules are unit-testable and stay
 * in one place. The two rules mirrored from the server are called out below.
 */

/** A generation job the agent hasn't finished yet — see db/schema.ts's jobStatus. */
export function isInFlight(status: string | null | undefined): boolean {
  return status === "queued" || status === "claimed";
}

function time(iso: string): number {
  return new Date(iso).getTime();
}

/**
 * The takes row (owner, 2026-09-24: "non farmi mai più di 3 takes, tienimi le
 * migliori con un check di Jev"): at most three, most human first — one card
 * per take, showing the chosen version when the take holds it, else its
 * newest one (lib/takes.ts, the rule the server prunes by). The chosen take
 * always has its card. Discarded takes are hidden; used ones are published.
 */
export function takesOf(drafts: Draft[]): Draft[] {
  return keptTakes(drafts, chosenOf(drafts)?.id ?? null).keep.map((line) => line.shown);
}

/**
 * The chosen take — the SAME rule as lib/drafts.ts's chosenDraftId: the kept
 * draft with the newest updatedAt (createdAt, then id, as tiebreaks). At
 * most one draft is kept at rest; two only exist mid-pick, because picking
 * keeps the new take before demoting the previous one (see pickTake in
 * app/(authed)/create/page.tsx), and a Refine lands its revision as kept
 * before the take it replaced is demoted — in both cases the most recently
 * updated one is the one the owner meant.
 */
export function chosenOf(drafts: Draft[]): Draft | null {
  let best: Draft | null = null;
  for (const d of drafts) {
    if (d.status !== "kept") continue;
    if (!best || isNewer(d, best)) best = d;
  }
  return best;
}

function isNewer(a: Draft, b: Draft): boolean {
  const byUpdated = time(a.updatedAt) - time(b.updatedAt);
  if (byUpdated !== 0) return byUpdated > 0;
  const byCreated = time(a.createdAt) - time(b.createdAt);
  if (byCreated !== 0) return byCreated > 0;
  return a.id.localeCompare(b.id) > 0;
}

/**
 * The revision chain root → `draft`, following parentId through the loaded
 * drafts (any status — a superseded version may be a candidate again, or
 * discarded). Stops at a parent that isn't loaded; cycle-safe.
 */
export function versionChain(draft: Draft, drafts: Draft[]): Draft[] {
  const byId = new Map(drafts.map((d) => [d.id, d]));
  byId.set(draft.id, draft);
  const upward: Draft[] = [];
  const seen = new Set<string>();
  let cur: Draft | undefined = draft;
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    upward.push(cur);
    cur = cur.parentId ? byId.get(cur.parentId) : undefined;
  }
  return upward.reverse();
}

/** A failed job's `result.error`, when the agent left one. */
export function jobError(job: JobInfo | null | undefined): string | undefined {
  const message = job?.result?.error;
  return typeof message === "string" ? message : undefined;
}

/**
 * The agent's TranscriptUnavailable message (agent/src/transcript.ts)
 * contains "transcript" — a loose substring match is robust to its exact
 * wording changing. Same test the Videos card's old Generate posts panel used.
 */
export function looksLikeTranscriptError(error: string | undefined): boolean {
  return typeof error === "string" && error.toLowerCase().includes("transcript");
}

const LABEL_MAX = 70;

/**
 * Chip label for the in-progress strip: the idea's title, else the first
 * line of its content (scouted posts have no title — see lib/scout-run.ts),
 * else its url; clamped with an ellipsis.
 */
export function ideaLabel(
  idea: { title: string | null; url: string | null; content?: string | null } | null,
): string {
  if (!idea) return "Untitled";
  const excerpt = idea.content?.replace(/\s+/g, " ").trim() || null;
  const raw = (idea.title?.trim() || excerpt || idea.url || "Untitled");
  const text = decodeEntities(raw);
  return text.length > LABEL_MAX ? `${text.slice(0, LABEL_MAX - 1).trimEnd()}…` : text;
}

// ---------------------------------------------------------------------------
// Generation progress (M3.5 plan, task U2 — "se no sembra rotto")
// ---------------------------------------------------------------------------

/** `m:ss` for the elapsed counter; a negative span (clock skew) reads 0:00. */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

// The routes' own defaults when the caller sends no `count`: POST
// /api/drafts/from-idea (also what Write's New takes asks for) and POST
// /api/videos — the honest number when the job's payload isn't in view.
const DEFAULT_TAKE_COUNT = MAX_TAKES;
const DEFAULT_VIDEO_POST_COUNT = MAX_TAKES;

/** How many drafts the job was asked for: `payload.count` when present, else the enqueueing route's default. */
export function takeCountOf(job: Pick<JobInfo, "kind" | "payload">): number {
  const count = job.payload?.count;
  if (typeof count === "number" && Number.isInteger(count) && count > 0) return count;
  return job.kind === "generate_from_video" ? DEFAULT_VIDEO_POST_COUNT : DEFAULT_TAKE_COUNT;
}

/**
 * Writing takes, step by step, as the job tells it (owner, 2026-09-27: "lo
 * dividerei a step quando questi succedono"): waiting for the Mac while
 * queued; then reading the source and writing, with the agent reporting
 * each phase (agent/src/handlers.ts's reportGenerate); then keeping the most
 * human, when Jev picks among a few more than asked. Empty once it's settled.
 */
export function generationSteps(job: Pick<JobInfo, "kind" | "status" | "payload"> & { result?: JobInfo["result"] }): WorkStep[] {
  if (job.status === "queued") return [{ label: "Waiting for your Mac", done: false }];
  if (job.status !== "claimed") return [];
  const n = takeCountOf(job);
  const takes = `${n} ${n === 1 ? "take" : "takes"}`;
  const steps: WorkStep[] = [{ label: "Your Mac picked it up", done: true }];
  const progress = job.result?.progress as { kind?: unknown; phase?: unknown } | undefined;
  if (progress?.kind === "generate" && progress.phase === "checking") {
    steps.push({ label: "Wrote the takes", done: true }, { label: `Checking how human each one reads, to keep the ${n} best`, done: false });
  } else {
    steps.push({ label: job.kind === "generate_from_video" ? `Writing ${takes} from the whole video` : `Writing ${takes}`, done: false });
  }
  return steps;
}

/** The agent heartbeats every 60 s (agent/src/main.ts) — three missed ones and it's presumed off. */
export const AGENT_OFFLINE_AFTER_MS = 3 * 60_000;

/**
 * "Your Mac agent looks offline": no heartbeat ever (`null`), or the last
 * one (Settings' agentLastHeartbeatAt) older than AGENT_OFFLINE_AFTER_MS.
 * `undefined` means the settings haven't loaded yet — never a verdict.
 */
export function agentLooksOffline(heartbeatAt: string | null | undefined, nowMs: number): boolean {
  if (heartbeatAt === undefined) return false;
  if (heartbeatAt === null) return true;
  return nowMs - time(heartbeatAt) > AGENT_OFFLINE_AFTER_MS;
}

// ---------------------------------------------------------------------------
// AI-style per take + Humanize (M3.5 plan, task U2)
// ---------------------------------------------------------------------------

export const PLATFORM_LABEL: Record<Platform, string> = { x: "X", linkedin: "LinkedIn" };

/** A draft's persisted slop-check result (lib/slop.ts's runSlopCheck), with the platform it was scored for. */
export type PersistedSlop = SlopResult & { platform: string };

/** The slop-check result POST /api/slop-check persisted on the draft's `meta.slop`, if any. */
export function slopOf(draft: Draft): PersistedSlop | null {
  const slop = draft.meta.slop as { platform?: unknown; verdict?: unknown; slopScore?: unknown } | undefined;
  if (!slop || typeof slop.verdict !== "string" || typeof slop.slopScore !== "number") return null;
  return { verdict: slop.verdict, slopScore: slop.slopScore, platform: typeof slop.platform === "string" ? slop.platform : "generic" };
}

/**
 * Jev's score for one platform's text: meta.slopByPlatform (M3.7 — every
 * edit, check and humanize records it per platform), else the single
 * meta.slop when it was scored for that platform.
 */
export function slopFor(draft: Draft, platform: Platform): SlopResult | null {
  const byPlatform = draft.meta.slopByPlatform as Record<string, { verdict?: unknown; slopScore?: unknown }> | undefined;
  const own = byPlatform?.[platform];
  if (own && typeof own.verdict === "string" && typeof own.slopScore === "number") {
    return { verdict: own.verdict, slopScore: own.slopScore };
  }
  const slop = slopOf(draft);
  return slop && slop.platform === platform ? { verdict: slop.verdict, slopScore: slop.slopScore } : null;
}

/** The persisted result for `platform` — the editor's per-platform badges. */
export function persistedSlop(draft: Draft, platform: Platform): SlopResult | null {
  return slopFor(draft, platform);
}

export type SlopCheckTarget = { draftId: string; platform: Platform; text: string };

/**
 * What a take card scores: its X text, or the LinkedIn text when there is
 * no X version — the same text the card previews. Null for an empty take.
 */
export function slopCheckTarget(take: Draft): SlopCheckTarget | null {
  if (take.xText?.trim()) return { draftId: take.id, platform: "x", text: take.xText };
  if (take.linkedinText?.trim()) return { draftId: take.id, platform: "linkedin", text: take.linkedinText };
  return null;
}

/**
 * The next take to score, in row order — the first with no persisted result
 * that hasn't been attempted this session. A take with `meta.slop` is never
 * re-checked here (whatever platform it was scored for: the editor's manual
 * Slop check may have scored the other one, and meta.slop holds one result),
 * and `attempted` keeps a failed check from being retried in a loop.
 */
export function nextSlopCheck(takes: Draft[], attempted: ReadonlySet<string>): SlopCheckTarget | null {
  for (const take of takes) {
    if (attempted.has(take.id) || slopOf(take)) continue;
    const target = slopCheckTarget(take);
    if (target) return target;
  }
  return null;
}

/**
 * The fixed anti-fingerprint instruction behind **Humanize** — a revise_draft
 * job like Refine, with the platform substituted (owner request 2026-09-23:
 * "vorrei un tasto humanize"). Must stay under POST /api/drafts/:id/revise's
 * 500-character cap on `instruction`.
 */
export function humanizeInstruction(platform: Platform): string {
  const label = PLATFORM_LABEL[platform];
  return `Rewrite the ${label} text so it reads like a specific person wrote it: uneven sentence lengths, allow one fragment, no balanced three-part lists, no em-dash asides, no "not X, but Y", no tidy summarizing last line, no hook like "Here's the thing". Keep the facts, the point and roughly the same length. Change only the ${label} text.`;
}
