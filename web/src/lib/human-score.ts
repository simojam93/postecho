/**
 * Jev's AI-style verdict as the owner reads it (2026-09-24: "lo vorrei più
 * chiaro e su base dieci. tipo human 7/10"): how human a text reads, 0 to 10,
 * higher is better — like ✦ rank next to it on a card. jev-judge's checkSlop
 * scores the opposite way (slopScore 0-100, higher = more LLM fingerprints),
 * so human = round((100 - slopScore) / 10). The word follows the number, so
 * the two never disagree: Human 7-10, Mixed 4-6, AI 0-3.
 */
export type HumanLabel = "Human" | "Mixed" | "AI";
export type HumanTone = "ok" | "dim" | "danger";

/** 0-10, from jev-judge's 0-100 slopScore. */
export function humanScore(slopScore: number): number {
  return Math.max(0, Math.min(10, Math.round((100 - slopScore) / 10)));
}

export function humanLabel(score: number): HumanLabel {
  return score >= 7 ? "Human" : score >= 4 ? "Mixed" : "AI";
}

export const HUMAN_TONE: Record<HumanLabel, HumanTone> = { Human: "ok", Mixed: "dim", AI: "danger" };

/** "Human 8/10" for a slopScore. */
export function humanText(slopScore: number): string {
  const score = humanScore(slopScore);
  return `${humanLabel(score)} ${score}/10`;
}

/** The scores in order as human scores — "3 → 5 → 8"; a text Jev couldn't score reads "?". */
export function humanTrail(slopScores: Array<number | null>): string {
  return slopScores.map((s) => (s === null ? "?" : String(humanScore(s)))).join(" → ");
}

/** The score in one sentence: the app's tooltip on every Human/Mixed/AI badge (2026-09-27: "mai più di una frase"). */
export const HUMAN_SCORE_TIP = "How human it reads: 10 is a person, 0 is AI prose.";

/** What the number means, in full. */
export const HUMAN_SCORE_HELP =
  "How human it reads: 10 is clearly a person, 0 is textbook LLM prose. " +
  "PostEcho looks for perfectly balanced clauses, \"not X, but Y\", things in threes, em-dash asides, a tidy last line and no looseness anywhere. " +
  "7 and up reads human, 3 and below reads like AI.";
