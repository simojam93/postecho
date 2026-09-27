import { HUMAN_SCORE_TIP, HUMAN_TONE, humanLabel, humanScore } from "@/lib/human-score";

/**
 * Minimal, structurally-typed shape SlopBadge needs — matches both a live
 * `POST /api/slop-check` result (jev-judge's fuller `SlopCheck`, which is a
 * superset) and a draft's persisted `meta.slop` / `meta.slopByPlatform`
 * entry (see lib/slop.ts's runSlopCheck), so the editor can render either
 * without importing jev-judge's type here too.
 */
export type SlopResult = { verdict: string; slopScore: number };

const TONE_CLASS = { ok: "text-ok", dim: "text-text-dim", danger: "text-danger" } as const;

/**
 * "Human 8/10" — Jev's verdict as the owner asked for it (2026-09-24: "più
 * chiaro e su base dieci"): how human the text reads, 0-10, higher is better,
 * the word following the number (lib/human-score.ts). Renders nothing when
 * there's no result yet. `compact`: the height of the ✦ pill beside it on a
 * Find Ideas card, so the badge never makes one card taller than the rest.
 */
export function SlopBadge({ slop, compact = false }: { slop: SlopResult | null; compact?: boolean }) {
  if (!slop) return null;
  const score = humanScore(slop.slopScore);
  const label = humanLabel(score);
  return (
    <span
      data-tip={HUMAN_SCORE_TIP}
      className={`whitespace-nowrap rounded-full border border-border px-2 ${compact ? "" : "py-0.5 "}text-xs tabular-nums ${TONE_CLASS[HUMAN_TONE[label]]}`}
    >
      {label} {score}/10
    </span>
  );
}
