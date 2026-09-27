# What comes first in Find Ideas: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task by task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal.** Find Ideas ranks the kinds of post the owner puts first, inside their area. Plan's
👍/👎 on posts that are out teach the ranking. The card's Aa button becomes a right-click menu.

**Architecture.**
- jev-judge 0.2.0 gains generic kinds of post: one `choice` question per post, a `kindFit`
  term in `rank`, an optional relevance gate, and `classifyPosts`.
- PostEcho turns the owner's order (Settings, kv `findOrder`) into weighted kinds for every
  search.
- Votes live on `scheduled_posts.outcome`. The ideas behind them lead the taste examples.

**Tech stack.**
- jev-judge (TypeScript, vitest, tsup).
- PostEcho web: Next.js 16 App Router, Drizzle with Neon and PGlite, zod v4, vitest in the
  node env (`*.test.ts` only; renders with react-dom/server and createElement), Tailwind v4.

**Spec.** `docs/specs/2026-09-26-search-priorities-design.md`

**Conventions to keep.**
- Comments cite the owner's words and dates, like the code around them.
- UI copy is English and plain: no "Jev", no "rank" in the new parts.
- Run web tests with `npx vitest run <file> --testTimeout=30000` from `web/`.
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Never deploy in parallel with other Bash calls.

---

## File map

**jev-judge** (`~/jev-judge`, its own git repo; not pushed):
- Create `src/kinds.ts`: `validateKinds`, `kindQuestion`, `readKind`, `classifyPosts`.
- Create `src/kinds.test.ts`.
- Modify `src/types.ts`:
  - new `PostKind`, `KindJudgment`, `RelevanceGate`;
  - `PostJudgment.kind` and `PostJudgment.kindFit`;
  - `JudgeWeights.kind` and `JudgeOptions.relevanceGate`.
- Modify `src/judge.ts`: kinds in questions and in rank, default weights, the gate.
- Modify `src/judge.test.ts`: a new describe block.
- Modify `src/index.ts`: export `classifyPosts`.
- Modify `README.md` and `package.json` (version 0.2.0).

**PostEcho web** (`~/PostEcho/web`):
- `vendor/jev-judge-0.2.0.tgz` replaces `vendor/jev-judge-0.1.0.tgz`. Modify `package.json`
  and `package-lock.json`.
- Create `src/lib/find-kinds.ts` and its test: the five kinds, weights by position, order
  helpers, the gate.
- Modify `src/lib/settings.ts`: the `findOrder` default.
- Modify `src/lib/scout-run.ts` and its test: pass the kinds and the gate, store `postKind`.
- Modify `src/db/schema.ts` and create `drizzle/0012_post_outcome.sql` (generated): the
  `post_outcome` enum, and `outcome` and `rated_at` columns.
- Modify `src/lib/schedule.ts` and its test: `isOut`, `rateSchedule`, `listToRate`, the
  `not_out` code.
- Modify `src/lib/taste.ts` and its test: `loadRatedIdeas`, votes first in
  `loadTasteExamples`, `kindCountsOf`.
- Create `src/lib/idea-kind.ts` and its test: `backfillIdeaKind`.
- Modify `src/app/api/scheduled-posts/[id]/route.ts`: PATCH `{ outcome }`.
- Modify `src/app/api/scheduled-posts/route.ts`: GET `?toRate=1`.
- Modify `src/app/api/scheduled-posts/scheduled-posts.test.ts`.
- Modify `src/app/api/settings/route.ts` and `settings-api.test.ts`: `findOrder`,
  `kindCounts`, and `tasteCounts.rated`.
- Modify `src/components/plan/plan-calendar.ts` and its test: `PlanOutcome`,
  `PlanPost.outcome`, `isOutStatus`.
- Modify `src/components/plan/schedule-card.tsx` and its test: `RateRow`, `RateCard`, and
  ScheduleCard's `onRate`.
- Create `src/components/plan/rate-list.tsx`.
- Modify `src/components/plan/day-list.tsx` and `src/components/plan/plan-view.tsx`: the
  vote and the To rate pill.
- Create `src/components/settings/find-order.tsx`: the ordered list with drag and arrows.
- Modify `src/components/settings/settings-panel.tsx` and its test: the Sources tab, the
  Advanced disclosure, and the payload.
- Create `src/components/card-menu.tsx` and its test: `keepsBrowserMenu`, `createLongPress`,
  `CardMenu`.
- Modify `src/components/idea-card.tsx`: the Aa button out, the right-click menu in.
- Modify `src/components/settings/style-inspiration-section.tsx`: the copy.

---

### Task 1: jev-judge, the kinds module

**Files:**
- Modify: `~/jev-judge/src/types.ts`
- Create: `~/jev-judge/src/kinds.ts`
- Test: `~/jev-judge/src/kinds.test.ts`

- [ ] **Step 1: Add the new types to `src/types.ts`.**

  In `PostJudgment`, change the `rank` comment to "0..100, weighted mix of
  relevance/quality/tasteFit/kindFit — see JudgeWeights". Then add these two fields after
  `spamScore`:

```ts
  /** The most probable of the caller's kinds (see `PostKind`). Present only when `judgePosts` got `kinds`; null when Jev gave no kind answer. */
  kind?: string | null;
  /** Σ p(label) × weight(label), 0..1: how much of what the caller wants this post is. Present only when `judgePosts` got `kinds`; null when Jev gave no kind answer. */
  kindFit?: number | null;
```

  Replace the `JudgeWeights` doc comment and type, and `JudgeOptions`, with:

```ts
/**
 * A kind of post the caller wants told apart — a first-hand story, an opinion, a release — and
 * how much it wants that kind: `weight` from 0 (not at all) to 1 (most). `description` is what
 * Jev reads to recognize it. Pass a catch-all kind too (say "other", weight 0), or every post
 * is forced into one of yours.
 */
export type PostKind = { label: string; description: string; weight: number };

/** `classifyPosts`' answer per post: the same `kind`/`kindFit` pair a `PostJudgment` carries. */
export type KindJudgment = { id: string; kind: string | null; kindFit: number | null };

/**
 * Weights for `judgePosts`'s combined `rank`, applied as `rank = relevance*w.relevance +
 * quality*w.quality + (tasteFit*100)*w.taste + (kindFit*100)*w.kind` (rounded, clamped to
 * 0..100). Must sum to ~1 (±0.01) — `judgePosts` throws otherwise. `kind` is optional (0 when
 * left out). Defaults, by what was supplied:
 *
 * - no taste, no kinds: relevance 0.6, quality 0.4
 * - taste, no kinds: relevance 0.45, quality 0.3, taste 0.25
 * - kinds, no taste: relevance 0.2, quality 0.35, kind 0.45
 * - kinds and taste: relevance 0.15, quality 0.25, taste 0.25, kind 0.35
 */
export type JudgeWeights = { relevance: number; quality: number; taste: number; kind?: number };

/**
 * `judgePosts`' optional relevance gate: `rank` is multiplied by
 * clamp((relevance − floor) / (full − floor), 0, 1), so a post under `floor` sinks to 0
 * whatever its other signals, and from `full` up relevance no longer holds it back. Needs
 * 0 ≤ floor < full ≤ 100.
 */
export type RelevanceGate = { floor: number; full: number };

// Note: retries are a concern of the client returned by `createJevClient` (constructed
// separately and passed in), not of `judgePosts` itself, so there is no `maxRetries` here.
export type JudgeOptions = {
  chunkSize?: number;
  /** Chunks judged concurrently (default 4 in `judgePosts`); 1 = strictly sequential. */
  concurrency?: number;
  spamThreshold?: number;
  weights?: JudgeWeights;
  relevanceGate?: RelevanceGate;
};
```

- [ ] **Step 2: Write the failing tests in `src/kinds.test.ts`.**

```ts
import { describe, expect, it, vi } from "vitest";
import type { JevClient, SystemOneRequest, SystemOneResponse } from "./client.js";
import { classifyPosts, kindQuestion, readKind, validateKinds } from "./kinds.js";
import type { PostKind } from "./types.js";

const KINDS: PostKind[] = [
  { label: "story", description: "A first-hand story with numbers.", weight: 1 },
  { label: "news", description: "An announcement or release.", weight: 0.4 },
  { label: "other", description: "None of the above.", weight: 0.1 },
];

describe("validateKinds", () => {
  it("accepts 2 to 12 kinds with unique labels and weights from 0 to 1", () => {
    expect(() => validateKinds(KINDS)).not.toThrow();
  });

  it("rejects too few or too many kinds", () => {
    expect(() => validateKinds([KINDS[0]])).toThrow(/2 to 12/);
    const many = Array.from({ length: 13 }, (_, i) => ({ label: `k${i}`, description: "d", weight: 0.5 }));
    expect(() => validateKinds(many)).toThrow(/2 to 12/);
  });

  it("rejects an empty label, a label used twice, and a weight outside 0..1", () => {
    expect(() => validateKinds([{ ...KINDS[0], label: " " }, KINDS[1]])).toThrow(/non-empty label/);
    expect(() => validateKinds([KINDS[0], { ...KINDS[1], label: "story" }])).toThrow(/twice/);
    expect(() => validateKinds([{ ...KINDS[0], weight: 1.5 }, KINDS[1]])).toThrow(/weight/);
    expect(() => validateKinds([{ ...KINDS[0], weight: Number.NaN }, KINDS[1]])).toThrow(/weight/);
  });
});

describe("kindQuestion", () => {
  it("is a choice question naming the post, with one described label per kind", () => {
    expect(kindQuestion("p7", KINDS)).toEqual({
      type: "choice",
      instructions: "Which kind of post is post p7?",
      criteria: {
        story: "A first-hand story with numbers.",
        news: "An announcement or release.",
        other: "None of the above.",
      },
    });
  });
});

describe("readKind", () => {
  it("picks the most probable label and weighs every label by its probability", () => {
    const read = readKind({ choice: "story", probabilities: { story: 0.7, news: 0.2, other: 0.1 } }, KINDS);
    expect(read.kind).toBe("story");
    // 0.7*1 + 0.2*0.4 + 0.1*0.1 = 0.79
    expect(read.kindFit).toBeCloseTo(0.79, 10);
  });

  it("leaves out labels it doesn't know, renormalizing over the known ones", () => {
    const read = readKind({ probabilities: { story: 0.3, poem: 0.4, news: 0.3 } }, KINDS);
    expect(read.kind).toBe("story");
    // (0.3*1 + 0.3*0.4) / 0.6 = 0.7
    expect(read.kindFit).toBeCloseTo(0.7, 10);
  });

  it("counts the chosen label as certain when there are no probabilities", () => {
    expect(readKind({ choice: "news" }, KINDS)).toEqual({ kind: "news", kindFit: 0.4 });
  });

  it("is null/null for a missing answer or an unknown label", () => {
    expect(readKind(undefined, KINDS)).toEqual({ kind: null, kindFit: null });
    expect(readKind({ choice: "poem" }, KINDS)).toEqual({ kind: null, kindFit: null });
    expect(readKind({ probabilities: { poem: 1 } }, KINDS)).toEqual({ kind: null, kindFit: null });
  });
});

describe("classifyPosts", () => {
  it("returns [] without calling Jev for no posts, and validates kinds first", async () => {
    const systemOne = vi.fn();
    const client: JevClient = { systemOne };
    expect(await classifyPosts(client, { posts: [], kinds: KINDS })).toEqual([]);
    await expect(classifyPosts(client, { posts: [{ id: "a", text: "t" }], kinds: [KINDS[0]] })).rejects.toThrow(/2 to 12/);
    expect(systemOne).not.toHaveBeenCalled();
  });

  it("asks one kind question per post, chunked, and keeps the input order", async () => {
    const calls: SystemOneRequest[] = [];
    const systemOne = vi.fn(async (req: SystemOneRequest): Promise<SystemOneResponse> => {
      calls.push(req);
      const { posts } = req.state as { posts: Array<{ id: string }> };
      return {
        answers: Object.fromEntries(posts.map((p, i) => [`kind_${i}`, { choice: p.id.startsWith("s") ? "story" : "news" }])),
      };
    });
    const posts = ["s1", "n1", "s2"].map((id) => ({ id, text: `text ${id}` }));

    const result = await classifyPosts({ systemOne }, { posts, kinds: KINDS, options: { chunkSize: 2 } });

    expect(systemOne).toHaveBeenCalledTimes(2);
    expect(Object.keys(calls[0].questions)).toEqual(["kind_0", "kind_1"]);
    expect(calls[0].questions.kind_0).toEqual(kindQuestion("s1", KINDS));
    expect(result).toEqual([
      { id: "s1", kind: "story", kindFit: 1 },
      { id: "n1", kind: "news", kindFit: 0.4 },
      { id: "s2", kind: "story", kindFit: 1 },
    ]);
  });
});
```

- [ ] **Step 3: Run the tests and check they fail.**

  Run: `cd ~/jev-judge && npx vitest run src/kinds.test.ts`

  Expected: FAIL. Vitest can't resolve `./kinds.js`.

- [ ] **Step 4: Write `src/kinds.ts`.**

```ts
import type { JevClient, SystemOneAnswer } from "./client.js";
import { clamp } from "./normalize.js";
import type { KindJudgment, PostInput, PostKind } from "./types.js";

const MIN_KINDS = 2;
const MAX_KINDS = 12;
// judgePosts' defaults: one choice question per post is far lighter than judgePosts' three or
// four, but the rate-limit behaviour is the same.
const DEFAULT_CHUNK_SIZE = 8;
const DEFAULT_CONCURRENCY = 4;

/**
 * Throws a clear Error, before any network call, when `kinds` can't make a sound `choice`
 * question: 2 to 12 kinds, each with a non-empty label used once and a weight from 0 to 1.
 */
export function validateKinds(kinds: PostKind[]): void {
  if (kinds.length < MIN_KINDS || kinds.length > MAX_KINDS) {
    throw new Error(`jev-judge: kinds must list ${MIN_KINDS} to ${MAX_KINDS} kinds; got ${kinds.length}`);
  }
  const labels = new Set<string>();
  for (const kind of kinds) {
    if (kind.label.trim().length === 0) throw new Error("jev-judge: every kind needs a non-empty label");
    if (labels.has(kind.label)) throw new Error(`jev-judge: the kind label "${kind.label}" appears twice`);
    labels.add(kind.label);
    if (!Number.isFinite(kind.weight) || kind.weight < 0 || kind.weight > 1) {
      throw new Error(`jev-judge: kind "${kind.label}" has weight ${kind.weight}; weights go from 0 to 1`);
    }
  }
}

/** The `choice` question asking which of `kinds` post `postId` is, each label described. */
export function kindQuestion(postId: string, kinds: PostKind[]): Record<string, unknown> {
  return {
    type: "choice",
    instructions: `Which kind of post is post ${postId}?`,
    criteria: Object.fromEntries(kinds.map((kind) => [kind.label, kind.description])),
  };
}

/**
 * Reads a `choice` answer against `kinds`: the most probable label, and `kindFit` = Σ p(label)
 * × weight(label) over the labels `kinds` knows (probabilities renormalized over those, so a
 * stray label Jev invents neither counts nor dilutes the rest). With no probabilities, the
 * chosen label counts as certain. `{ kind: null, kindFit: null }` when the answer is missing
 * or names no known label.
 */
export function readKind(
  answer: SystemOneAnswer | undefined,
  kinds: PostKind[]
): { kind: string | null; kindFit: number | null } {
  const weightOf = new Map(kinds.map((kind) => [kind.label, kind.weight]));
  const probabilities = answer?.probabilities;
  if (probabilities && Object.keys(probabilities).length > 0) {
    let best: string | null = null;
    let bestP = 0;
    let total = 0;
    let fit = 0;
    for (const [label, p] of Object.entries(probabilities)) {
      const weight = weightOf.get(label);
      if (weight === undefined || !Number.isFinite(p) || p <= 0) continue;
      total += p;
      fit += p * weight;
      if (p > bestP) {
        best = label;
        bestP = p;
      }
    }
    if (best === null) return { kind: null, kindFit: null };
    return { kind: best, kindFit: clamp(fit / total, 0, 1) };
  }
  const chosen = answer?.choice;
  const weight = chosen === undefined ? undefined : weightOf.get(chosen);
  if (chosen === undefined || weight === undefined) return { kind: null, kindFit: null };
  return { kind: chosen, kindFit: weight };
}

/**
 * Tells which of `kinds` each post is — for callers that need only the kind (`judgePosts`
 * asks the same question next to relevance, quality and spam when given `kinds`). One
 * `choice` question per post; posts are chunked (default 8 per `systemOne` call) with up to 4
 * calls in flight, and come back in input order. Validates `kinds` before any call.
 */
export async function classifyPosts(
  client: JevClient,
  args: { posts: PostInput[]; kinds: PostKind[]; options?: { chunkSize?: number; concurrency?: number } }
): Promise<KindJudgment[]> {
  const { posts, kinds, options } = args;
  validateKinds(kinds);
  if (posts.length === 0) return [];

  const size = Math.max(1, Math.floor(options?.chunkSize ?? DEFAULT_CHUNK_SIZE));
  const chunks: PostInput[][] = [];
  for (let start = 0; start < posts.length; start += size) chunks.push(posts.slice(start, start + size));

  const classifyChunk = async (chunk: PostInput[]): Promise<KindJudgment[]> => {
    const questions: Record<string, unknown> = {};
    chunk.forEach((post, i) => {
      questions[`kind_${i}`] = kindQuestion(post.id, kinds);
    });
    const response = await client.systemOne({ state: { posts: chunk }, questions });
    return chunk.map((post, i) => ({ id: post.id, ...readKind(response.answers[`kind_${i}`], kinds) }));
  };

  // The same bounded pool as judgePosts and rateAiStyle: results slotted by chunk index.
  const perChunk: KindJudgment[][] = new Array(chunks.length);
  let next = 0;
  const worker = async () => {
    while (next < chunks.length) {
      const index = next++;
      perChunk[index] = await classifyChunk(chunks[index]);
    }
  };
  const concurrency = Math.max(1, Math.floor(options?.concurrency ?? DEFAULT_CONCURRENCY));
  await Promise.all(Array.from({ length: Math.min(concurrency, chunks.length) }, worker));
  return perChunk.flat();
}
```

- [ ] **Step 5: Run the tests and check they pass.**

  Run: `cd ~/jev-judge && npx vitest run src/kinds.test.ts`

  Expected: PASS, 10 tests.

- [ ] **Step 6: Commit.**

```bash
cd ~/jev-judge && git add src/types.ts src/kinds.ts src/kinds.test.ts && git commit -m "feat: kinds of post — validate, ask as a choice question, read into kind and kindFit, classifyPosts

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 2: jev-judge, kinds in `judgePosts`

**Files:**
- Modify: `~/jev-judge/src/judge.ts`
- Test: `~/jev-judge/src/judge.test.ts` (append a describe block)

- [ ] **Step 1: Write the failing tests.** Append to `src/judge.test.ts`, and add
  `PostKind` to the type import from `./types.js`:

```ts
describe("judgePosts with kinds (0.2.0)", () => {
  const KINDS: PostKind[] = [
    { label: "story", description: "A first-hand story with numbers.", weight: 1 },
    { label: "news", description: "An announcement or release.", weight: 0.4 },
    { label: "other", description: "None of the above.", weight: 0.1 },
  ];
  // relevance 75, quality 50, not spam.
  function answers(extra: SystemOneResponse["answers"] = {}): SystemOneResponse {
    return { answers: { rel_0: { score: 3, confidence: 0.7 }, qual_0: { score: 2, confidence: 0.6 }, spam_0: { noul: 0.1 }, ...extra } };
  }
  const storyish = { kind_0: { choice: "story", probabilities: { story: 0.7, news: 0.2, other: 0.1 } } };

  it("asks a kind_i choice question and returns kind and kindFit", async () => {
    const systemOne = vi.fn().mockResolvedValue(answers(storyish));
    const [j] = await judgePosts({ systemOne }, { topic: "t", posts: [makePost("p1")], kinds: KINDS });
    const [request] = systemOne.mock.calls[0] as [SystemOneRequest];
    expect(request.questions.kind_0).toEqual({
      type: "choice",
      instructions: "Which kind of post is post p1?",
      criteria: { story: "A first-hand story with numbers.", news: "An announcement or release.", other: "None of the above." },
    });
    expect(j.kind).toBe("story");
    expect(j.kindFit).toBeCloseTo(0.79, 10);
  });

  it("ranks with the kinds weights, 0.2/0.35/0/0.45, without taste", async () => {
    const [j] = await judgePosts({ systemOne: vi.fn().mockResolvedValue(answers(storyish)) }, { topic: "t", posts: [makePost("p1")], kinds: KINDS });
    // 0.2*75 + 0.35*50 + 0.45*79 = 15 + 17.5 + 35.55 = 68.05
    expect(j.rank).toBe(68);
  });

  it("ranks with 0.15/0.25/0.25/0.35 when taste examples are supplied too", async () => {
    const [j] = await judgePosts(
      { systemOne: vi.fn().mockResolvedValue(answers({ ...storyish, taste_0: { noul: 0.6 } })) },
      { topic: "t", posts: [makePost("p1")], kinds: KINDS, taste: { kept: ["a"], skipped: ["b"] } },
    );
    // 0.15*75 + 0.25*50 + 0.25*60 + 0.35*79 = 11.25 + 12.5 + 15 + 27.65 = 66.4
    expect(j.rank).toBe(66);
  });

  it("neither rewards nor penalizes a post Jev gave no kind for: the other terms share the weight", async () => {
    const [j] = await judgePosts({ systemOne: vi.fn().mockResolvedValue(answers()) }, { topic: "t", posts: [makePost("p1")], kinds: KINDS });
    expect(j).toMatchObject({ kind: null, kindFit: null });
    // (0.2*75 + 0.35*50) / 0.55 = 32.5 / 0.55 = 59.09
    expect(j.rank).toBe(59);
  });

  it("leaves kind and kindFit out entirely when no kinds are passed, ranking as 0.1.0 did", async () => {
    const [j] = await judgePosts({ systemOne: vi.fn().mockResolvedValue(answers(storyish)) }, { topic: "t", posts: [makePost("p1")] });
    expect(j).not.toHaveProperty("kind");
    expect(j).not.toHaveProperty("kindFit");
    expect(j.rank).toBe(65); // 0.6*75 + 0.4*50
  });

  it("the relevance gate sinks a tangential post and leaves an on-topic one alone", async () => {
    const gate = { floor: 20, full: 50 };
    const tangential = { answers: { rel_0: { score: 1 }, qual_0: { score: 4 }, spam_0: { noul: 0 }, kind_0: { choice: "story" } } };
    const onTopic = { answers: { rel_0: { score: 2 }, qual_0: { score: 4 }, spam_0: { noul: 0 }, kind_0: { choice: "story" } } };
    const [low] = await judgePosts({ systemOne: vi.fn().mockResolvedValue(tangential) },
      { topic: "t", posts: [makePost("p1")], kinds: KINDS, options: { relevanceGate: gate } });
    // 0.2*25 + 0.35*100 + 0.45*100 = 85, × (25 - 20) / 30 = 14.17
    expect(low.rank).toBe(14);
    const [high] = await judgePosts({ systemOne: vi.fn().mockResolvedValue(onTopic) },
      { topic: "t", posts: [makePost("p1")], kinds: KINDS, options: { relevanceGate: gate } });
    // 0.2*50 + 0.35*100 + 0.45*100 = 90, × 1
    expect(high.rank).toBe(90);
  });

  it("throws before calling Jev on a bad gate, bad kinds, or weights that don't sum to ~1 with kind", async () => {
    const systemOne = vi.fn();
    const posts = [makePost("p1")];
    await expect(judgePosts({ systemOne }, { topic: "t", posts, options: { relevanceGate: { floor: 50, full: 50 } } })).rejects.toThrow(/relevanceGate/);
    await expect(judgePosts({ systemOne }, { topic: "t", posts, kinds: [KINDS[0]] })).rejects.toThrow(/2 to 12/);
    await expect(judgePosts({ systemOne }, {
      topic: "t", posts, kinds: KINDS, options: { weights: { relevance: 0.2, quality: 0.3, taste: 0, kind: 0.3 } },
    })).rejects.toThrow(/weights/);
    expect(systemOne).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the tests and check they fail.**

  Run: `cd ~/jev-judge && npx vitest run src/judge.test.ts`

  Expected: FAIL. There is no kind question, `j.kind` is undefined, and the ranks differ.

- [ ] **Step 3: Implement it in `src/judge.ts`.**

  Replace the two imports at the top with:

```ts
import type { JevClient, SystemOneAnswer, SystemOneResponse } from "./client.js";
import { kindQuestion, readKind, validateKinds } from "./kinds.js";
import { clamp, normalizeScore } from "./normalize.js";
import type { JudgeOptions, JudgeWeights, PostInput, PostJudgment, PostKind, RelevanceGate, TasteExamples } from "./types.js";
```

  After `DEFAULT_WEIGHTS_WITH_TASTE`, add:

```ts
// With kinds (0.2.0), what the post IS carries the most weight and relevance the least: the
// caller who names kinds wants the right material first, on topic enough (see relevanceGate).
const DEFAULT_WEIGHTS_KINDS_NO_TASTE: JudgeWeights = { relevance: 0.2, quality: 0.35, taste: 0, kind: 0.45 };
const DEFAULT_WEIGHTS_KINDS_WITH_TASTE: JudgeWeights = { relevance: 0.15, quality: 0.25, taste: 0.25, kind: 0.35 };

function defaultWeights(includeTaste: boolean, includeKinds: boolean): JudgeWeights {
  if (includeKinds) return includeTaste ? DEFAULT_WEIGHTS_KINDS_WITH_TASTE : DEFAULT_WEIGHTS_KINDS_NO_TASTE;
  return includeTaste ? DEFAULT_WEIGHTS_WITH_TASTE : DEFAULT_WEIGHTS_NO_TASTE;
}
```

  Replace `validateWeights` with the version below, and add `validateGate` after it:

```ts
/** Throws a clear Error when `weights` don't sum to ~1 (within {@link WEIGHT_SUM_TOLERANCE}). */
function validateWeights(weights: JudgeWeights): void {
  const sum = weights.relevance + weights.quality + weights.taste + (weights.kind ?? 0);
  if (Math.abs(sum - 1) > WEIGHT_SUM_TOLERANCE) {
    throw new Error(
      `jev-judge: options.weights must sum to ~1 (±${WEIGHT_SUM_TOLERANCE}); got ` +
        `relevance=${weights.relevance} + quality=${weights.quality} + taste=${weights.taste}` +
        (weights.kind !== undefined ? ` + kind=${weights.kind}` : "") +
        ` = ${sum}`
    );
  }
}

/** Throws a clear Error unless 0 ≤ floor < full ≤ 100. */
function validateGate(gate: RelevanceGate): void {
  const { floor, full } = gate;
  if (!Number.isFinite(floor) || !Number.isFinite(full) || floor < 0 || full > 100 || floor >= full) {
    throw new Error(`jev-judge: options.relevanceGate needs 0 <= floor < full <= 100; got floor=${floor}, full=${full}`);
  }
}
```

  In `buildQuestions`:
  - change the signature to
    `function buildQuestions(posts: PostInput[], includeTaste: boolean, kinds?: PostKind[]): Record<string, unknown>`;
  - after the `if (includeTaste) { ... }` block, still inside the `forEach`, add:

```ts
    if (kinds) questions[`kind_${i}`] = kindQuestion(post.id, kinds);
```

  Replace `computeRank` with:

```ts
/**
 * Combines relevance/quality/tasteFit/kindFit into `rank` (0..100, rounded). The taste term is
 * dropped (not just zero-weighted) when `tasteFit` is null, so a batch judged without taste
 * examples never silently loses `weights.taste` worth of headroom. A post Jev gave no kind
 * for (`kindFit` null under a kind weight) has the kind weight spread over the other terms,
 * so it is neither rewarded nor penalized for it. The relevance gate, when set, scales the
 * result last.
 */
function computeRank(
  relevance: number,
  quality: number,
  tasteFit: number | null,
  kindFit: number | null,
  weights: JudgeWeights,
  gate: RelevanceGate | undefined
): number {
  const tasteTerm = tasteFit === null ? 0 : weights.taste * (tasteFit * 100);
  const base = weights.relevance * relevance + weights.quality * quality + tasteTerm;
  const kindWeight = weights.kind ?? 0;
  let raw: number;
  if (kindWeight === 0) {
    raw = base;
  } else if (kindFit !== null) {
    raw = base + kindWeight * (kindFit * 100);
  } else {
    const rest = weights.relevance + weights.quality + weights.taste;
    raw = rest > 0 ? base / rest : 0;
  }
  if (gate) raw *= clamp((relevance - gate.floor) / (gate.full - gate.floor), 0, 1);
  return clamp(Math.round(raw), 0, 100);
}
```

  In `judgmentFor`:
  - add two trailing parameters, `kinds: PostKind[] | undefined` and
    `gate: RelevanceGate | undefined`;
  - in the missing-answers early return, add `...(kinds ? { kind: null, kindFit: null } : {}),`
    after `spamScore: 0,`;
  - replace `const rank = computeRank(relevance, quality, tasteFit, weights);` and the final
    `return` with:

```ts
  const { kind, kindFit } = kinds ? readKind(answers[`kind_${index}`], kinds) : { kind: null, kindFit: null };
  const rank = computeRank(relevance, quality, tasteFit, kindFit, weights, gate);

  return {
    id: post.id,
    relevance,
    relevanceConfidence,
    quality,
    qualityConfidence,
    tasteFit,
    rank,
    isSpam,
    spamScore,
    ...(kinds ? { kind, kindFit } : {}),
  };
```

  In `judgePosts`:
  - change the args type to
    `args: { topic: string; posts: PostInput[]; taste?: TasteExamples; kinds?: PostKind[]; options?: JudgeOptions }`;
  - destructure `kinds`: `const { topic, posts, taste, kinds, options } = args;`;
  - replace the two lines from `if (options?.weights) validateWeights(...)` through
    `const weights = ...` with:

```ts
  if (kinds) validateKinds(kinds);
  if (options?.weights) validateWeights(options.weights);
  if (options?.relevanceGate) validateGate(options.relevanceGate);
  const weights = options?.weights ?? defaultWeights(includeTaste, kinds !== undefined);
```

  - in `judgeChunk`, pass `buildQuestions(chunk, includeTaste, kinds)`, and map with
    `judgmentFor(post, i, response.answers, spamThreshold, includeTaste, weights, kinds, options?.relevanceGate)`.

  In the `judgePosts` doc comment, add this paragraph before "Results are returned…":

```ts
 * When `args.kinds` is supplied (see `PostKind`), each post also gets a `choice` question —
 * which of the caller's kinds it is — and the judgment carries `kind` and `kindFit`, folded
 * into `rank` with `weights.kind` (defaults: 0.2/0.35/0/0.45 without taste,
 * 0.15/0.25/0.25/0.35 with it). `options.relevanceGate` scales `rank` by how far relevance
 * clears its floor. Without `kinds` the judgments and ranks are exactly those of 0.1.0.
```

- [ ] **Step 4: Run the whole suite and the type check.**

  Run: `cd ~/jev-judge && npx vitest run && npx tsc --noEmit`

  Expected: every test passes, including the unchanged 0.1.0 ones, and there are no type
  errors.

- [ ] **Step 5: Export and commit.** In `src/index.ts`, add
  `export { classifyPosts } from "./kinds.js";` after the `judge.js` export line.

```bash
cd ~/jev-judge && npx tsc --noEmit && git add src/judge.ts src/judge.test.ts src/index.ts && git commit -m "feat: judgePosts ranks by the caller's kinds of post, with an optional relevance gate

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 3: jev-judge 0.2.0, README, pack, vendor into PostEcho

**Files:**
- Modify: `~/jev-judge/README.md` and `~/jev-judge/package.json`
- Replace: `~/PostEcho/web/vendor/jev-judge-0.1.0.tgz` with `jev-judge-0.2.0.tgz`
- Modify: `~/PostEcho/web/package.json` and `package-lock.json`

- [ ] **Step 1: Update the README.**
  - In the API table, change the `judgePosts` signature cell to
    ``(client: JevClient, args: { topic: string; posts: PostInput[]; taste?: TasteExamples; kinds?: PostKind[]; options?: JudgeOptions }) => Promise<PostJudgment[]>``.
  - Add a row after `sortByRank`:
    ``| `classifyPosts` | `(client: JevClient, args: { posts: PostInput[]; kinds: PostKind[]; options?: { chunkSize?: number; concurrency?: number } }) => Promise<KindJudgment[]>` | One `choice` question per post: which of your kinds it is. See [Kinds of post](#rank-by-the-kinds-of-post-you-want). |``
  - In the **`PostJudgment`** block, add these two lines before the closing `};`:
    - `  kind?: string | null;         // with kinds: the most probable label`
    - `  kindFit?: number | null;      // with kinds: Σ p(label) × weight(label), 0..1`
  - In **`JudgeOptions`**, add
    `  relevanceGate?: { floor: number; full: number }; // rank × clamp((relevance - floor) / (full - floor), 0, 1)`.
  - In the Rank weights table, add two rows for kinds: without taste, relevance 0.2 · quality
    0.35 · taste 0 · kind 0.45; with taste, 0.15 · 0.25 · 0.25 · 0.35. Change the
    `JudgeWeights` line to `{ relevance: number; quality: number; taste: number; kind?: number }`.
  - Insert this section before `## Slop check`:

````markdown
## Rank by the kinds of post you want

Relevance says whether a post is on topic. It can't say whether the post is the kind you're
hunting for. Pass `kinds`: your own labels, each described in plain words and weighted from
0 to 1 by how much you want it. `judgePosts` then adds one `choice` question per post:

```ts
const judgments = await judgePosts(client, {
  topic: "indie SaaS",
  posts,
  kinds: [
    { label: "story", description: "A first-hand story with concrete numbers.", weight: 1 },
    { label: "opinion", description: "A strong, arguable opinion.", weight: 0.8 },
    { label: "news", description: "An announcement or a release.", weight: 0.3 },
    { label: "other", description: "None of the above.", weight: 0 },
  ],
  options: { relevanceGate: { floor: 20, full: 50 } },
});
// each judgment also carries kind ("story" | "opinion" | ... | null) and kindFit (0..1)
```

- **`kind` and `kindFit`.** `kind` is the most probable label. `kindFit` is
  Σ p(label) × weight(label), and it joins `rank` with the kind weights above. Include a
  catch-all kind, or every post is forced into one of yours.
- **No kind answer.** When Jev gives no kind for a post, its rank comes from the other
  signals, reweighted. The post is neither rewarded nor penalized.
- **`options.relevanceGate`** is optional and needs 0 ≤ floor < full ≤ 100. It multiplies
  `rank` by clamp((relevance − floor) / (full − floor), 0, 1):
  - a post below `floor` sinks, whatever else it has;
  - from `full` up, relevance stops holding a post back.

  It fits when you rank mostly on kind and quality but want to stay on topic.
- **Without `kinds`, nothing changes.** Judgments carry no `kind` or `kindFit`, and ranks
  are exactly those of 0.1.0.

`classifyPosts(client, { posts, kinds })` asks only the kind question. It returns
`[{ id, kind, kindFit }]` in input order, 8 posts per call.
````

- [ ] **Step 2: Bump the version, check, build and pack.** In `package.json`, set
  `"version": "0.2.0"`.

  Run: `cd ~/jev-judge && npx tsc --noEmit && npx vitest run && npm run build && npm pack`

  Expected: the tests pass, `dist/` builds, and `jev-judge-0.2.0.tgz` is created.

- [ ] **Step 3: Commit jev-judge.** The tarball is not committed.

```bash
cd ~/jev-judge && git add README.md package.json package-lock.json && git commit -m "release: 0.2.0 — kinds of post, relevance gate, classifyPosts

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 4: Vendor it into PostEcho.**

```bash
mv ~/jev-judge/jev-judge-0.2.0.tgz ~/PostEcho/web/vendor/
cd ~/PostEcho/web && git rm -q vendor/jev-judge-0.1.0.tgz
```

  In `web/package.json`, set `"jev-judge": "file:vendor/jev-judge-0.2.0.tgz"`.

  Run: `cd ~/PostEcho/web && npm install && node -e "import('jev-judge').then(m => console.log(typeof m.classifyPosts))"`

  Expected: `function`.

- [ ] **Step 5: Check nothing broke, then commit.**

  Run: `cd ~/PostEcho/web && npx vitest run src/lib/scout-run.test.ts --testTimeout=30000`

  Expected: PASS. The file mocks `judgePosts`.

```bash
cd ~/PostEcho && git add web/vendor web/package.json web/package-lock.json && git commit -m "build: vendor jev-judge 0.2.0 (kinds of post, relevance gate, classifyPosts)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 4: PostEcho, the kinds and the order setting

**Files:**
- Create: `web/src/lib/find-kinds.ts`
- Test: `web/src/lib/find-kinds.test.ts`
- Modify: `web/src/lib/settings.ts`

- [ ] **Step 1: Write the failing tests in `web/src/lib/find-kinds.test.ts`.**

```ts
import { describe, expect, it } from "vitest";
import { DEFAULT_FIND_ORDER, FIND_KINDS, jevKinds, moveKind, normalizeOrder, weightAt } from "@/lib/find-kinds";
import { SETTING_DEFAULTS } from "@/lib/settings";

describe("the kinds Find Ideas tells apart (2026-09-26)", () => {
  it("defaults to the owner's order: stories, opinions, problems, news, tools", () => {
    expect(DEFAULT_FIND_ORDER).toEqual(["story", "opinion", "problem", "news", "tool"]);
    expect(SETTING_DEFAULTS.findOrder).toEqual(DEFAULT_FIND_ORDER);
    expect(FIND_KINDS.map((k) => k.name)).toEqual([
      "Real stories with numbers", "Strong opinions", "Practical problems", "News and launches", "Tools and guides",
    ]);
  });

  it("weighs each position: 1, 0.8, 0.6, 0.4, 0.2", () => {
    expect([0, 1, 2, 3, 4].map(weightAt)).toEqual([1, 0.8, 0.6, 0.4, 0.2]);
  });

  it("normalizes any stored order into a valid one", () => {
    expect(normalizeOrder(["news", "story", "opinion", "problem", "tool"])).toEqual(["news", "story", "opinion", "problem", "tool"]);
    // Unknown ids and repeats drop out; the missing ones follow in default order.
    expect(normalizeOrder(["tool", "poems", "tool", "story"])).toEqual(["tool", "story", "opinion", "problem", "news"]);
    expect(normalizeOrder(null)).toEqual(DEFAULT_FIND_ORDER);
    expect(normalizeOrder("story")).toEqual(DEFAULT_FIND_ORDER);
  });

  it("turns an order into Jev's kinds, the catch-all last", () => {
    const kinds = jevKinds(["opinion", "story", "problem", "news", "tool"]);
    expect(kinds.map((k) => [k.label, k.weight])).toEqual([
      ["opinion", 1], ["story", 0.8], ["problem", 0.6], ["news", 0.4], ["tool", 0.2], ["other", 0.1],
    ]);
    expect(kinds[0].description).toMatch(/opinion/);
  });

  it("moves a kind up or down, within the list, without touching the original", () => {
    const order = [...DEFAULT_FIND_ORDER];
    expect(moveKind(order, 2, 0)).toEqual(["problem", "story", "opinion", "news", "tool"]);
    expect(moveKind(order, 0, 1)).toEqual(["opinion", "story", "problem", "news", "tool"]);
    expect(moveKind(order, 4, 9)).toEqual(order);
    expect(moveKind(order, 0, -1)).toEqual(order);
    expect(moveKind(order, 7, 0)).toEqual(order);
    expect(order).toEqual(DEFAULT_FIND_ORDER);
  });
});
```

- [ ] **Step 2: Run the tests and check they fail.**

  Run: `cd ~/PostEcho/web && npx vitest run src/lib/find-kinds.test.ts`

  Expected: FAIL. Vitest can't resolve `@/lib/find-kinds`.

- [ ] **Step 3: Write `web/src/lib/find-kinds.ts`.**

```ts
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
  weight: 0.1,
};

/**
 * Find Ideas' relevance gate (jev-judge's options.relevanceGate): relevance is an expected
 * value over Jev's five levels (0, 25, 50, 75, 100). At "tangentially related" (25) a post
 * keeps a sixth of its rank; from "on-topic but shallow" (50) up the topic no longer holds it
 * back — "se parlo di agenti starò anche parlando di AI".
 */
export const RELEVANCE_GATE = { floor: 20, full: 50 } as const;

/** Position → weight: 1 for the first kind, then 0.8, 0.6, 0.4, 0.2. */
export function weightAt(position: number): number {
  return Math.round((1 - position * 0.2) * 100) / 100;
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
```

- [ ] **Step 4: Add the setting.** In `web/src/lib/settings.ts`, add
  `import { DEFAULT_FIND_ORDER } from "@/lib/find-kinds";` after the existing imports, and
  append this inside `SETTING_DEFAULTS`, after `disabledSources`:

```ts
  // What Find Ideas shows first (owner, 2026-09-26: "vuoi rendere ordinabili l'importanza di
  // queste… così sono prioritizzate?"): the kinds of post of lib/find-kinds.ts, most wanted
  // first. Read through normalizeOrder, so a broken value still gives a valid order.
  findOrder: [...DEFAULT_FIND_ORDER] as string[],
```

- [ ] **Step 5: Run the tests and check they pass.**

  Run: `cd ~/PostEcho/web && npx vitest run src/lib/find-kinds.test.ts src/lib/settings.test.ts --testTimeout=30000`

  Expected: PASS.

- [ ] **Step 6: Commit.**

```bash
cd ~/PostEcho && git add web/src/lib/find-kinds.ts web/src/lib/find-kinds.test.ts web/src/lib/settings.ts && git commit -m "feat(search): the five kinds of post, the owner's order and its weights

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 5: PostEcho, search passes the kinds and stores `postKind`

**Files:**
- Modify: `web/src/lib/scout-run.ts`
- Test: `web/src/lib/scout-run.test.ts`

- [ ] **Step 1: Write the failing tests.**

  In `scout-run.test.ts`, add this import after the other `@/lib` imports:
  `import { DEFAULT_FIND_ORDER, jevKinds, RELEVANCE_GATE } from "@/lib/find-kinds";`

  In the test "passes judgeTopic (not query) as the judging topic…", extend the exact
  expectation to:

```ts
    expect(judgePosts).toHaveBeenCalledWith(fakeClient, {
      topic: "the full seed text",
      posts: [{ id: "hackernews:a", text: "hello world", author: "ronin", metrics: { likes: 5, replies: 2 } }],
      kinds: jevKinds(DEFAULT_FIND_ORDER),
      options: { relevanceGate: RELEVANCE_GATE },
    });
```

  Append this block:

```ts
describe("what the owner wants first (2026-09-26)", () => {
  it("asks Jev for the kinds in the owner's order, with the relevance gate", async () => {
    process.env.TYPESAFE_API_KEY = "k";
    await setSetting(state.db as never, "findOrder", ["opinion", "story", "problem", "news", "tool"]);
    const a = staticAdapter("devto", { posts: [adapterPost({ id: "a" })], status: "ok" });
    vi.mocked(judgePosts).mockResolvedValueOnce([judgment("devto:a", 90)]);
    await runScoutSearch(state.db as never, { query: "q", judgeTopic: "q" }, { adapters: [a] });
    const call = vi.mocked(judgePosts).mock.calls[0][1];
    expect(call.kinds?.map((k) => [k.label, k.weight])).toEqual([
      ["opinion", 1], ["story", 0.8], ["problem", 0.6], ["news", 0.4], ["tool", 0.2], ["other", 0.1],
    ]);
    expect(call.options).toEqual({ relevanceGate: { floor: 20, full: 50 } });
  });

  it("keeps each saved idea's kind next to its rank", async () => {
    process.env.TYPESAFE_API_KEY = "k";
    const a = staticAdapter("devto", { posts: [adapterPost({ id: "a" })], status: "ok" });
    vi.mocked(judgePosts).mockResolvedValueOnce([{ ...judgment("devto:a", 90), kind: "story", kindFit: 0.9 }]);
    await runScoutSearch(state.db as never, { query: "q", judgeTopic: "q" }, { adapters: [a] });
    const [row] = await state.db!.select().from(ideas);
    expect(row.meta).toMatchObject({ rank: 90, postKind: "story", kindFit: 0.9 });
  });
});
```

- [ ] **Step 2: Run the tests and check they fail.**

  Run: `cd ~/PostEcho/web && npx vitest run src/lib/scout-run.test.ts --testTimeout=30000`

  Expected: FAIL in the three tests above.

- [ ] **Step 3: Implement it in `web/src/lib/scout-run.ts`.**
  - Add `import { jevKinds, RELEVANCE_GATE } from "@/lib/find-kinds";` with the other
    `@/lib` imports.
  - Replace the settings `Promise.all` in `runScoutSearch` with:

```ts
  const [candidatesPerSource, minScore, resultsTotal, findOrder] = await Promise.all([
    deps.candidatesPerSource ?? getSetting(db as never, "scoutCandidatesPerSource"),
    deps.minScore ?? getSetting(db as never, "scoutMinScore"),
    deps.resultsTotal ?? getSetting(db as never, "scoutResultsTotal"),
    getSetting(db as never, "findOrder"),
  ]);
  // What the owner wants first (Settings' order, 2026-09-26), as Jev's weighted kinds.
  const kinds = jevKinds(findOrder);
```

  - Replace the `judgePosts` call with:

```ts
        judgments = await judgePosts(client, {
          topic: judgeTopic,
          posts: roundCandidates.map((c) => ({ id: c.id, text: c.text, author: c.author ?? undefined, metrics: c.metrics })),
          ...(hasTaste ? { taste } : {}),
          // Content first, inside the owner's area (owner, 2026-09-26): the kinds they
          // rank highest weigh most, and the gate keeps what's off topic out.
          kinds,
          options: { relevanceGate: RELEVANCE_GATE },
        });
```

  - In the `saveIdeaFromInput` meta, add these two lines after `rank: j.rank,`:

```ts
        // The kind of post Jev read it as (lib/find-kinds.ts); Settings counts Plan's votes by it.
        postKind: j.kind ?? null,
        kindFit: j.kindFit ?? null,
```

- [ ] **Step 4: Run the tests and check they pass.**

  Run: `cd ~/PostEcho/web && npx vitest run src/lib/scout-run.test.ts --testTimeout=30000`

  Expected: PASS. If another test asserts the exact second argument of `judgePosts`, add
  `kinds: jevKinds(DEFAULT_FIND_ORDER), options: { relevanceGate: RELEVANCE_GATE }` to it.

- [ ] **Step 5: Commit.**

```bash
cd ~/PostEcho && git add web/src/lib/scout-run.ts web/src/lib/scout-run.test.ts && git commit -m "feat(search): rank by the owner's kinds of post, inside the topic; keep each idea's kind

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 6: PostEcho, the vote columns (migration 0012)

**Files:**
- Modify: `web/src/db/schema.ts`
- Create: `web/drizzle/0012_post_outcome.sql` and `web/drizzle/meta/0012_snapshot.json`
  (generated), and update the journal

- [ ] **Step 1: Add the enum and the columns.** In `schema.ts`, after `postedBy`:

```ts
// Plan's "How did it do?" (owner, 2026-09-26: "il tocco in plan serve sia se il post è andato
// bene che se è andato male"): the owner's 👍/👎 on a post that is out — lib/schedule.ts's
// rateSchedule; lib/taste.ts learns from it.
export const postOutcome = pgEnum("post_outcome", ["good", "bad"]);
```

  In `scheduledPosts`, after `publishedAt`:

```ts
  // The owner's vote on how the post did (postOutcome) and when they cast it; both null
  // until they vote, and again when they take the vote back.
  outcome: postOutcome("outcome"),
  ratedAt: timestamp("rated_at", { withTimezone: true }),
```

- [ ] **Step 2: Generate the migration.**

  Run: `cd ~/PostEcho/web && npx drizzle-kit generate --name post_outcome`

  Then `cat drizzle/0012_post_outcome.sql` should show exactly:

```sql
CREATE TYPE "public"."post_outcome" AS ENUM('good', 'bad');--> statement-breakpoint
ALTER TABLE "scheduled_posts" ADD COLUMN "outcome" "post_outcome";--> statement-breakpoint
ALTER TABLE "scheduled_posts" ADD COLUMN "rated_at" timestamp with time zone;
```

- [ ] **Step 3: Check the migrations apply in PGlite.**

  Run: `cd ~/PostEcho/web && npx vitest run src/db/schema.test.ts src/lib/schedule.test.ts --testTimeout=30000`

  Expected: PASS.

- [ ] **Step 4: Commit.**

```bash
cd ~/PostEcho && git add web/src/db/schema.ts web/drizzle && git commit -m "feat(db): scheduled_posts.outcome and rated_at — Plan's vote on how a post did

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 7: PostEcho, `rateSchedule` and `listToRate`

**Files:**
- Modify: `web/src/lib/schedule.ts`
- Test: `web/src/lib/schedule.test.ts`

- [ ] **Step 1: Write the failing tests.** Add `isOut, listToRate, rateSchedule` to the
  `@/lib/schedule` import, then append:

```ts
describe("How did it do? (2026-09-26: \"sia se è andato bene che se è andato male\")", () => {
  const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000);
  async function outPost(db: Awaited<ReturnType<typeof createTestDb>>, over: Partial<typeof scheduledPosts.$inferInsert> = {}) {
    const [draft] = await db.insert(drafts).values({ xText: "went out", status: "used" }).returning();
    const [row] = await db.insert(scheduledPosts).values({
      draftId: draft.id, platform: "x", text: "went out", status: "posted_manually", postedBy: "manual",
      publishAt: hoursAgo(30), publishedAt: hoursAgo(30), ...over,
    }).returning();
    return row;
  }

  it("records 👍 or 👎 on a post that is out, changes it, and takes it back", async () => {
    const db = await createTestDb();
    const row = await outPost(db);
    const now = new Date();
    expect(isOut(row, now)).toBe(true);
    expect(await rateSchedule(db, row.id, "good", now)).toMatchObject({ ok: true, post: { outcome: "good", ratedAt: now } });
    expect(await rateSchedule(db, row.id, "bad", now)).toMatchObject({ ok: true, post: { outcome: "bad" } });
    expect(await rateSchedule(db, row.id, null, now)).toMatchObject({ ok: true, post: { outcome: null, ratedAt: null } });
  });

  it("refuses a post that isn't out yet, and knows nothing of an unknown id", async () => {
    const db = await createTestDb();
    const [draft] = await db.insert(drafts).values({ xText: "later", status: "kept" }).returning();
    const [queued] = await db.insert(scheduledPosts).values({
      draftId: draft.id, platform: "x", text: "later", publishAt: new Date(Date.now() + 3_600_000),
    }).returning();
    const ahead = await outPost(db, { publishAt: new Date(Date.now() + 3_600_000), publishedAt: new Date(Date.now() + 3_600_000) });
    expect(await rateSchedule(db, queued.id, "good")).toMatchObject({ ok: false, code: "not_out" });
    expect(await rateSchedule(db, ahead.id, "good")).toMatchObject({ ok: false, code: "not_out" });
    expect(await rateSchedule(db, UNKNOWN_ID, "good")).toBeNull();
  });

  it("lists the posts to rate: out 1 to 60 days, no vote yet, newest first", async () => {
    const db = await createTestDb();
    await outPost(db, { publishAt: hoursAgo(24 * 61) }); // too old
    await outPost(db, { publishAt: hoursAgo(2) }); // results not in yet
    const older = await outPost(db, { publishAt: hoursAgo(48) });
    const newer = await outPost(db, { publishAt: hoursAgo(30), status: "published", postedBy: "api" });
    await outPost(db, { publishAt: hoursAgo(40), outcome: "good", ratedAt: new Date() }); // voted
    expect((await listToRate(db)).map((r) => r.id)).toEqual([newer.id, older.id]);
  });
});
```

- [ ] **Step 2: Run the tests and check they fail.**

  Run: `cd ~/PostEcho/web && npx vitest run src/lib/schedule.test.ts --testTimeout=30000`

  Expected: FAIL. `rateSchedule` is not a function.

- [ ] **Step 3: Implement it in `web/src/lib/schedule.ts`.**

  Add `"not_out"` to `ScheduleErrorCode`, and `not_out: 409,` to
  `SCHEDULE_ERROR_HTTP_STATUS`. Append at the end of the file:

```ts
// ---------------------------------------------------------------------------
// How did it do? (owner, 2026-09-26)
// ---------------------------------------------------------------------------

export type Outcome = NonNullable<ScheduledPost["outcome"]>;
/** A post is worth rating once its results are in: a day after it went out… */
export const RATE_AFTER_MS = 24 * 60 * 60 * 1000;
/** …and no longer after two months. */
export const RATE_WINDOW_MS = 60 * 24 * 60 * 60 * 1000;
const TO_RATE_LIMIT = 50;

/** Out: posted or published, and its time has come — the posts Plan asks "How did it do?" about. */
export function isOut(row: Pick<ScheduledPost, "status" | "publishAt">, now: Date = new Date()): boolean {
  return (row.status === "posted_manually" || row.status === "published") && row.publishAt.getTime() <= now.getTime();
}

/**
 * Plan's "How did it do?" (owner, 2026-09-26: "il tocco in plan serve sia se il post è andato
 * bene che se è andato male"): 👍 good or 👎 bad on a post that is out, null to take the vote
 * back. lib/taste.ts learns from the votes. A post not out yet is `not_out`; null for an
 * unknown id.
 */
export async function rateSchedule(
  db: ScheduleDb,
  id: string,
  outcome: Outcome | null,
  now: Date = new Date(),
): Promise<ScheduleResult | null> {
  const [row] = await db.select().from(scheduledPosts).where(eq(scheduledPosts.id, id)).limit(1);
  if (!row) return null;
  if (!isOut(row, now)) return { ok: false, code: "not_out", error: "this post isn't out yet" };
  const [updated] = await db
    .update(scheduledPosts)
    .set({ outcome, ratedAt: outcome === null ? null : now })
    .where(eq(scheduledPosts.id, id))
    .returning();
  return { ok: true, post: updated };
}

/**
 * Plan's To rate (2026-09-26): the posts out for more than a day and at most 60 days, with no
 * vote yet, newest first — the ones worth a 👍 or 👎 now that their results are in.
 */
export async function listToRate(db: ScheduleDb, now: Date = new Date()): Promise<ScheduleListItem[]> {
  const rows = await listSchedules(db, {
    from: new Date(now.getTime() - RATE_WINDOW_MS),
    to: new Date(now.getTime() - RATE_AFTER_MS),
  });
  return rows.filter((row) => isOut(row, now) && row.outcome === null).reverse().slice(0, TO_RATE_LIMIT);
}
```

- [ ] **Step 4: Run the tests and check they pass.**

  Run: `cd ~/PostEcho/web && npx vitest run src/lib/schedule.test.ts --testTimeout=30000`

  Expected: PASS.

- [ ] **Step 5: Commit.**

```bash
cd ~/PostEcho && git add web/src/lib/schedule.ts web/src/lib/schedule.test.ts && git commit -m "feat(plan): rate a post that is out, both ways; list the posts to rate

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 8: PostEcho, learning from the votes

**Files:**
- Modify: `web/src/lib/taste.ts`
- Test: `web/src/lib/taste.test.ts`

- [ ] **Step 1: Write the failing tests.**
  - Change the imports to `import { drafts, ideas, scheduledPosts } from "@/db/schema";` and
    `import { kindCountsOf, loadRatedIdeas, loadTasteExamples } from "@/lib/taste";`.
  - Append:

```ts
describe("votes in Plan (2026-09-26)", () => {
  type Db = Awaited<ReturnType<typeof createTestDb>>;
  /** An idea whose posts got these votes, the vote `votedMinutesAgo` ago. */
  async function ratedIdea(db: Db, content: string, outcomes: Array<"good" | "bad">, votedMinutesAgo: number, over: Partial<typeof ideas.$inferInsert> = {}) {
    const [idea] = await db.insert(ideas).values({ kind: "devto", content, status: "used", createdAt: at(500), ...over }).returning();
    for (const [i, outcome] of outcomes.entries()) {
      const [draft] = await db.insert(drafts).values({ ideaId: idea.id, xText: `${content} ${i}`, status: "used" }).returning();
      await db.insert(scheduledPosts).values({
        draftId: draft.id, platform: i % 2 === 0 ? "x" : "linkedin", text: `${content} ${i}`, status: "posted_manually",
        postedBy: "manual", publishAt: at(1000), publishedAt: at(1000), outcome, ratedAt: at(votedMinutesAgo),
      });
    }
    return idea;
  }

  it("a 👍 idea leads the kept examples and a 👎 one the skipped ones, before ♥, Use and Skip", async () => {
    const db = await createTestDb();
    await db.insert(ideas).values([
      { kind: "note", content: "used recently", status: "used", createdAt: at(1) },
      { kind: "note", content: "dismissed recently", status: "dismissed", createdAt: at(1) },
    ]);
    await ratedIdea(db, "did well", ["good"], 10);
    await ratedIdea(db, "didn't land", ["bad"], 20);
    const r = await loadTasteExamples(db as never);
    expect(r.kept).toEqual(["did well", "used recently"]);
    expect(r.skipped).toEqual(["didn't land", "dismissed recently"]);
  });

  it("good on one platform and bad on the other counts as good; the newest vote comes first", async () => {
    const db = await createTestDb();
    await ratedIdea(db, "older win", ["good"], 60);
    await ratedIdea(db, "split", ["good", "bad"], 5);
    const rated = await loadRatedIdeas(db as never);
    expect(rated.map((r) => [r.content, r.outcome])).toEqual([["split", "good"], ["older win", "good"]]);
    expect((await loadTasteExamples(db as never)).skipped).toEqual([]);
  });

  it("leaves YouTube ideas out of the votes too", async () => {
    const db = await createTestDb();
    await ratedIdea(db, "a video title", ["good"], 5, { kind: "youtube" });
    expect(await loadRatedIdeas(db as never)).toEqual([]);
  });

  it("counts the votes per kind, over ideas whose kind is one of the five", async () => {
    const db = await createTestDb();
    await ratedIdea(db, "s", ["good"], 5, { meta: { postKind: "story" } });
    await ratedIdea(db, "o", ["bad"], 6, { meta: { postKind: "opinion" } });
    await ratedIdea(db, "x", ["good"], 7, { meta: { postKind: "other" } });
    await ratedIdea(db, "none", ["good"], 8);
    const counts = kindCountsOf(await loadRatedIdeas(db as never));
    expect(counts.story).toEqual({ good: 1, bad: 0 });
    expect(counts.opinion).toEqual({ good: 0, bad: 1 });
    expect(counts.problem).toEqual({ good: 0, bad: 0 });
  });
});
```

- [ ] **Step 2: Run the tests and check they fail.**

  Run: `cd ~/PostEcho/web && npx vitest run src/lib/taste.test.ts --testTimeout=30000`

  Expected: FAIL. `loadRatedIdeas` is not a function.

- [ ] **Step 3: Rewrite `web/src/lib/taste.ts`.**

```ts
import { and, desc, eq, inArray, isNotNull, ne } from "drizzle-orm";
import { drafts, ideas, scheduledPosts } from "@/db/schema";
import type { db as Db } from "@/db";
import type { TasteExamples } from "jev-judge";
import { FIND_KIND_IDS, isFindKindId, type FindKindId } from "@/lib/find-kinds";

const MAX_EXAMPLES = 15;
const MAX_CHARS = 400;
/** Votes read per search: far more than the owner casts, enough never to cut a recent one. */
const MAX_RATED_ROWS = 200;

type Example = { id: string; content: string };

async function recentContent(db: typeof Db, statuses: Array<"used" | "dismissed" | "kept">, limit: number): Promise<Example[]> {
  const rows = await db
    .select({ id: ideas.id, content: ideas.content })
    .from(ideas)
    .where(and(inArray(ideas.status, statuses), isNotNull(ideas.content), ne(ideas.kind, "youtube")))
    .orderBy(desc(ideas.createdAt))
    .limit(limit);
  return rows.map((r) => ({ id: r.id, content: r.content! }));
}

/** An idea behind posts the owner voted on in Plan. */
export type RatedIdea = { id: string; content: string; postKind: unknown; outcome: "good" | "bad" };

/**
 * The ideas behind the owner's rated posts (Plan's 👍/👎, owner 2026-09-26), newest vote first:
 * good when any of its posts did well — the idea worked; the problem was elsewhere — and bad
 * when every rated one didn't land. YouTube ideas and ideas without text are left out, as in
 * the rest of taste.
 */
export async function loadRatedIdeas(db: typeof Db): Promise<RatedIdea[]> {
  const rows = await db
    .select({ id: ideas.id, content: ideas.content, meta: ideas.meta, outcome: scheduledPosts.outcome })
    .from(scheduledPosts)
    .innerJoin(drafts, eq(drafts.id, scheduledPosts.draftId))
    .innerJoin(ideas, eq(ideas.id, drafts.ideaId))
    .where(and(isNotNull(scheduledPosts.outcome), isNotNull(scheduledPosts.ratedAt), isNotNull(ideas.content), ne(ideas.kind, "youtube")))
    .orderBy(desc(scheduledPosts.ratedAt))
    .limit(MAX_RATED_ROWS);
  const byId = new Map<string, RatedIdea>();
  for (const row of rows) {
    const seen = byId.get(row.id);
    if (!seen) byId.set(row.id, { id: row.id, content: row.content!, postKind: row.meta?.postKind, outcome: row.outcome! });
    else if (row.outcome === "good") seen.outcome = "good";
  }
  return [...byId.values()];
}

/**
 * Builds jev-judge's `TasteExamples` from the owner's own behavior, each list capped at 15
 * ideas of 400 characters (the caps `judgePosts` applies too, explicit here):
 *
 * - `kept`: the ideas behind posts that did well (Plan's 👍, 2026-09-26) first — real results
 *   beat a first impression — then the most recent ideas marked `used` (Use) or `kept` (♥),
 *   interleaved by recency.
 * - `skipped`: the ideas behind posts that didn't land (👎) first, then the most recent
 *   `dismissed` ones.
 *
 * A rated idea appears once, on its vote's side. `youtube` ideas are left out of both lists:
 * a video title isn't a taste signal about the kind of *post* the owner wants scouted.
 */
export async function loadTasteExamples(db: typeof Db): Promise<TasteExamples> {
  const rated = await loadRatedIdeas(db);
  const ratedIds = new Set(rated.map((r) => r.id));
  const limit = MAX_EXAMPLES + ratedIds.size;
  const [kept, skipped] = await Promise.all([
    recentContent(db, ["used", "kept"], limit),
    recentContent(db, ["dismissed"], limit),
  ]);
  const unrated = (list: Example[]) => list.filter((e) => !ratedIds.has(e.id));
  const texts = (list: Example[]) => list.slice(0, MAX_EXAMPLES).map((e) => e.content.slice(0, MAX_CHARS));
  return {
    kept: texts([...rated.filter((r) => r.outcome === "good"), ...unrated(kept)]),
    skipped: texts([...rated.filter((r) => r.outcome === "bad"), ...unrated(skipped)]),
  };
}

export type KindCounts = Record<FindKindId, { good: number; bad: number }>;

/** 👍/👎 per kind of post, over rated ideas whose kind is one of the five — Settings shows them beside the order. */
export function kindCountsOf(rated: RatedIdea[]): KindCounts {
  const counts = Object.fromEntries(FIND_KIND_IDS.map((id) => [id, { good: 0, bad: 0 }])) as KindCounts;
  for (const idea of rated) {
    if (isFindKindId(idea.postKind)) counts[idea.postKind][idea.outcome]++;
  }
  return counts;
}
```

- [ ] **Step 4: Run the tests and check they pass.**

  Run: `cd ~/PostEcho/web && npx vitest run src/lib/taste.test.ts --testTimeout=30000`

  Expected: PASS. The old tests still pass unchanged.

- [ ] **Step 5: Commit.**

```bash
cd ~/PostEcho && git add web/src/lib/taste.ts web/src/lib/taste.test.ts && git commit -m "feat(search): votes in Plan lead the taste examples; counts per kind

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 9: PostEcho, the kind of an idea rated before kinds existed

**Files:**
- Create: `web/src/lib/idea-kind.ts`
- Test: `web/src/lib/idea-kind.test.ts`

- [ ] **Step 1: Write the failing tests.**

```ts
import { describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import type { JevClient } from "jev-judge";
import { createTestDb } from "@/test/db";
import { drafts, ideas } from "@/db/schema";
import { backfillIdeaKind } from "@/lib/idea-kind";

function jev(choice: string) {
  const systemOne = vi.fn(async () => ({ answers: { kind_0: { choice } } }));
  return { client: { systemOne } as JevClient, systemOne };
}

describe("the kind of an idea rated before kinds existed (2026-09-26)", () => {
  it("is asked of Jev once and kept in meta", async () => {
    const db = await createTestDb();
    const [idea] = await db.insert(ideas).values({ kind: "hackernews", title: "How I got to $46k a month", content: "a story", meta: { rank: 74 } }).returning();
    const [draft] = await db.insert(drafts).values({ ideaId: idea.id, xText: "post", status: "used" }).returning();
    const { client, systemOne } = jev("story");
    await backfillIdeaKind(db as never, draft.id, client);
    const [row] = await db.select().from(ideas).where(eq(ideas.id, idea.id));
    expect(row.meta).toMatchObject({ rank: 74, postKind: "story", kindFit: 1 });
    await backfillIdeaKind(db as never, draft.id, client);
    expect(systemOne).toHaveBeenCalledTimes(1);
  });

  it("leaves YouTube ideas and drafts without an idea alone, and survives a failed call", async () => {
    const db = await createTestDb();
    const [video] = await db.insert(ideas).values({ kind: "youtube", title: "a video", content: "t" }).returning();
    const [fromVideo] = await db.insert(drafts).values({ ideaId: video.id, xText: "p", status: "used" }).returning();
    const [loose] = await db.insert(drafts).values({ xText: "p", status: "used" }).returning();
    const { client, systemOne } = jev("story");
    await backfillIdeaKind(db as never, fromVideo.id, client);
    await backfillIdeaKind(db as never, loose.id, client);
    expect(systemOne).not.toHaveBeenCalled();

    const [idea] = await db.insert(ideas).values({ kind: "devto", content: "text" }).returning();
    const [draft] = await db.insert(drafts).values({ ideaId: idea.id, xText: "p", status: "used" }).returning();
    const failing = { systemOne: vi.fn(async () => { throw new Error("jev down"); }) } as unknown as JevClient;
    await expect(backfillIdeaKind(db as never, draft.id, failing)).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the tests and check they fail.**

  Run: `cd ~/PostEcho/web && npx vitest run src/lib/idea-kind.test.ts --testTimeout=30000`

  Expected: FAIL. Vitest can't resolve `@/lib/idea-kind`.

- [ ] **Step 3: Write `web/src/lib/idea-kind.ts`.**

```ts
import { eq } from "drizzle-orm";
import { classifyPosts, createJevClient, type JevClient } from "jev-judge";
import { drafts, ideas } from "@/db/schema";
import type { db as Db } from "@/db";
import { jevKinds } from "@/lib/find-kinds";
import { getSetting } from "@/lib/settings";

/** What Jev reads of the idea: its title and text, as the search saw them, bounded. */
const MAX_TEXT_CHARS = 2000;

/**
 * The kind of the idea behind a post the owner just rated, when the idea was found before
 * Find Ideas told kinds apart (2026-09-26): asked of Jev once and stored as
 * meta.postKind/kindFit, so Settings can count the vote by kind. Best effort — no Jev key, no
 * idea, a YouTube idea, one that already has a kind, or a failed call leave it as it is.
 */
export async function backfillIdeaKind(db: typeof Db, draftId: string, jev?: JevClient): Promise<void> {
  try {
    const [row] = await db
      .select({ id: ideas.id, kind: ideas.kind, title: ideas.title, content: ideas.content, meta: ideas.meta })
      .from(drafts)
      .innerJoin(ideas, eq(ideas.id, drafts.ideaId))
      .where(eq(drafts.id, draftId))
      .limit(1);
    if (!row || row.kind === "youtube" || typeof row.meta?.postKind === "string") return;
    const text = [row.title, row.content].filter(Boolean).join("\n\n").slice(0, MAX_TEXT_CHARS);
    if (!text) return;
    const client = jev ?? (process.env.TYPESAFE_API_KEY ? createJevClient() : null);
    if (!client) return;
    const kinds = jevKinds(await getSetting(db as never, "findOrder"));
    const [judged] = await classifyPosts(client, { posts: [{ id: row.id, text }], kinds });
    if (!judged?.kind) return;
    await db.update(ideas)
      .set({ meta: { ...row.meta, postKind: judged.kind, kindFit: judged.kindFit } })
      .where(eq(ideas.id, row.id));
  } catch (e) {
    console.warn("[idea-kind] couldn't read the kind of the rated idea", e);
  }
}
```

- [ ] **Step 4: Run the tests and check they pass.**

  Run: `cd ~/PostEcho/web && npx vitest run src/lib/idea-kind.test.ts --testTimeout=30000`

  Expected: PASS.

- [ ] **Step 5: Commit.**

```bash
cd ~/PostEcho && git add web/src/lib/idea-kind.ts web/src/lib/idea-kind.test.ts && git commit -m "feat(plan): an idea rated before kinds existed learns its kind

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 10: PostEcho, the routes

**Files:**
- Modify: `web/src/app/api/scheduled-posts/[id]/route.ts` and
  `web/src/app/api/scheduled-posts/route.ts`
- Modify: `web/src/app/api/settings/route.ts`
- Test: `web/src/app/api/scheduled-posts/scheduled-posts.test.ts` and
  `web/src/app/api/settings/settings-api.test.ts`

- [ ] **Step 1: Write the failing tests for the scheduled-posts routes.** In
  `scheduled-posts.test.ts`:
  - Add these two mocks after the `@/lib/email` mock:

```ts
// The vote's kind backfill runs after the response (next/server's after): run it at once, faked.
vi.mock("next/server", async (orig) => ({ ...(await orig()), after: vi.fn((task: () => unknown) => { void task(); }) }));
vi.mock("@/lib/idea-kind", () => ({ backfillIdeaKind: vi.fn(async () => {}) }));
```

  - Change the `[id]/route` import to `const { DELETE, PATCH } = await import("@/app/api/scheduled-posts/[id]/route");`.
  - Append:

```ts
describe("PATCH /api/scheduled-posts/:id — How did it do? (2026-09-26)", () => {
  const patch = (id: string, body: unknown) => PATCH(jsonReq(`http://test/api/scheduled-posts/${id}`, "PATCH", body), params(id));
  async function outRow() {
    const draft = await insertDraft();
    const hourAgo = new Date(Date.now() - 3_600_000);
    const [row] = await state.db!.insert(scheduledPosts).values({
      draftId: draft.id, platform: "x", text: "hello", status: "posted_manually", postedBy: "manual", publishAt: hourAgo, publishedAt: hourAgo,
    }).returning();
    return row;
  }

  it("saves a vote, asks for the idea's kind after the response, and takes the vote back", async () => {
    const { backfillIdeaKind } = await import("@/lib/idea-kind");
    const row = await outRow();
    const res = await patch(row.id, { outcome: "good" });
    expect(res.status).toBe(200);
    expect((await res.json()).post).toMatchObject({ outcome: "good" });
    expect(backfillIdeaKind).toHaveBeenCalledWith(expect.anything(), row.draftId);
    const cleared = await patch(row.id, { outcome: null });
    expect((await cleared.json()).post).toMatchObject({ outcome: null, ratedAt: null });
  });

  it("409 for a post that isn't out; 400 for a bad vote or one mixed with an edit; 404 for an unknown id", async () => {
    const draft = await insertDraft();
    const [queued] = await state.db!.insert(scheduledPosts).values({ draftId: draft.id, platform: "x", text: "hello", publishAt: new Date(FUTURE) }).returning();
    expect((await patch(queued.id, { outcome: "good" })).status).toBe(409);
    const row = await outRow();
    expect((await patch(row.id, { outcome: "meh" })).status).toBe(400);
    expect((await patch(row.id, { outcome: "good", text: "x" })).status).toBe(400);
    expect((await patch(UNKNOWN_ID, { outcome: "good" })).status).toBe(404);
  });
});

describe("GET /api/scheduled-posts?toRate=1 (2026-09-26)", () => {
  it("lists the posts out for more than a day with no vote", async () => {
    const draft = await insertDraft();
    const dayAgo = new Date(Date.now() - 30 * 3_600_000);
    const [row] = await state.db!.insert(scheduledPosts).values({
      draftId: draft.id, platform: "x", text: "hello", status: "posted_manually", postedBy: "manual", publishAt: dayAgo, publishedAt: dayAgo,
    }).returning();
    const body = await (await GET(listReq("?toRate=1"))).json();
    expect(body.posts.map((p: { id: string }) => p.id)).toEqual([row.id]);
  });
});
```

- [ ] **Step 2: Write the failing tests for the settings route.** In
  `settings-api.test.ts`:
  - Change the schema import to `import { drafts, ideas, scheduledPosts } from "@/db/schema";`.
  - Change the two `tasteCounts` expectations to `{ kept: 0, skipped: 0, rated: 0 }` and
    `{ kept: 2, skipped: 1, rated: 0 }`.
  - Append:

```ts
describe("what to show you first (2026-09-26)", () => {
  it("returns the default order, and saves a new one", async () => {
    expect((await (await GET()).json()).settings.findOrder).toEqual(["story", "opinion", "problem", "news", "tool"]);
    expect((await put({ findOrder: ["opinion", "story", "problem", "news", "tool"] })).status).toBe(200);
    expect((await (await GET()).json()).settings.findOrder).toEqual(["opinion", "story", "problem", "news", "tool"]);
  });

  it("rejects an order with a kind missing, repeated or unknown", async () => {
    expect((await put({ findOrder: ["story", "opinion"] })).status).toBe(400);
    expect((await put({ findOrder: ["story", "story", "problem", "news", "tool"] })).status).toBe(400);
    expect((await put({ findOrder: ["story", "poem", "problem", "news", "tool"] })).status).toBe(400);
  });

  it("counts the votes per kind", async () => {
    const [idea] = await state.db!.insert(ideas).values({ kind: "devto", content: "c", status: "used", meta: { postKind: "story" } }).returning();
    const [draft] = await state.db!.insert(drafts).values({ ideaId: idea.id, xText: "p", status: "used" }).returning();
    await state.db!.insert(scheduledPosts).values({
      draftId: draft.id, platform: "x", text: "p", status: "posted_manually", postedBy: "manual",
      publishAt: new Date(Date.now() - 86_400_000), outcome: "good", ratedAt: new Date(),
    });
    const body = await (await GET()).json();
    expect(body.kindCounts.story).toEqual({ good: 1, bad: 0 });
    expect(body.tasteCounts.rated).toBe(1);
  });
});
```

- [ ] **Step 3: Run the tests and check they fail.**

  Run: `cd ~/PostEcho/web && npx vitest run src/app/api/scheduled-posts/scheduled-posts.test.ts src/app/api/settings/settings-api.test.ts --testTimeout=30000`

  Expected: FAIL in the new tests.

- [ ] **Step 4: Implement the PATCH vote.** In `[id]/route.ts`:
  - Add `import { after } from "next/server";` and
    `import { backfillIdeaKind } from "@/lib/idea-kind";`.
  - Change the schedule import to
    `import { cancelSchedule, rateSchedule, SCHEDULE_ERROR_HTTP_STATUS, updateSchedule } from "@/lib/schedule";`.
  - After `PatchBody`, add:

```ts
// Plan's "How did it do?" (2026-09-26): a vote, or null to take it back — alone, never with an edit.
const RateBody = z.object({ outcome: z.enum(["good", "bad"]).nullable() }).strict();
```

  - In `PATCH`, replace
    `const parsed = PatchBody.safeParse(await request.json().catch(() => null));` with:

```ts
  const body = await request.json().catch(() => null);
  if (body !== null && typeof body === "object" && "outcome" in body) return rate(id, body);
  const parsed = PatchBody.safeParse(body);
```

  - Add to the PATCH doc comment:
    ` * \`{ outcome: "good" | "bad" | null }\` instead is Plan's vote on a post that is out (rateSchedule): 409 when it isn't out.`
  - Add below `PATCH`:

```ts
/** The vote: saved, then — after the response — the idea behind it learns its kind if it has none (lib/idea-kind.ts). */
async function rate(id: string, body: unknown): Promise<Response> {
  const parsed = RateBody.safeParse(body);
  if (!parsed.success) return Response.json({ error: "bad request" }, { status: 400 });
  try {
    const result = await rateSchedule(db, id, parsed.data.outcome);
    if (!result) return Response.json({ error: "not found" }, { status: 404 });
    if (!result.ok) return Response.json({ error: result.error, code: result.code }, { status: SCHEDULE_ERROR_HTTP_STATUS[result.code] });
    if (parsed.data.outcome !== null) {
      const draftId = result.post.draftId;
      after(() => backfillIdeaKind(db, draftId));
    }
    return Response.json({ post: result.post });
  } catch (e) {
    console.error(e);
    return Response.json({ error: "internal error" }, { status: 500 });
  }
}
```

- [ ] **Step 5: Implement GET `?toRate=1`.** In `scheduled-posts/route.ts`:
  - Add `listToRate` to the `@/lib/schedule` import.
  - In `GET`, right after `const params = new URL(request.url).searchParams;`, add:

```ts
  // Plan's To rate pill (2026-09-26): posts out for more than a day with no vote yet, from any month.
  if (params.get("toRate") === "1") {
    try {
      return Response.json({ posts: await listToRate(db) });
    } catch (e) {
      console.error(e);
      return Response.json({ error: "internal error" }, { status: 500 });
    }
  }
```

- [ ] **Step 6: Implement the settings changes.** In `api/settings/route.ts`:
  - Add `import { FIND_KIND_IDS, normalizeOrder, type FindKindId } from "@/lib/find-kinds";`.
  - Change the taste import to
    `import { kindCountsOf, loadRatedIdeas, loadTasteExamples } from "@/lib/taste";`.
  - In `Body`, after `disabledSources`, add:

```ts
  // What Find Ideas shows first (2026-09-26): all five kinds, each once, most wanted first.
  findOrder: z.array(z.enum(FIND_KIND_IDS as [FindKindId, ...FindKindId[]])).length(FIND_KIND_IDS.length)
    .refine((order) => new Set(order).size === order.length, { message: "each kind once" }).optional(),
```

  - In `GET`, replace the `entries` computation and the return with:

```ts
    const entries = await Promise.all(
      SETTING_KEYS.map(async (key): Promise<[SettingKey, unknown]> => {
        const value = await getSetting(db, key);
        // A broken stored order still reaches the page as a valid one.
        return [key, key === "findOrder" ? normalizeOrder(value) : value];
      }),
    );
    // Computed, not stored: the same taste examples lib/scout-run.ts feeds to
    // judgePosts, surfaced as counts for the Settings hints, and Plan's votes per kind.
    const [taste, x, rated] = await Promise.all([loadTasteExamples(db), loadXConfig(db), loadRatedIdeas(db)]);
    return Response.json({
      settings: Object.fromEntries(entries),
      tasteCounts: { kept: taste.kept.length, skipped: taste.skipped.length, rated: rated.length },
      kindCounts: kindCountsOf(rated),
      x: { connected: x.token !== null, hint: keyHint(x.token) },
    });
```

- [ ] **Step 7: Run the tests and check they pass.**

  Run: `cd ~/PostEcho/web && npx vitest run src/app/api/scheduled-posts/scheduled-posts.test.ts src/app/api/settings/settings-api.test.ts --testTimeout=30000`

  Expected: PASS.

- [ ] **Step 8: Commit.**

```bash
cd ~/PostEcho && git add web/src/app/api && git commit -m "feat(api): Plan's vote and the posts to rate; the find order and votes per kind in Settings

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 11: PostEcho, Plan's vote and To rate

**Files:**
- Modify: `web/src/components/plan/plan-calendar.ts` and its test
- Modify: `web/src/components/plan/schedule-card.tsx` and its test
- Create: `web/src/components/plan/rate-list.tsx`
- Modify: `web/src/components/plan/day-list.tsx` and `web/src/components/plan/plan-view.tsx`

- [ ] **Step 1: Write the failing tests.**
  - In `plan-calendar.test.ts`, add `isOutStatus` to the import from `./plan-calendar` and
    append:

```ts
describe("posts that are out (2026-09-26)", () => {
  it("are the published and posted ones — a post scheduled on the platform isn't out yet", () => {
    expect(isOutStatus("published")).toBe(true);
    expect(isOutStatus("posted_manually")).toBe(true);
    for (const status of ["scheduled", "queued", "emailed", "failed", "canceled"] as const) expect(isOutStatus(status)).toBe(false);
  });
});
```

  - In `schedule-card.test.ts`, change the import to
    `import { editChanges, isEditable, RateCard, ScheduleCard, ScheduleEditDialog, SourceLink } from "./schedule-card";`
    and append:

```ts
describe("How did it do? (2026-09-26)", () => {
  const rendered = (p: PlanPost) => renderToStaticMarkup(createElement(ScheduleCard, {
    post: p, now: "2030-01-15T10:00:00.000Z", busy: null, error: null, onAction: () => {}, onRate: () => {},
  }));

  it("asks on posts that are out, never on queued, emailed, failed or scheduled ones", () => {
    for (const status of ["posted_manually", "published"] as const) expect(rendered(post(status))).toContain("How did it do?");
    for (const status of ["queued", "emailed", "failed", "scheduled"] as const) expect(rendered(post(status))).not.toContain("How did it do?");
  });

  it("shows the vote pressed", () => {
    const html = rendered(post("posted_manually", { outcome: "good" }));
    expect(html).toMatch(/aria-pressed="true"[^>]*>.*?Did well/);
    expect(html).toMatch(/aria-pressed="false"[^>]*>.*?Didn(&#x27;|')t land/);
  });

  it("the To rate list's card asks too", () => {
    const html = renderToStaticMarkup(createElement(RateCard, { post: post("published"), onRate: () => {} }));
    expect(html).toContain("How did it do?");
    expect(html).toContain("The scheduled text");
  });
});
```

- [ ] **Step 2: Run the tests and check they fail.**

  Run: `cd ~/PostEcho/web && npx vitest run src/components/plan --testTimeout=30000`

  Expected: FAIL. `isOutStatus` and `RateCard` don't exist.

- [ ] **Step 3: Add to `plan-calendar.ts`.**
  - After the `PlanStatus` type:

```ts
/** Plan's vote on a post that is out (2026-09-26: "sia se è andato bene che se è andato male") — lib/schedule.ts's rateSchedule. */
export type PlanOutcome = "good" | "bad";
```

  - In `PlanPost`, after `sourceUrl`:

```ts
  /** The owner's vote on how it did; null or absent until they vote. */
  outcome?: PlanOutcome | null;
```

  - After `displayStatus`:

```ts
/** Out — published or posted, its time come (a post still ahead reads "scheduled", see displayStatus): Plan asks how it did. */
export function isOutStatus(status: PlanStatus): boolean {
  return status === "published" || status === "posted_manually";
}
```

- [ ] **Step 4: Add `RateRow` and `RateCard`, and wire `ScheduleCard`.** In
  `schedule-card.tsx`:
  - Change the `./plan-calendar` import to also bring `isOutStatus` and
    `type PlanOutcome`.
  - After `chipCls`, add:

```tsx
const rateBaseCls = "inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs disabled:opacity-50";

/** A thumb in the line style of Settings' tab icons; `down` turns it over. */
function ThumbIcon({ down = false }: { down?: boolean }) {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" className={`h-3.5 w-3.5 shrink-0 ${down ? "rotate-180" : ""}`}
      fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
      <path d="M2.5 7.5h2.5v6H2.5zM5 7.5l2.6-5c1 0 1.7.8 1.5 1.8L8.6 7h3.6c.9 0 1.6.9 1.4 1.8l-.9 3.8c-.2.7-.8 1.2-1.5 1.2H5" />
    </svg>
  );
}

/**
 * "How did it do?" on a post that is out (owner, 2026-09-26: "il tocco in plan serve sia se
 * il post è andato bene che se è andato male"): Did well or Didn't land, as toggles — the
 * pressed one again takes the vote back. Find Ideas learns from the votes (lib/taste.ts).
 */
export function RateRow({ outcome, disabled = false, onRate }: {
  outcome: PlanOutcome | null;
  disabled?: boolean;
  onRate: (next: PlanOutcome | null) => void;
}) {
  const vote = (value: PlanOutcome, label: string, pressedCls: string) => (
    <button
      type="button"
      aria-pressed={outcome === value}
      disabled={disabled}
      onClick={() => onRate(outcome === value ? null : value)}
      className={`${rateBaseCls} ${outcome === value ? pressedCls : "border-border text-text-dim hover:text-text"}`}
    >
      <ThumbIcon down={value === "bad"} />
      {label}
    </button>
  );
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs text-text-dim">
      <span>How did it do?</span>
      {vote("good", "Did well", "border-ok/60 text-ok")}
      {vote("bad", "Didn't land", "border-danger/60 text-danger")}
    </div>
  );
}
```

  - In the `ScheduleCard` props type, add:

```tsx
  /** Plan's vote on a post that is out: the parent saves it (PATCH /api/scheduled-posts/:id). */
  onRate?: (post: PlanPost, outcome: PlanOutcome | null) => void;
  /** A vote on THIS card is being saved. */
  rating?: boolean;
```

  - Destructure `onRate, rating = false` in the signature.
  - Right after the `Posted · …` paragraph, add:

```tsx
      {onRate && isOutStatus(post.status) && (
        <RateRow outcome={post.outcome ?? null} disabled={rating} onRate={(next) => onRate(post, next)} />
      )}
```

  - After `ArchiveCard`, add:

```tsx
/**
 * A post waiting for its vote in Plan's To rate list (rate-list.tsx): the platform, the day
 * and time it went out, what it said, and "How did it do?".
 */
export function RateCard({ post, rating = false, error = null, onRate }: {
  post: PlanPost;
  rating?: boolean;
  error?: string | null;
  onRate: (post: PlanPost, outcome: PlanOutcome | null) => void;
}) {
  const slot = slotLabel(post.publishAt);
  return (
    <article aria-label={`${PLATFORM_LABEL[post.platform]} post from ${slot}, to rate`} className={cardCls}>
      <div className="flex min-w-0 items-center gap-2 text-sm text-text-dim">
        <span className={platformPillCls}>{PLATFORM_TAG[post.platform]}</span>
        <span className="shrink-0 font-medium text-text">{slot}</span>
        {post.ideaTitle && <span className="min-w-0 truncate" title={post.ideaTitle}>{post.ideaTitle}</span>}
      </div>
      <PostText post={post} />
      <RateRow outcome={post.outcome ?? null} disabled={rating} onRate={(next) => onRate(post, next)} />
      {error && <p className="text-xs text-danger">{error}</p>}
    </article>
  );
}
```

- [ ] **Step 5: Create `rate-list.tsx`.**

```tsx
"use client";

import { RateCard } from "./schedule-card";
import { type PlanOutcome, type PlanPost } from "./plan-calendar";

// The Today pill's shape (month-grid.tsx's MonthNav), like archive-list.tsx's Back.
const backPillCls = "rounded-full border border-border px-3 py-1 text-xs font-medium text-text-dim hover:text-text";

/**
 * Plan's To rate (owner, 2026-09-26): the posts out for more than a day with no vote yet,
 * from any month, newest first (lib/schedule.ts's listToRate). It takes the day list's place
 * while open, like the Archive; a vote takes its card off at once.
 */
export function RateList({ posts, rating, errors, onRate, onBack }: {
  posts: PlanPost[];
  /** The post whose vote is being saved, if any. */
  rating: string | null;
  errors: Record<string, string>;
  onRate: (post: PlanPost, outcome: PlanOutcome | null) => void;
  onBack: () => void;
}) {
  return (
    <section aria-label="To rate" className="min-w-0 space-y-3">
      <div className="flex items-center justify-between gap-3">
        <h2 className="font-semibold">
          To rate<span className="text-text-dim"> · how did they do?</span>
        </h2>
        <button type="button" onClick={onBack} className={backPillCls}>Back</button>
      </div>

      {posts.length === 0 && <p className="text-sm text-text-dim">Nothing left to rate.</p>}

      <ul className="space-y-3">
        {posts.map((post) => (
          <li key={post.id}>
            <RateCard post={post} rating={rating === post.id} error={errors[post.id] ?? null} onRate={onRate} />
          </li>
        ))}
      </ul>
    </section>
  );
}
```

- [ ] **Step 6: Pass the vote through `DayList`.**
  - Add `type PlanOutcome` to its `./plan-calendar` import.
  - Add to its props, destructured as `rating = null, onRate`:

```tsx
  /** The post whose vote is being saved, if any. */
  rating?: string | null;
  /** Plan's vote on a post that is out (schedule-card.tsx's RateRow). */
  onRate?: (post: PlanPost, outcome: PlanOutcome | null) => void;
```

  - Pass `rating={rating === row.post.id}` and `onRate={onRate}` to `ScheduleCard`.

- [ ] **Step 7: Wire `PlanView`.**
  - Imports: add `import { RateList } from "./rate-list";`, and add `type PlanOutcome` to the
    `./plan-calendar` import.
  - Change `View` to `type View = "days" | "archive" | "rate";` and update its comment:
    "…the month's Archive of canceled rows, or the posts to rate."
  - After the `cardErrors` state, add:

```tsx
  // Posts out for more than a day with no vote yet, from any month (the header's To rate pill).
  const [toRate, setToRate] = useState<PlanPost[]>([]);
  // The post whose vote is being saved.
  const [rating, setRating] = useState<string | null>(null);
```

  - After the default-slots effect, add:

```tsx
  // The posts to rate, fetched again with the grid (refreshKey). Optional: without them there's no pill.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/scheduled-posts?toRate=1");
        if (!res.ok) return;
        const body = await res.json();
        if (!cancelled) setToRate(Array.isArray(body?.posts) ? body.posts : []);
      } catch (e) {
        console.error("failed to load the posts to rate:", e);
      }
    })();
    return () => { cancelled = true; };
  }, [refreshKey]);
```

  - After `edit`, add:

```tsx
  /**
   * Plan's vote (2026-09-26): PATCH /api/scheduled-posts/:id { outcome }, shown at once — on
   * the card, and off the To rate list — then the server's truth comes back with the refetch.
   */
  async function rate(post: PlanPost, outcome: PlanOutcome | null) {
    if (rating) return;
    setRating(post.id);
    setCardErrors((current) => {
      const next = { ...current };
      delete next[post.id];
      return next;
    });
    setLoaded((current) => (current
      ? { ...current, posts: current.posts.map((p) => (p.id === post.id ? { ...p, outcome } : p)) }
      : current));
    if (outcome !== null) setToRate((current) => current.filter((p) => p.id !== post.id));
    try {
      const res = await fetch(`/api/scheduled-posts/${post.id}`, { method: "PATCH", headers: JSON_HEADERS, body: JSON.stringify({ outcome }) });
      if (!res.ok) {
        const message = await errorOf(res, "Failed to save the vote.");
        setCardErrors((current) => ({ ...current, [post.id]: message }));
      }
    } catch (e) {
      console.error("plan: vote failed:", e);
      setCardErrors((current) => ({ ...current, [post.id]: "Network error: the vote wasn't saved." }));
    } finally {
      setRating(null);
      setRefreshKey((k) => k + 1);
    }
  }
```

  - In the header, before the Archive pill:

```tsx
            {(toRate.length > 0 || view === "rate") && (
              <button
                type="button"
                onClick={() => setView((current) => (current === "rate" ? "days" : "rate"))}
                aria-pressed={view === "rate"}
                className={`${archivePillCls} ${view === "rate" ? "bg-surface-2 text-text" : "text-text-dim"}`}
              >
                To rate ({toRate.length})
              </button>
            )}
```

  - Replace the side-panel ternary with:

```tsx
        {view === "archive"
          ? <ArchiveList posts={archive} onBack={() => setView("days")} />
          : view === "rate"
            ? <RateList posts={toRate} rating={rating} errors={cardErrors} onRate={rate} onBack={() => setView("days")} />
            : (
              <DayList
                day={day}
                isToday={day === today}
                rows={rows}
                now={now}
                busy={busy}
                errors={cardErrors}
                onAction={act}
                onEdit={edit}
                rating={rating}
                onRate={rate}
              />
            )}
```

- [ ] **Step 8: Run the tests, lint and types.**

  Run: `cd ~/PostEcho/web && npx vitest run src/components/plan --testTimeout=30000 && npx eslint src/components/plan && npx tsc --noEmit`

  Expected: PASS, with no lint or type errors.

- [ ] **Step 9: Commit.**

```bash
cd ~/PostEcho && git add web/src/components/plan && git commit -m "feat(plan): How did it do? on posts that are out, and a To rate pill

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 12: PostEcho, "What to show you first" in Settings

**Files:**
- Create: `web/src/components/settings/find-order.tsx`
- Modify: `web/src/components/settings/settings-panel.tsx`
- Test: `web/src/components/settings/settings-panel.test.ts`

- [ ] **Step 1: Write the failing tests.**
  - In `settings-panel.test.ts`, add `import { countLabel, FindOrderList } from "./find-order";`.
  - In the test "saves every field typed here…", add `findOrder: ["opinion", "story"]` to the
    `s` object, and add
    `expect(payload.findOrder).toEqual(["opinion", "story", "problem", "news", "tool"]);`.
  - Append:

```ts
describe("What to show you first (2026-09-26)", () => {
  it("lists the kinds in the saved order, numbered, with arrows that stop at the ends", () => {
    const html = renderToStaticMarkup(createElement(FindOrderList, {
      order: ["opinion", "story", "problem", "news", "tool"], counts: { story: { good: 3, bad: 1 } }, onChange: () => {},
    }));
    expect(html.indexOf("Strong opinions")).toBeLessThan(html.indexOf("Real stories with numbers"));
    expect(html).toContain("3 did well · 1 didn&#x27;t");
    expect(html).toMatch(/aria-label="Move Strong opinions up"[^>]*disabled=""/);
    expect(html).toMatch(/aria-label="Move Tools and guides down"[^>]*disabled=""/);
    // Plain words: neither the judge's name nor its number.
    expect(html).not.toContain("Jev");
    expect(html).not.toContain("✦");
  });

  it("says nothing about votes before there are any", () => {
    expect(countLabel(undefined)).toBeNull();
    expect(countLabel({ good: 0, bad: 0 })).toBeNull();
    expect(countLabel({ good: 2, bad: 0 })).toBe("2 did well · 0 didn't");
  });
});
```

- [ ] **Step 2: Run the tests and check they fail.**

  Run: `cd ~/PostEcho/web && npx vitest run src/components/settings/settings-panel.test.ts --testTimeout=30000`

  Expected: FAIL. Vitest can't resolve `./find-order`.

- [ ] **Step 3: Create `find-order.tsx`.**

```tsx
"use client";

import { useState } from "react";
import { FIND_KINDS, moveKind, normalizeOrder, type FindKindId } from "@/lib/find-kinds";

/** GET /api/settings's `kindCounts`: Plan's votes per kind (lib/taste.ts's kindCountsOf). */
export type KindCounts = Partial<Record<FindKindId, { good: number; bad: number }>>;

const arrowCls = "rounded-full border border-border px-2 py-0.5 text-xs text-text-dim hover:text-text disabled:opacity-30";

/** "3 did well · 1 didn't" beside a kind, or null before any vote. */
export function countLabel(count: { good: number; bad: number } | undefined): string | null {
  if (!count || count.good + count.bad === 0) return null;
  return `${count.good} did well · ${count.bad} didn't`;
}

/**
 * What to show you first (owner, 2026-09-26: "vuoi rendere ordinabili l'importanza di queste…
 * così sono prioritizzate?" — and "rendilo più semplice e meno tecnico. deve capirlo
 * chiunque"): the five kinds of post, dragged into order on a desktop, moved with the arrows
 * on a phone or the keyboard. Position is priority. Each row names the kind, gives an example
 * and, once there are votes in Plan, how that kind did.
 */
export function FindOrderList({ order, counts, onChange }: {
  order: string[];
  counts: KindCounts | null;
  onChange: (next: FindKindId[]) => void;
}) {
  const ids = normalizeOrder(order);
  const [dragFrom, setDragFrom] = useState<number | null>(null);
  const byId = new Map(FIND_KINDS.map((kind) => [kind.id, kind]));

  return (
    <ol>
      {ids.map((id, i) => {
        const kind = byId.get(id)!;
        const count = countLabel(counts?.[id]);
        return (
          <li
            key={id}
            draggable
            onDragStart={(e) => {
              setDragFrom(i);
              e.dataTransfer.effectAllowed = "move";
              // Firefox starts a drag only with data set.
              e.dataTransfer.setData("text/plain", id);
            }}
            onDragOver={(e) => { if (dragFrom !== null) e.preventDefault(); }}
            onDrop={(e) => {
              e.preventDefault();
              if (dragFrom !== null && dragFrom !== i) onChange(moveKind(ids, dragFrom, i));
              setDragFrom(null);
            }}
            onDragEnd={() => setDragFrom(null)}
            className={`flex items-center gap-3 border-b border-border px-4 py-2.5 text-sm last:border-b-0 ${dragFrom === i ? "opacity-50" : ""}`}
          >
            <span aria-hidden className="cursor-grab select-none text-text-dim">⋮⋮</span>
            <span className="w-4 shrink-0 text-xs text-text-dim">{i + 1}</span>
            <span className="min-w-0 flex-1">
              <span className="block">{kind.name}</span>
              <span className="block truncate text-xs text-text-dim">
                “{kind.example}”{count ? ` · ${count}` : ""}
              </span>
            </span>
            <span className="flex shrink-0 gap-1">
              <button type="button" aria-label={`Move ${kind.name} up`} disabled={i === 0}
                onClick={() => onChange(moveKind(ids, i, i - 1))} className={arrowCls}>↑</button>
              <button type="button" aria-label={`Move ${kind.name} down`} disabled={i === ids.length - 1}
                onClick={() => onChange(moveKind(ids, i, i + 1))} className={arrowCls}>↓</button>
            </span>
          </li>
        );
      })}
    </ol>
  );
}
```

- [ ] **Step 4: Wire the panel.** In `settings-panel.tsx`:
  - Add `import { FindOrderList, type KindCounts } from "@/components/settings/find-order";`
    and `import { normalizeOrder } from "@/lib/find-kinds";`.
  - In `Settings`, add `findOrder: string[];` after `disabledSources`.
  - Change `TasteCounts` to `type TasteCounts = { kept: number; skipped: number; rated?: number };`.
  - In `settingsPayload`, after `scoutCandidatesPerSource`, add
    `findOrder: normalizeOrder(s.findOrder),`.
  - After the `tasteCounts` state, add
    `const [kindCounts, setKindCounts] = useState<KindCounts | null>(null);`.
  - Change `applyLoaded`'s parameter type to
    `{ settings: Settings; tasteCounts?: TasteCounts; kindCounts?: KindCounts; x?: XKeyStatus }`,
    and add `setKindCounts(data.kindCounts ?? null);` after `setTasteCounts(...)`.
  - Update the `// "sources":` comment above `SettingsTab` to: `// "sources": what to show
    first, every source (each connected or not; X with the owner's key), then the
    Advanced numbers;`.
  - Replace the whole `case "sources":` return with:

```tsx
      case "sources":
        return (
          <>
            <Group
              title="What to show you first"
              hint="Drag to reorder. Types higher up come first in your searches. PostEcho also learns from what you like, dismiss and rate in Plan."
            >
              <FindOrderList order={settings.findOrder} counts={kindCounts} onChange={(next) => set("findOrder", next)} />
            </Group>
            <Group title="Sources" hint={sourceError ?? "Connected sources are read by every search. Connecting and disconnecting save at once."}>
              {/* the existing sources rows, unchanged */}
            </Group>
            {/* The numbers behind a search (2026-09-26: "deve capirlo chiunque"): out of the way until asked for. */}
            <details className="space-y-2">
              <summary className="cursor-pointer text-sm font-semibold text-text-dim hover:text-text">Advanced</summary>
              <Group
                hint={<>Each search keeps going, up to 4 rounds, until it has that many results over the minimum score, then keeps the best across every source.{tasteCounts ? ` Learning from ${tasteCounts.kept} liked or used · ${tasteCounts.skipped} dismissed · ${tasteCounts.rated ?? 0} rated posts.` : ""}</>}
              >
                <Row label="Minimum score" hint="Ideas scoring below it are never saved (0–100)">
                  <input type="number" min={0} max={100} className={inputCls} value={settings.scoutMinScore} onChange={(e) => set("scoutMinScore", Number(e.target.value))} />
                </Row>
                <Row label="Results per search" hint="The best across all sources (5–50)">
                  <input type="number" min={5} max={50} className={inputCls} value={settings.scoutResultsTotal} onChange={(e) => set("scoutResultsTotal", Number(e.target.value))} />
                </Row>
                <Row label="Candidates per source" hint="Judged per round (5–50)">
                  <input type="number" min={5} max={50} className={inputCls} value={settings.scoutCandidatesPerSource} onChange={(e) => set("scoutCandidatesPerSource", Number(e.target.value))} />
                </Row>
              </Group>
            </details>
          </>
        );
```

  The `{/* the existing sources rows, unchanged */}` line is not literal code. Move the whole
  current `{sources ? sources.map(...) : <p …>Loading…</p>}` expression there, byte for byte.

- [ ] **Step 5: Run the tests, lint and types.**

  Run: `cd ~/PostEcho/web && npx vitest run src/components/settings --testTimeout=30000 && npx eslint src/components/settings && npx tsc --noEmit`

  Expected: PASS, with no lint or type errors.

- [ ] **Step 6: Commit.**

```bash
cd ~/PostEcho && git add web/src/components/settings && git commit -m "feat(settings): What to show you first — drag the kinds into order; the numbers under Advanced

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 13: PostEcho, the card's right-click menu

**Files:**
- Create: `web/src/components/card-menu.tsx`
- Test: `web/src/components/card-menu.test.ts`
- Modify: `web/src/components/idea-card.tsx` and
  `web/src/components/settings/style-inspiration-section.tsx`

- [ ] **Step 1: Write the failing tests in `card-menu.test.ts`.**

```ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createLongPress, keepsBrowserMenu, LONG_PRESS_MS } from "./card-menu";
import { IdeaCard, type Idea } from "./idea-card";
import { StyleInspirationSection } from "./settings/style-inspiration-section";

const target = (onLinkOrField: boolean) => ({ closest: () => (onLinkOrField ? {} : null) }) as unknown as EventTarget;

describe("the card's own menu (2026-09-26: \"togli anche Aa… selezionabile con tasto destro sulla card\")", () => {
  afterEach(() => vi.useRealTimers());

  it("leaves the browser's menu on links and fields, and on selected text", () => {
    expect(keepsBrowserMenu(target(true), false)).toBe(true);
    expect(keepsBrowserMenu(target(false), true)).toBe(true);
    expect(keepsBrowserMenu(target(false), false)).toBe(false);
    expect(keepsBrowserMenu(null, false)).toBe(false);
  });

  it("a long press opens it after half a second; a drift or a lift cancels it", () => {
    vi.useFakeTimers();
    const fire = vi.fn();
    const press = createLongPress(fire);
    press.down(10, 10);
    vi.advanceTimersByTime(LONG_PRESS_MS - 1);
    expect(fire).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(fire).toHaveBeenCalledWith(10, 10);
    // The click that ends the press is swallowed, once.
    expect(press.takeFired()).toBe(true);
    expect(press.takeFired()).toBe(false);

    press.down(10, 10);
    press.move(30, 10);
    vi.advanceTimersByTime(LONG_PRESS_MS);
    press.down(10, 10);
    press.up();
    vi.advanceTimersByTime(LONG_PRESS_MS);
    expect(fire).toHaveBeenCalledTimes(1);
  });

  it("the card has no Aa button any more", () => {
    const idea: Idea = {
      id: "i1", url: "https://example.com/1", kind: "devto", title: "A post", content: "Some text", author: "someone",
      status: "new", source: "scout", createdAt: "2026-09-26T10:00:00.000Z", meta: { rank: 70 },
    };
    const html = renderToStaticMarkup(createElement(IdeaCard, { idea, onStatus: async () => {}, onUse: async () => {}, onStyle: async () => {} }));
    expect(html).not.toContain(">Aa</button>");
    expect(html).toContain(">Use</button>");
    expect(html).toContain(">Dismiss</button>");
  });

  it("Settings says where Learn from its style went", () => {
    const html = renderToStaticMarkup(createElement(StyleInspirationSection, { analyzedAt: null }));
    expect(html).toContain("right-click a card in Find Ideas");
  });
});
```

- [ ] **Step 2: Run the tests and check they fail.**

  Run: `cd ~/PostEcho/web && npx vitest run src/components/card-menu.test.ts --testTimeout=30000`

  Expected: FAIL. Vitest can't resolve `./card-menu`.

- [ ] **Step 3: Write `card-menu.tsx`.**

```tsx
"use client";

import { useEffect, useLayoutEffect, useRef } from "react";
import { createPortal } from "react-dom";

/** How long a finger rests on a card before its menu opens: phones have no right-click. */
export const LONG_PRESS_MS = 500;
/** How far the finger may drift before it's a scroll, not a press. */
export const LONG_PRESS_SLOP_PX = 10;

/**
 * Whether a right-click should get the browser's own menu rather than the card's: on a link
 * or a field (copy the link, open it in a new tab, paste), or with text selected in the card
 * (copy it).
 */
export function keepsBrowserMenu(target: EventTarget | null, hasSelection: boolean): boolean {
  const el = target as { closest?: (selector: string) => unknown } | null;
  if (el && typeof el.closest === "function" && el.closest("a, input, textarea, select, [contenteditable='true']")) return true;
  return hasSelection;
}

/**
 * A long press as a small state machine the card feeds touch events to: `down` starts the
 * timer, drifting past the slop or `up` cancels it, and once it fires `takeFired` answers true
 * a single time, so the click that ends the press can be swallowed.
 */
export function createLongPress(
  onFire: (x: number, y: number) => void,
  { delay = LONG_PRESS_MS, slop = LONG_PRESS_SLOP_PX }: { delay?: number; slop?: number } = {},
) {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let start: { x: number; y: number } | null = null;
  let fired = false;
  const clear = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    start = null;
  };
  return {
    down(x: number, y: number) {
      clear();
      fired = false;
      start = { x, y };
      timer = setTimeout(() => {
        timer = null;
        start = null;
        fired = true;
        onFire(x, y);
      }, delay);
    },
    move(x: number, y: number) {
      if (start && Math.hypot(x - start.x, y - start.y) > slop) clear();
    },
    up: clear,
    takeFired() {
      const was = fired;
      fired = false;
      return was;
    },
  };
}

export type CardMenuItem = { label: string; icon?: string; onSelect: () => void };

/**
 * A card's own menu at (x, y), kept inside the window: `role="menu"`, focus on its first item,
 * closed by Esc, a click elsewhere, a scroll, a resize or leaving the window — and focus then
 * goes back where it was.
 */
export function CardMenu({ x, y, items, onClose }: { x: number; y: number; items: CardMenuItem[]; onClose: () => void }) {
  const ref = useRef<HTMLDivElement | null>(null);

  // Measured and placed on the DOM node itself: no state, no second render.
  useLayoutEffect(() => {
    const menu = ref.current;
    if (!menu) return;
    const returnTo = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const { width, height } = menu.getBoundingClientRect();
    const margin = 8;
    menu.style.left = `${Math.max(margin, Math.min(x, window.innerWidth - width - margin))}px`;
    menu.style.top = `${Math.max(margin, Math.min(y, window.innerHeight - height - margin))}px`;
    menu.querySelector<HTMLButtonElement>("[role='menuitem']")?.focus({ preventScroll: true });
    return () => {
      if (returnTo?.isConnected) returnTo.focus({ preventScroll: true });
    };
  }, [x, y]);

  useEffect(() => {
    const close = () => onClose();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    const onPointer = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("pointerdown", onPointer, true);
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    window.addEventListener("blur", close);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pointerdown", onPointer, true);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
      window.removeEventListener("blur", close);
    };
  }, [onClose]);

  return createPortal(
    <div ref={ref} role="menu" aria-label="Card actions" style={{ left: x, top: y }}
      className="fixed z-50 min-w-52 rounded-lg border border-border bg-surface-2 p-1 shadow-lg">
      {items.map((item) => (
        <button
          key={item.label}
          type="button"
          role="menuitem"
          onClick={() => {
            onClose();
            item.onSelect();
          }}
          className="flex w-full items-center gap-2.5 rounded-md px-3 py-2 text-left text-sm text-text hover:bg-surface focus:bg-surface focus:outline-none"
        >
          {item.icon && <span aria-hidden className="w-5 shrink-0 text-xs font-semibold text-text-dim">{item.icon}</span>}
          {item.label}
        </button>
      ))}
    </div>,
    document.body,
  );
}
```

- [ ] **Step 4: Change `idea-card.tsx`.**
  - Change the react import to
    `import { useEffect, useMemo, useState, type MouseEvent } from "react";`.
  - Add `import { CardMenu, createLongPress, keepsBrowserMenu } from "@/components/card-menu";`.
  - Replace the `onStyle` prop doc with:
    `/** **Learn from its style**, from the card's right-click menu (2026-09-26; it was the Aa button): add the post to style inspiration, or take it off. */`.
  - After the `useError` state, add:

```tsx
  // The card's own menu (owner, 2026-09-26: "togli anche Aa su tutti e rendilo solo
  // selezionabile con tasto destro sulla card"): right-click, or a long press on a phone.
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const hasMenu = Boolean(onStyle && (idea.content ?? idea.title));
  const longPress = useMemo(() => createLongPress((x, y) => setMenu({ x, y })), []);
  useEffect(() => () => longPress.up(), [longPress]);
```

  - After `learnStyle`, add:

```tsx
  /** Right-click, or the keyboard's menu key: the card's menu, unless the browser's own fits better (see keepsBrowserMenu). */
  function openMenu(e: MouseEvent<HTMLDivElement>) {
    const selection = window.getSelection();
    const hasSelection = Boolean(selection && !selection.isCollapsed && selection.anchorNode && e.currentTarget.contains(selection.anchorNode));
    if (keepsBrowserMenu(e.target, hasSelection)) return;
    e.preventDefault();
    if (e.clientX === 0 && e.clientY === 0) {
      // The menu key has no pointer: open at the card's corner.
      const rect = e.currentTarget.getBoundingClientRect();
      setMenu({ x: rect.left + 16, y: rect.top + 16 });
    } else {
      setMenu({ x: e.clientX, y: e.clientY });
    }
  }
```

  - Replace the root `<div className="flex min-w-0 flex-col gap-3 rounded-xl border border-border bg-surface p-4">` with:

```tsx
    <div
      onContextMenu={hasMenu ? openMenu : undefined}
      onPointerDown={hasMenu ? (e) => { if (e.pointerType === "touch" && !keepsBrowserMenu(e.target, false)) longPress.down(e.clientX, e.clientY); } : undefined}
      onPointerMove={hasMenu ? (e) => { if (e.pointerType === "touch") longPress.move(e.clientX, e.clientY); } : undefined}
      onPointerUp={hasMenu ? longPress.up : undefined}
      onPointerCancel={hasMenu ? longPress.up : undefined}
      onClickCapture={hasMenu ? (e) => { if (longPress.takeFired()) { e.preventDefault(); e.stopPropagation(); } } : undefined}
      className="flex min-w-0 flex-col gap-3 rounded-xl border border-border bg-surface p-4 [-webkit-touch-callout:none] [@media(pointer:coarse)]:select-none"
    >
```

  - Delete the whole `{onStyle && (idea.content ?? idea.title) && ( <button …>Aa</button> )}`
    block in the footer.
  - Just before the root `</div>`, add:

```tsx
      {menu && (
        <CardMenu
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          items={[{ label: inStyle ? "Stop learning from its style" : "Learn from its style", icon: "Aa", onSelect: () => void learnStyle() }]}
        />
      )}
```

- [ ] **Step 5: Update the Settings copy.** In `style-inspiration-section.tsx`, replace the
  sentence `Posts by other people whose style you like: press <span …>Aa</span> on a card in Find Ideas.`
  with:
  `Posts by other people whose style you like: right-click a card in Find Ideas (long-press on a phone) and pick <span className="font-medium text-text">Learn from its style</span>.`

- [ ] **Step 6: Run the tests, lint and types.**

  Run: `cd ~/PostEcho/web && npx vitest run src/components --testTimeout=30000 && npx eslint src/components && npx tsc --noEmit`

  Expected: PASS, with no lint or type errors.

- [ ] **Step 7: Commit.**

```bash
cd ~/PostEcho && git add web/src/components && git commit -m "feat(ideas): Learn from its style moves to the card's right-click menu; the Aa button goes

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 14: Calibration (read-only) and the full check

**Files:**
- Create, then delete: `web/scripts/calibrate-kinds.tmp.mts`

- [ ] **Step 1: Write the one-off script.**

```ts
// One-off and read-only (2026-09-26): re-judges the saved scout ideas with the kinds and the
// relevance gate, and prints the old and the new rank side by side. Deleted after use.
import { readFileSync } from "node:fs";
import { neon } from "@neondatabase/serverless";
import { createJevClient, judgePosts } from "jev-judge";
import { DEFAULT_FIND_ORDER, jevKinds, RELEVANCE_GATE } from "../src/lib/find-kinds.ts";

const envFile = readFileSync(new URL("../.env.production.local", import.meta.url), "utf8");
function env(name: string): string {
  const line = envFile.split("\n").find((l) => l.startsWith(`${name}=`));
  if (!line) throw new Error(`${name} is not in .env.production.local`);
  return line.slice(name.length + 1).trim().replace(/^"|"$/g, "");
}
process.env.TYPESAFE_API_KEY = env("TYPESAFE_API_KEY");

type Row = { id: string; kind: string; status: string; title: string | null; content: string | null; meta: Record<string, unknown> };
const sql = neon(env("DATABASE_URL"));
const rows = (await sql`select id, kind, status, title, content, meta from ideas where source = 'scout' and content is not null order by created_at desc`) as Row[];

const byTopic = new Map<string, Row[]>();
for (const row of rows) {
  const topic = typeof row.meta.topic === "string" ? row.meta.topic : "";
  byTopic.set(topic, [...(byTopic.get(topic) ?? []), row]);
}

const client = createJevClient();
const results: Array<{ row: Row; rank: number; kind: string | null }> = [];
for (const [topic, group] of byTopic) {
  const judged = await judgePosts(client, {
    topic,
    posts: group.map((r) => ({ id: r.id, text: [r.title, r.content].filter(Boolean).join("\n\n").slice(0, 2000) })),
    kinds: jevKinds(DEFAULT_FIND_ORDER),
    options: { relevanceGate: RELEVANCE_GATE },
  });
  const byId = new Map(judged.map((j) => [j.id, j]));
  for (const row of group) {
    const j = byId.get(row.id);
    if (j) results.push({ row, rank: j.rank, kind: j.kind ?? null });
  }
}

results.sort((a, b) => b.rank - a.rank);
const old = (r: Row) => (typeof r.meta.rank === "number" ? r.meta.rank : 0);
console.log("  #  new  old  kind      source        status    title");
results.forEach(({ row, rank, kind }, i) => {
  const title = (row.title ?? row.content ?? "").replace(/\s+/g, " ").slice(0, 60);
  console.log(`${String(i + 1).padStart(3)}  ${String(rank).padStart(3)}  ${String(old(row)).padStart(3)}  ${(kind ?? "-").padEnd(8)}  ${row.kind.padEnd(12)}  ${row.status.padEnd(8)}  ${title}`);
});
for (const min of [50, 55, 60]) {
  console.log(`>= ${min}: old ${results.filter((r) => old(r.row) >= min).length} · new ${results.filter((r) => r.rank >= min).length} of ${results.length}`);
}
const kinds: Record<string, number> = {};
for (const r of results) kinds[r.kind ?? "-"] = (kinds[r.kind ?? "-"] ?? 0) + 1;
console.log("kinds:", kinds);
```

- [ ] **Step 2: Run it.** It reads production and writes nothing.

  Run: `cd ~/PostEcho/web && npx tsx scripts/calibrate-kinds.tmp.mts`

  Check that:
  - the `used` ideas (SubmitHub on HN, the dev.to ones) sit in the top 20;
  - enough ideas still pass 60.

  If the used ideas sit low, look at their kind first: a wrong kind means tightening that
  kind's description in `find-kinds.ts`. If too few pass 60, note the numbers for the owner.
  "Minimum score" is theirs to lower in Advanced.

- [ ] **Step 3: Delete the script.**

  Run: `rm ~/PostEcho/web/scripts/calibrate-kinds.tmp.mts`

- [ ] **Step 4: Run the full check.**

  Run: `cd ~/PostEcho/web && npx vitest run --testTimeout=30000 && npx eslint && npx tsc --noEmit`

  Expected: every test passes, with no lint or type errors.

- [ ] **Step 5: Commit any description tweaks from the calibration.**

```bash
cd ~/PostEcho && git add web/src/lib/find-kinds.ts && git commit -m "fix(search): kind descriptions tuned on the saved ideas

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

  Skip the commit if nothing changed.

### Task 15: Look at it in the dev server

**Files:**
- Create, then delete: `web/src/app/icons-search-priorities/page.tsx`

- [ ] **Step 1: Write the temporary page.** The proxy skips paths that start with `icons`.

```tsx
"use client";

import { useState } from "react";
import { IdeaCard, type Idea } from "@/components/idea-card";
import { FindOrderList } from "@/components/settings/find-order";
import { RateCard, ScheduleCard } from "@/components/plan/schedule-card";
import type { PlanOutcome, PlanPost } from "@/components/plan/plan-calendar";

const idea: Idea = {
  id: "i1", url: "https://news.ycombinator.com/item?id=1", kind: "hackernews", title: "How I got SubmitHub to $46k a month, alone",
  content: "Ten years in, one founder, no funding. Here are the numbers month by month, and what moved them.", author: "jdoe",
  status: "new", source: "scout", createdAt: "2026-09-26T10:00:00.000Z", meta: { rank: 78, sourceName: "hackernews", aiStyle: { slopScore: 20, verdict: "human" } },
};

export default function Page() {
  const [order, setOrder] = useState<string[]>(["story", "opinion", "problem", "news", "tool"]);
  const [inStyle, setInStyle] = useState(false);
  const [outcome, setOutcome] = useState<PlanOutcome | null>(null);
  const post: PlanPost = {
    id: "p1", draftId: "d1", platform: "linkedin", text: "Per-seat pricing is dead. Here's what we saw when we switched…", status: "posted_manually",
    publishAt: "2026-09-24T07:00:00.000Z", publishedUrl: null, error: null, emailedAt: null, publishedAt: "2026-09-24T07:00:00.000Z",
    ideaTitle: "Per-seat pricing", outcome,
  };
  return (
    <main className="mx-auto max-w-2xl space-y-8 p-6">
      <section className="divide-y divide-border rounded-xl border border-border bg-surface-2">
        <FindOrderList order={order} counts={{ story: { good: 3, bad: 1 } }} onChange={setOrder} />
      </section>
      <IdeaCard idea={idea} onStatus={async () => {}} onUse={async () => {}} inStyle={inStyle} onStyle={async (_i, add) => setInStyle(add)} />
      <ScheduleCard post={post} now="2026-09-26T10:00:00.000Z" busy={null} error={null} onAction={() => {}} onRate={(_p, o) => setOutcome(o)} />
      <RateCard post={{ ...post, id: "p2", outcome: null }} onRate={() => {}} />
    </main>
  );
}
```

- [ ] **Step 2: Check it in the browser.**
  - Start the dev server with preview_start `postecho-web` and open
    `http://localhost:3210/icons-search-priorities`.
  - Take a screenshot.
  - Click ↓ on "Real stories with numbers". It moves to 2.
  - Right-click the card text. The menu shows "Aa Learn from its style". Click it, right-click
    again, and it now reads "Stop learning from its style".
  - Right-click the ↗ link. The page's menu must not open.
  - Click "Did well". It turns green and pressed. Click it again and the vote clears.
  - Check the console for errors.
  - Emulate a phone width (375) and take a screenshot.

- [ ] **Step 3: Delete the page and check the tree is clean.**

  Run: `rm -r ~/PostEcho/web/src/app/icons-search-priorities && cd ~/PostEcho && git status --short`

  Expected: nothing from the temporary page is left.

### Task 16: Production

- [ ] **Step 1: Apply migration 0012 in production.** It is additive.

  Run: `cd ~/PostEcho/web && DATABASE_URL="$(grep '^DATABASE_URL_UNPOOLED=' .env.production.local|cut -d= -f2-|tr -d '"')" npx drizzle-kit migrate`

  Expected: the migrations applied, with no error.

- [ ] **Step 2: Deploy.** Run this as a single call, with nothing else running.

  Run: `vercel deploy --prod --yes --scope <your-team> --cwd web`

  Expected: a READY production URL, aliased to the production domain.

- [ ] **Step 3: Verify in production** with the prod session cookie at
  `scratchpad/prod-cookies.txt`:
  - `GET /api/settings` on production returns
    `settings.findOrder` = `["story","opinion","problem","news","tool"]`, plus `kindCounts`
    and `tasteCounts.rated`.
  - `GET /api/scheduled-posts?toRate=1` returns 200 with a `posts` array.
  - The served JS contains "What to show you first", "How did it do?" and
    "Learn from its style".

