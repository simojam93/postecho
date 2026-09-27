/**
 * Never more than three takes per post (owner, 2026-09-24: "non farmi mai più
 * di 3 takes, tienimi le migliori con un check di Jev"). Pure — the Write page
 * (components/write/post-state.ts's takesOf) and the server (lib/materialize.ts,
 * which discards the rest when new takes land; lib/drafts.ts's count) share it.
 *
 * A take is a LINE: a draft Claude wrote for the post, with every version made
 * from it since (edits, Humanize, restores — the editor's version chain). A
 * card shows the line's chosen version when it holds the chosen one, else its
 * newest. Lines rank by Jev's human score of the text the card previews (X,
 * else LinkedIn): most human first; one not scored yet counts as a middling 50;
 * the newer wins a tie. The chosen line always stays, whatever its score.
 */
export const MAX_TAKES = 3;

/** Jev's slopScore an unscored take is ranked with: "Mixed", neither kept over a known good take nor dropped under a known bad one. */
const UNSCORED = 50;
const VISIBLE = new Set(["candidate", "kept"]);

export type TakeDraftLike = {
  id: string;
  parentId: string | null;
  status: string;
  xText: string | null;
  linkedinText: string | null;
  meta: Record<string, unknown>;
  createdAt: string | Date;
};

export type TakeLine<T extends TakeDraftLike> = {
  /** The line's first draft — the take as Claude wrote it. */
  rootId: string;
  /** The line's candidate/kept versions. */
  drafts: T[];
  /** The version its card shows. */
  shown: T;
  /** Jev's slopScore for the shown text (0 = human, 100 = AI), null when not scored yet. */
  score: number | null;
};

function ms(date: string | Date): number {
  return new Date(date).getTime();
}

/** Jev's slopScore for the text a take card previews: X, else LinkedIn — its own score, else the draft's single one. */
export function takeSlopScore(draft: TakeDraftLike): number | null {
  const platform = draft.xText?.trim() ? "x" : draft.linkedinText?.trim() ? "linkedin" : null;
  if (!platform) return null;
  const byPlatform = draft.meta.slopByPlatform as Record<string, { slopScore?: unknown } | undefined> | undefined;
  const own = byPlatform?.[platform]?.slopScore;
  if (typeof own === "number") return own;
  const single = (draft.meta.slop as { slopScore?: unknown } | undefined)?.slopScore;
  return typeof single === "number" ? single : null;
}

/** The post's take lines (unordered), from every draft of the post — any status, so a line survives a discarded version. */
export function takeLines<T extends TakeDraftLike>(drafts: T[], chosenId: string | null): TakeLine<T>[] {
  const byId = new Map(drafts.map((d) => [d.id, d]));
  const rootOf = (draft: T): string => {
    let current = draft;
    const seen = new Set([draft.id]);
    while (current.parentId) {
      const parent = byId.get(current.parentId);
      if (!parent || seen.has(parent.id)) break;
      seen.add(parent.id);
      current = parent;
    }
    return current.id;
  };
  const lines = new Map<string, T[]>();
  for (const draft of drafts) {
    if (!VISIBLE.has(draft.status)) continue;
    const root = rootOf(draft);
    lines.set(root, [...(lines.get(root) ?? []), draft]);
  }
  return [...lines].map(([rootId, versions]) => {
    const newest = versions.reduce((a, b) => (ms(b.createdAt) > ms(a.createdAt) || (ms(b.createdAt) === ms(a.createdAt) && b.id > a.id) ? b : a));
    const shown = versions.find((v) => v.id === chosenId) ?? newest;
    return { rootId, drafts: versions, shown, score: takeSlopScore(shown) };
  });
}

/** Most human first; unscored as UNSCORED; the newer shown version first on a tie. */
export function rankLines<T extends TakeDraftLike>(lines: TakeLine<T>[]): TakeLine<T>[] {
  return [...lines].sort((a, b) =>
    (a.score ?? UNSCORED) - (b.score ?? UNSCORED)
    || ms(b.shown.createdAt) - ms(a.shown.createdAt)
    || a.rootId.localeCompare(b.rootId));
}

/** What the post keeps — the chosen line plus the most human others, `max` in all, best first — and what goes. */
export function keptTakes<T extends TakeDraftLike>(drafts: T[], chosenId: string | null, max: number = MAX_TAKES): { keep: TakeLine<T>[]; drop: TakeLine<T>[] } {
  const ranked = rankLines(takeLines(drafts, chosenId));
  const chosen = chosenId ? ranked.find((line) => line.drafts.some((d) => d.id === chosenId)) : undefined;
  const others = ranked.filter((line) => line !== chosen);
  const room = Math.max(0, max - (chosen ? 1 : 0));
  return {
    keep: rankLines([...(chosen ? [chosen] : []), ...others.slice(0, room)]),
    drop: others.slice(room),
  };
}
