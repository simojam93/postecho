import { and, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { learnFromChoices, STYLE_TRAITS, type JevClient, type StyleChoice, type StyleLesson } from "jev-judge";
import type { db as Db } from "@/db";
import { drafts, jobs, scheduledPosts } from "@/db/schema";
import { getSetting, setSetting } from "@/lib/settings";
import { getSlopClient } from "@/lib/slop";

/**
 * Learning from the owner's choices (2026-09-27: "il lavoro settimanale
 * 'impara dai post che tieni' per la style guide… lo voglio per l'open
 * source"). The learning itself is jev-judge's learnFromChoices, reusable
 * beyond PostEcho; this module feeds it and keeps its cadence.
 *
 * Every post with a chosen take is a few choices. The chosen version was
 * kept: a star counts double, and so does a post that did well in Calendar,
 * while one that didn't land counts as dropped. Every other take of that post
 * was dropped, unless PostEcho itself dropped it for reading as AI before
 * the owner chose (meta.trimmed); a starred one was kept. At most once a
 * week, when there are about 15 new choices, the agent's heartbeat has
 * jev-judge read what tells the two apart, and a learn_style job asks Claude
 * to turn it into a change to the style guide. The change waits in
 * Settings › Voice until the owner applies or dismisses it ("Proposes, you
 * approve").
 */

export const LEARN_AFTER_NEW_CHOICES = 15;
const DAY_MS = 24 * 60 * 60 * 1000;
export const LEARN_EVERY_MS = 7 * DAY_MS;
/** The heartbeat asks every minute or so; the answer changes at most daily. */
const CHECK_EVERY_MS = DAY_MS;
/** The most recently decided posts: enough to see a pattern, recent enough to be the owner's voice now. */
const MAX_POSTS = 60;
/** Fewer kept or dropped than this and there's nothing to contrast. */
const MIN_EACH_SIDE = 5;
const MAX_EDITS = 8;
const EDIT_MAX_CHARS = 200;
/** Edit requests read, newest first, to find the ones asked most. */
const EDIT_JOBS_READ = 100;
const MAX_EXAMPLES = 3;
const EXAMPLE_MAX_CHARS = 600;

/** A change to the style guide that Claude proposed from the owner's choices. */
export type StyleProposal = {
  guide: string;
  changes: Array<{ summary: string; reason: string }>;
  lessons: StyleLesson[];
  /** How many choices it learned from. */
  basedOn: number;
  createdAt: string;
};

/** A choice, and when it was made: the chosen version's last touch, or the Calendar vote. */
export type TimedChoice = StyleChoice & { at: Date };

type DraftRow = typeof drafts.$inferSelect;

function textOf(draft: DraftRow): string {
  return draft.xText?.trim() || draft.linkedinText?.trim() || "";
}

/** Newest first by `field`, then by creation, then by id: the rule lib/drafts.ts and materialize.ts pick the chosen take with. */
function newest(rows: DraftRow[], field: "updatedAt" | "createdAt"): DraftRow | undefined {
  return [...rows].sort((a, b) =>
    b[field].getTime() - a[field].getTime() || b.createdAt.getTime() - a.createdAt.getTime() || b.id.localeCompare(a.id))[0];
}

/** A post's takes: each draft grouped under the first version of its line (lib/takes.ts's lines). */
function linesOf(rows: DraftRow[]): DraftRow[][] {
  const byId = new Map(rows.map((row) => [row.id, row]));
  const lines = new Map<string, DraftRow[]>();
  for (const row of rows) {
    let root = row;
    const seen = new Set([row.id]);
    while (root.parentId) {
      const parent = byId.get(root.parentId);
      if (!parent || seen.has(parent.id)) break;
      seen.add(parent.id);
      root = parent;
    }
    lines.set(root.id, [...(lines.get(root.id) ?? []), row]);
  }
  return [...lines.values()];
}

/** The owner's choices over the most recently decided posts, as jev-judge's learnFromChoices reads them. */
export async function loadStyleChoices(db: typeof Db): Promise<TimedChoice[]> {
  const picked = await db
    .select({ ideaId: drafts.ideaId })
    .from(drafts)
    .where(and(inArray(drafts.status, ["kept", "used"]), isNotNull(drafts.ideaId)))
    .orderBy(desc(drafts.updatedAt))
    .limit(MAX_POSTS * 5);
  const ideaIds = [...new Set(picked.map((row) => row.ideaId!))].slice(0, MAX_POSTS);
  if (ideaIds.length === 0) return [];

  const rows = await db.select().from(drafts).where(inArray(drafts.ideaId, ideaIds));
  const votes = await db
    .select({ draftId: scheduledPosts.draftId, outcome: scheduledPosts.outcome, ratedAt: scheduledPosts.ratedAt })
    .from(scheduledPosts)
    .where(and(inArray(scheduledPosts.draftId, rows.map((row) => row.id)), isNotNull(scheduledPosts.outcome), isNotNull(scheduledPosts.ratedAt)));
  const votesOf = new Map<string, Array<{ outcome: string; ratedAt: Date }>>();
  for (const vote of votes) votesOf.set(vote.draftId, [...(votesOf.get(vote.draftId) ?? []), { outcome: vote.outcome!, ratedAt: vote.ratedAt! }]);

  const byIdea = new Map<string, DraftRow[]>();
  for (const row of rows) byIdea.set(row.ideaId!, [...(byIdea.get(row.ideaId!) ?? []), row]);

  const choices: TimedChoice[] = [];
  for (const ideaId of ideaIds) {
    const post = byIdea.get(ideaId) ?? [];
    const chosen = newest(post.filter((row) => row.status === "kept" || row.status === "used"), "updatedAt");
    if (!chosen) continue;
    for (const line of linesOf(post)) {
      const starred = line.some((row) => row.favorite);
      if (line.some((row) => row.id === chosen.id)) {
        const text = textOf(chosen);
        if (!text) continue;
        const lineVotes = line.flatMap((row) => votesOf.get(row.id) ?? []);
        const good = lineVotes.some((vote) => vote.outcome === "good");
        const at = new Date(Math.max(chosen.updatedAt.getTime(), ...lineVotes.map((vote) => vote.ratedAt.getTime())));
        // A post that didn't land is the stronger truth, like taste.ts's: real results beat a first pick.
        if (lineVotes.length > 0 && !good) choices.push({ id: chosen.id, text, kept: false, at });
        else choices.push({ id: chosen.id, text, kept: true, weight: 1 + (starred ? 1 : 0) + (good ? 1 : 0), at });
        continue;
      }
      if (line.every((row) => row.status === "discarded" && row.meta.trimmed === true)) continue;
      const shown = starred ? newest(line.filter((row) => row.favorite), "createdAt")! : newest(line, "createdAt")!;
      const text = textOf(shown);
      if (text) choices.push({ id: shown.id, text, kept: starred, at: chosen.updatedAt });
    }
  }
  return choices;
}

/**
 * What the owner asked Write's chat to change, most asked first (the chips
 * and their own words, jobs' `label`), as the writer's brief reads them:
 * "Shorter (asked 4 times)".
 */
export async function loadRecentEdits(db: typeof Db): Promise<string[]> {
  const rows = await db
    .select({ payload: jobs.payload })
    .from(jobs)
    .where(and(eq(jobs.kind, "revise_draft"), eq(jobs.status, "done"), sql`${jobs.payload}->>'mode' = 'custom'`))
    .orderBy(desc(jobs.createdAt))
    .limit(EDIT_JOBS_READ);
  const asked = new Map<string, { label: string; count: number }>();
  for (const { payload } of rows) {
    const raw = typeof payload.label === "string" && payload.label.trim() ? payload.label : payload.instruction;
    if (typeof raw !== "string" || !raw.trim()) continue;
    const label = raw.trim().replace(/\s+/g, " ").slice(0, EDIT_MAX_CHARS);
    const key = label.toLowerCase();
    const seen = asked.get(key);
    if (seen) seen.count++;
    else asked.set(key, { label, count: 1 });
  }
  // Map order is newest first; a stable sort keeps it among equal counts.
  return [...asked.values()]
    .sort((a, b) => b.count - a.count)
    .slice(0, MAX_EDITS)
    .map(({ label, count }) => (count > 1 ? `${label} (asked ${count} times)` : label));
}

function newSince(choices: TimedChoice[], learnedAt: string | null): number {
  const since = learnedAt ? Date.parse(learnedAt) : Number.NEGATIVE_INFINITY;
  return choices.filter((choice) => choice.at.getTime() > since).length;
}

async function learnStyleRunning(db: typeof Db): Promise<boolean> {
  const [open] = await db
    .select({ id: jobs.id })
    .from(jobs)
    .where(and(eq(jobs.kind, "learn_style"), inArray(jobs.status, ["queued", "claimed"])))
    .limit(1);
  return Boolean(open);
}

export type StyleLearningStatus = {
  proposal: StyleProposal | null;
  /** A learn_style job is waiting for, or running on, the Mac agent. */
  running: boolean;
  /** The choices it would learn from now. */
  choices: number;
  /** Of those, made since it last looked. */
  newChoices: number;
  learnedAt: string | null;
  needed: number;
};

/** What Settings › Voice says about the learning: the waiting proposal, or how far the next look is. */
export async function styleLearningStatus(db: typeof Db): Promise<StyleLearningStatus> {
  const [proposal, learnedAt, running, choices] = await Promise.all([
    getSetting(db, "styleProposal"),
    getSetting(db, "styleLearnedAt"),
    learnStyleRunning(db),
    loadStyleChoices(db),
  ]);
  return { proposal, running, choices: choices.length, newChoices: newSince(choices, learnedAt), learnedAt, needed: LEARN_AFTER_NEW_CHOICES };
}

/** Never called: learnFromChoices only asks Jev about the traits it can't read by rule, and without a key there are none. */
const NO_JEV: JevClient = {
  systemOne: async () => {
    throw new Error("no Jev key");
  },
};

export type LearnOutcome = "checked-recently" | "learned-recently" | "proposal-waiting" | "running" | "too-few" | "nothing-clear" | "queued";

/**
 * Looks at the choices now: jev-judge reads the lessons (without a Jev key,
 * from the traits a rule can read), and when there are some, a learn_style
 * job carries them, the guide, the owner's edit requests and a few posts
 * they kept to the agent. It counts as having looked either way.
 */
export async function startStyleLearning(db: typeof Db, choices: TimedChoice[], now = new Date()): Promise<"too-few" | "nothing-clear" | "queued"> {
  const kept = choices.filter((choice) => choice.kept).length;
  if (kept < MIN_EACH_SIDE || choices.length - kept < MIN_EACH_SIDE) return "too-few";
  const jev = await getSlopClient(db);
  const traits = jev ? STYLE_TRAITS : STYLE_TRAITS.filter((trait) => trait.read);
  const { lessons } = await learnFromChoices(jev ?? NO_JEV, { choices: choices.map(({ id, text, kept, weight }) => ({ id, text, kept, weight })), traits });
  await setSetting(db, "styleLearnedAt", now.toISOString());
  if (lessons.length === 0) return "nothing-clear";

  const [guide, edits] = await Promise.all([getSetting(db, "styleGuide"), loadRecentEdits(db)]);
  const examples = choices
    .filter((choice) => choice.kept)
    .sort((a, b) => (b.weight ?? 1) - (a.weight ?? 1) || b.at.getTime() - a.at.getTime())
    .slice(0, MAX_EXAMPLES)
    .map((choice) => choice.text.slice(0, EXAMPLE_MAX_CHARS));
  await db.insert(jobs).values({ kind: "learn_style", payload: { guide, lessons, edits, examples, basedOn: choices.length } });
  return "queued";
}

/**
 * The weekly look, from the agent's heartbeat (it's the Mac that writes the
 * proposal): at most one check a day, at most one look a week, never over a
 * proposal still waiting or a job still running, and only once there are
 * about 15 new choices.
 */
export async function maybeLearnStyle(db: typeof Db, now = new Date()): Promise<LearnOutcome> {
  const checkedAt = await getSetting(db, "styleLearnCheckedAt");
  if (checkedAt && now.getTime() - Date.parse(checkedAt) < CHECK_EVERY_MS) return "checked-recently";
  await setSetting(db, "styleLearnCheckedAt", now.toISOString());

  const [learnedAt, proposal] = await Promise.all([getSetting(db, "styleLearnedAt"), getSetting(db, "styleProposal")]);
  if (learnedAt && now.getTime() - Date.parse(learnedAt) < LEARN_EVERY_MS) return "learned-recently";
  if (proposal) return "proposal-waiting";
  if (await learnStyleRunning(db)) return "running";

  const choices = await loadStyleChoices(db);
  if (newSince(choices, learnedAt) < LEARN_AFTER_NEW_CHOICES) return "too-few";
  return startStyleLearning(db, choices, now);
}
