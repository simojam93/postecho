import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import type { JevClient } from "jev-judge";
import { createTestDb } from "@/test/db";
import { drafts, ideas, jobs, scheduledPosts } from "@/db/schema";
import { getSetting, setSetting } from "@/lib/settings";
import { setSlopDeps } from "@/lib/slop";
import {
  LEARN_AFTER_NEW_CHOICES,
  loadRecentEdits,
  loadStyleChoices,
  maybeLearnStyle,
  styleLearningStatus,
} from "@/lib/style-learning";

type TestDb = Awaited<ReturnType<typeof createTestDb>>;
let db: TestDb;

beforeEach(async () => {
  db = await createTestDb();
  // No Jev key unless a test gives one: only the traits a rule can read.
  vi.stubEnv("TYPESAFE_API_KEY", "");
});

afterEach(() => {
  setSlopDeps({});
  vi.unstubAllEnvs();
});

async function newIdea() {
  const [idea] = await db.insert(ideas).values({ kind: "note", content: "an idea" }).returning();
  return idea.id;
}

type DraftInput = Partial<typeof drafts.$inferInsert> & { xText: string };
async function draft(ideaId: string, values: DraftInput) {
  const [row] = await db.insert(drafts).values({ ideaId, ...values }).returning();
  return row;
}

/** A post whose owner chose `keptText` over the `dropped` takes. */
async function decidedPost(keptText: string, dropped: string[]) {
  const ideaId = await newIdea();
  const kept = await draft(ideaId, { xText: keptText, status: "kept" });
  for (const text of dropped) await draft(ideaId, { xText: text });
  return kept;
}

describe("loadStyleChoices", () => {
  it("the chosen version is kept, the other takes dropped; PostEcho's own trims and undecided posts don't count", async () => {
    const ideaId = await newIdea();
    const root = await draft(ideaId, { xText: "first take", status: "candidate" });
    const chosen = await draft(ideaId, { xText: "first take, edited", status: "kept", parentId: root.id });
    const other = await draft(ideaId, { xText: "second take" });
    const tossed = await draft(ideaId, { xText: "third take", status: "discarded" });
    await draft(ideaId, { xText: "trimmed take", status: "discarded", meta: { trimmed: true } });
    const undecided = await newIdea();
    await draft(undecided, { xText: "nobody chose me" });

    const choices = await loadStyleChoices(db as never);
    expect(choices.map(({ id, text, kept, weight }) => ({ id, text, kept, weight })).sort((a, b) => a.text.localeCompare(b.text))).toEqual([
      { id: chosen.id, text: "first take, edited", kept: true, weight: 1 },
      { id: other.id, text: "second take", kept: false, weight: undefined },
      { id: tossed.id, text: "third take", kept: false, weight: undefined },
    ]);
  });

  it("a star counts double and a post that did well once more; one that didn't land counts as dropped; a starred take is kept", async () => {
    const good = await decidedPost("did well", []);
    await db.update(drafts).set({ favorite: true, status: "used" }).where(eq(drafts.id, good.id));
    await db.insert(scheduledPosts).values({ draftId: good.id, platform: "x", text: "did well", publishAt: new Date(), status: "posted_manually", outcome: "good", ratedAt: new Date() });

    const bad = await decidedPost("did badly", []);
    await db.insert(scheduledPosts).values({ draftId: bad.id, platform: "x", text: "did badly", publishAt: new Date(), status: "posted_manually", outcome: "bad", ratedAt: new Date() });

    const starredIdea = (await decidedPost("the pick", [])).ideaId!;
    await draft(starredIdea, { xText: "starred but not picked", favorite: true });

    const byText = Object.fromEntries((await loadStyleChoices(db as never)).map((c) => [c.text, { kept: c.kept, weight: c.weight }]));
    expect(byText).toEqual({
      "did well": { kept: true, weight: 3 },
      "did badly": { kept: false, weight: undefined },
      "the pick": { kept: true, weight: 1 },
      "starred but not picked": { kept: true, weight: undefined },
    });
  });

  it("nothing decided, nothing to learn", async () => {
    expect(await loadStyleChoices(db as never)).toEqual([]);
  });
});

describe("loadRecentEdits", () => {
  it("what the owner asked Write's chat, most asked first, only their own requests that went through", async () => {
    let minute = 0;
    const edit = (payload: Record<string, unknown>, status: "done" | "failed" = "done") =>
      db.insert(jobs).values({ kind: "revise_draft", status, payload, createdAt: new Date(Date.UTC(2026, 8, 27, 9, minute++)) });
    await edit({ mode: "custom", label: "Shorter", instruction: "Make both versions noticeably shorter" });
    await edit({ mode: "custom", label: "no emoji please", instruction: "no emoji please" });
    await edit({ mode: "custom", label: "shorter", instruction: "Make both versions noticeably shorter" });
    await edit({ mode: "humanize", label: "Humanize X", instruction: "x" });
    await edit({ mode: "custom", label: "never ran" }, "failed");
    // Said the way they last said it.
    expect(await loadRecentEdits(db as never)).toEqual(["shorter (asked 2 times)", "no emoji please"]);
  });
});

/** Posts that tell something: the kept ones have a number and an "I", the dropped ones neither. */
async function enoughChoices(posts = 8) {
  for (let i = 0; i < posts; i++) await decidedPost(`I shipped ${i + 2} fixes today`, ["Some thoughts on shipping", "Shipping matters to everyone"]);
}

describe("maybeLearnStyle", () => {
  it("looks once there are enough new choices, and queues the lessons, the guide, the edits and a few kept posts for the agent", async () => {
    await setSetting(db as never, "styleGuide", "Short sentences.");
    await enoughChoices();
    const now = new Date();

    expect(await maybeLearnStyle(db as never, now)).toBe("queued");
    const [job] = await db.select().from(jobs).where(eq(jobs.kind, "learn_style"));
    const payload = job.payload as { guide: string; lessons: Array<{ text: string; direction: string }>; edits: string[]; examples: string[]; basedOn: number };
    expect(payload.guide).toBe("Short sentences.");
    expect(payload.basedOn).toBe(24);
    expect(payload.examples).toHaveLength(3);
    expect(payload.edits).toEqual([]);
    expect(payload.lessons.map((l) => l.text)).toEqual(expect.arrayContaining([
      "Has a concrete number: 8 of 8 you kept, 0 of 16 you dropped.",
      "Written in the first person: 8 of 8 you kept, 0 of 16 you dropped.",
    ]));
    expect(await getSetting(db as never, "styleLearnedAt")).toBe(now.toISOString());
  });

  it("asks Jev about the traits it reads when there's a key", async () => {
    const systemOne = vi.fn(async () => ({ answers: {} }));
    setSlopDeps({ jev: { systemOne } as JevClient });
    await enoughChoices();
    expect(await maybeLearnStyle(db as never)).toBe("queued");
    expect(systemOne).toHaveBeenCalled();
  });

  it("checks at most daily, looks at most weekly, and never over a waiting suggestion or a running job", async () => {
    await enoughChoices();
    const t0 = new Date("2026-09-27T10:00:00Z");
    const hours = (h: number) => new Date(t0.getTime() + h * 3_600_000);

    expect(await maybeLearnStyle(db as never, t0)).toBe("queued");
    expect(await maybeLearnStyle(db as never, hours(2))).toBe("checked-recently");
    expect(await maybeLearnStyle(db as never, hours(25))).toBe("learned-recently");

    await db.update(jobs).set({ status: "done" });
    await setSetting(db as never, "styleProposal", { guide: "g", changes: [{ summary: "s", reason: "r" }], lessons: [], basedOn: 24, createdAt: t0.toISOString() });
    expect(await maybeLearnStyle(db as never, hours(8 * 24))).toBe("proposal-waiting");

    await setSetting(db as never, "styleProposal", null);
    await db.insert(jobs).values({ kind: "learn_style", payload: {} });
    expect(await maybeLearnStyle(db as never, hours(9 * 24))).toBe("running");
  });

  it("waits for about 15 new choices, and a look that finds nothing clear still counts", async () => {
    await decidedPost("I shipped 3 fixes", ["Some thoughts"]);
    expect(await maybeLearnStyle(db as never)).toBe("too-few");

    for (let i = 0; i < LEARN_AFTER_NEW_CHOICES; i++) await decidedPost("Same words", ["Same words"]);
    await setSetting(db as never, "styleLearnCheckedAt", null);
    expect(await maybeLearnStyle(db as never)).toBe("nothing-clear");
    expect(await db.select().from(jobs)).toHaveLength(0);
    expect(await getSetting(db as never, "styleLearnedAt")).not.toBeNull();
  });
});

describe("styleLearningStatus", () => {
  it("the waiting suggestion, whether one is being written, and the new choices since the last look", async () => {
    await decidedPost("I shipped 3 fixes", ["Some thoughts"]);
    expect(await styleLearningStatus(db as never)).toEqual({
      proposal: null, running: false, choices: 2, newChoices: 2, learnedAt: null, needed: LEARN_AFTER_NEW_CHOICES,
    });
    const later = new Date(Date.now() + 60_000).toISOString();
    await setSetting(db as never, "styleLearnedAt", later);
    await db.insert(jobs).values({ kind: "learn_style", payload: {} });
    expect(await styleLearningStatus(db as never)).toMatchObject({ running: true, choices: 2, newChoices: 0, learnedAt: later });
  });
});
