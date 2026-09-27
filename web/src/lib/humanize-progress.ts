/**
 * The Claude <-> Jev humanize loop as the web app sees it (M3.6 — owner,
 * 2026-09-23: "aggiungi il loop anche qui tra jev e claude quando clicco
 * humanize"). The loop is jev-judge's humanize(), run by the Mac agent
 * (agent/src/handlers.ts's humanizeLoop): Claude rewrites, Jev scores, and
 * while Jev doesn't read it as human Claude tries again with that score, at
 * most three rounds. While it runs, the agent posts each phase to POST
 * /api/agent/jobs/:id/progress, which keeps it on the job as
 * `result.progress`; Write's editor (a revise_draft in humanize mode) reads
 * it through here.
 */

export type HumanizeRound = { round: number; slopScore: number | null; verdict: string | null };
export type HumanizeProgress = {
  round: number;
  maxRounds: number;
  phase: "rewriting" | "checking";
  rounds: HumanizeRound[];
  /** Which platform a two-platform Humanize (Write's chat) is on; null for one text. */
  platform: "x" | "linkedin" | null;
};

import { humanText, humanTrail } from "@/lib/human-score";

type JobLike = { status: string; result: Record<string, unknown> | null };

function roundsOf(value: unknown): HumanizeRound[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((r) => {
    const round = r as { round?: unknown; slopScore?: unknown; verdict?: unknown } | null;
    if (!round || typeof round.round !== "number") return [];
    return [{
      round: round.round,
      slopScore: typeof round.slopScore === "number" ? round.slopScore : null,
      verdict: typeof round.verdict === "string" ? round.verdict : null,
    }];
  });
}

/** The live progress a claimed Humanize carries, or null (queued, settled, or an agent that doesn't report it). */
export function humanizeProgressOf(job: JobLike): HumanizeProgress | null {
  if (job.status !== "claimed") return null;
  const p = job.result?.progress as Record<string, unknown> | undefined;
  if (!p || p.kind !== "humanize" || typeof p.round !== "number" || typeof p.maxRounds !== "number") return null;
  return {
    round: p.round,
    maxRounds: p.maxRounds,
    phase: p.phase === "checking" ? "checking" : "rewriting",
    rounds: roundsOf(p.rounds),
    platform: p.platform === "x" || p.platform === "linkedin" ? p.platform : null,
  };
}

/**
 * What the Humanize is doing right now, in words — null once the job has
 * settled. `what` names the text being rewritten ("it", "the X text").
 */
export function humanizePhaseText(job: JobLike, what = "it"): string | null {
  if (job.status === "queued") return "Waiting for your Mac agent to pick this up…";
  if (job.status !== "claimed") return null;
  const p = humanizeProgressOf(job);
  if (!p) {
    const edit = editProgressOf(job);
    if (edit) return edit.phase === "checking" ? "PostEcho is checking the new version…" : EDIT_REWRITING[edit.mode] ?? "PostEcho is rewriting the post…";
    return `PostEcho is rewriting ${what} to sound like a person…`;
  }
  const platform = p.platform ? `${p.platform === "x" ? "X" : "LinkedIn"} · ` : "";
  const prefix = `${platform}Round ${p.round} of ${p.maxRounds}`;
  if (p.phase === "checking") return `${prefix} · PostEcho is checking the rewrite…`;
  const last = p.rounds.at(-1);
  if (p.round > 1 && last?.slopScore != null) {
    return `${prefix} · The last try read ${humanText(last.slopScore)}, so PostEcho is trying again…`;
  }
  return `${prefix} · PostEcho is rewriting ${p.platform ? "it" : what}…`;
}

/** What a chat edit (Write's Edit with Claude, M3.7) is doing, from its progress report. */
const EDIT_REWRITING: Record<string, string> = {
  custom: "PostEcho is rewriting the post…",
  sync_linkedin: "PostEcho is rewriting LinkedIn from your X, with the source for detail…",
  sync_x: "PostEcho is writing the X version from your LinkedIn…",
  voice: "PostEcho is rewriting the post in the new voice…",
};

export function editProgressOf(job: JobLike): { mode: string; phase: "rewriting" | "checking" } | null {
  if (job.status !== "claimed") return null;
  const p = job.result?.progress as Record<string, unknown> | undefined;
  if (!p || p.kind !== "edit" || typeof p.mode !== "string") return null;
  return { mode: p.mode, phase: p.phase === "checking" ? "checking" : "rewriting" };
}

/**
 * The rounds' scores so far as human scores (lib/human-score.ts): "3 → 4 → 8"
 * (a round Jev couldn't score reads "?"). Empty when there is nothing to show
 * yet.
 */
export function scoreTrail(rounds: HumanizeRound[]): string {
  if (rounds.length === 0) return "";
  return humanTrail(rounds.map((r) => r.slopScore));
}
