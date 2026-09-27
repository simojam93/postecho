import type { PostKind } from "jev-judge";

/**
 * The kinds of post Find Ideas tells apart (owner, 2026-09-26: the ones that do well are a
 * real story with numbers and a strong opinion — "quello su pricing per seat che ho messo su
 * linkedin è esploso" — then practical problems). The owner orders them in Settings ("vuoi
 * rendere ordinabili l'importanza di queste… così sono prioritizzate?"); position is
 * priority, a push rather than a strict sort. Names and examples are what Settings shows;
 * descriptions are what Jev reads. None of it is shown on the cards.
 */
export const FIND_KINDS = [
  {
    id: "story", name: "Real stories with numbers", example: "How I got to 1,000 users in 3 months",
    description: "A first-hand story with concrete numbers: revenue, users, growth, costs, a before and after.",
  },
  {
    id: "opinion", name: "Strong opinions", example: "Per-seat pricing is dead",
    description: "A strong, arguable opinion or prediction that people will agree or disagree with.",
  },
  {
    id: "problem", name: "Practical problems", example: "My AI assistant keeps bringing back a bug I fixed",
    description: "A practical problem, question or pain someone has, that invites an answer or a how-to.",
  },
  {
    id: "news", name: "News and launches", example: "Company X releases version 2",
    description: "An announcement, a launch, a release, a funding round or other news.",
  },
  // For other people once PostEcho is open source: some want repos and tutorials.
  {
    id: "tool", name: "Tools and guides", example: "A new open source repo, a tutorial, a list",
    description: "A tool, library or repo, a tutorial, a guide or a curated list.",
  },
] as const;

export type FindKindId = (typeof FIND_KINDS)[number]["id"];
export const FIND_KIND_IDS: FindKindId[] = FIND_KINDS.map((kind) => kind.id);
export const DEFAULT_FIND_ORDER: FindKindId[] = [...FIND_KIND_IDS];

/** Jev's catch-all, never shown: a joke or a bare link barely moves up. */
const OTHER_KIND: PostKind = {
  label: "other",
  description: "None of the above: a joke, a meme, a bare link, an empty or off-format post.",
  weight: 0.15,
};

/**
 * Find Ideas' relevance gate (jev-judge's options.relevanceGate), lenient on purpose: Jev
 * measures relevance against the search's own words, not the owner's whole area ("se parlo di
 * agenti starò anche parlando di AI"). Relevance is an expected value over Jev's five levels
 * (0, 25, 50, 75, 100): off topic (under 10) sinks, "tangentially related" (25) keeps 60% of
 * its rank, and from 35 up the topic no longer holds a post back. Calibrated 2026-09-26 on the
 * 128 saved ideas: a 20–50 gate buried the owner's own used ideas when judged against a
 * search's narrower topic.
 */
export const RELEVANCE_GATE = { floor: 10, full: 35 } as const;

/**
 * Position → weight. The first three stay close (the owner likes all of stories, opinions and
 * problems — "A e D smuovono di più… però a me piacciono anche A e B"), the last two drop well
 * below. Calibrated 2026-09-26: a straight 0.2 step pushed the third kind as far down as news.
 */
const POSITION_WEIGHTS = [1, 0.9, 0.8, 0.5, 0.3];

export function weightAt(position: number): number {
  return POSITION_WEIGHTS[Math.min(Math.max(position, 0), POSITION_WEIGHTS.length - 1)];
}

export function isFindKindId(value: unknown): value is FindKindId {
  return typeof value === "string" && (FIND_KIND_IDS as string[]).includes(value);
}

/** A valid order from whatever is stored: known ids in their stored order, once each, then the missing ones in default order. */
export function normalizeOrder(stored: unknown): FindKindId[] {
  const order = new Set<FindKindId>();
  if (Array.isArray(stored)) for (const id of stored) if (isFindKindId(id)) order.add(id);
  for (const id of DEFAULT_FIND_ORDER) order.add(id);
  return [...order];
}

/** The owner's order as jev-judge's kinds: each described and weighted by its position, the catch-all last. */
export function jevKinds(order: unknown): PostKind[] {
  const byId = new Map(FIND_KINDS.map((kind) => [kind.id, kind]));
  return [
    ...normalizeOrder(order).map((id, i) => ({ label: id, description: byId.get(id)!.description, weight: weightAt(i) })),
    OTHER_KIND,
  ];
}

/** Moves the kind at `from` to `to` (clamped into the list): Settings' drag and its arrows. A new array. */
export function moveKind(order: FindKindId[], from: number, to: number): FindKindId[] {
  const next = [...order];
  if (from < 0 || from >= next.length) return next;
  const [moved] = next.splice(from, 1);
  next.splice(Math.max(0, Math.min(next.length, to)), 0, moved);
  return next;
}
