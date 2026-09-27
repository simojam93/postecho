import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb } from "@/test/db";
import { drafts, ideas } from "@/db/schema";
import { getSetting, setSetting } from "@/lib/settings";
import { materialize, type MaterializeJob } from "@/lib/materialize";

function job(overrides: Partial<MaterializeJob> = {}): MaterializeJob {
  return {
    id: overrides.id ?? "11111111-1111-1111-1111-111111111111",
    kind: overrides.kind ?? "generate_from_video",
    payload: overrides.payload ?? {},
  };
}

describe("materialize — generate_from_video / generate_from_idea", () => {
  it("inserts candidate drafts linked to the job", async () => {
    const db = await createTestDb();
    const j = job();
    const outcome = await materialize(db as never, j, {
      drafts: [{ xText: "hello world" }, { linkedinText: "a longer linkedin post" }],
    });
    expect(outcome).toEqual({ ok: true });

    const rows = await db.select().from(drafts);
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.jobId === j.id)).toBe(true);
    expect(rows.every((r) => r.status === "candidate")).toBe(true);
  });

  it("flags meta.overLimit when xText exceeds 280 chars", async () => {
    const db = await createTestDb();
    await materialize(db as never, job(), { drafts: [{ xText: "x".repeat(281) }] });
    const [row] = await db.select().from(drafts);
    expect((row.meta as { overLimit?: boolean }).overLimit).toBe(true);
  });

  it("does not flag overLimit at or under 280 chars", async () => {
    const db = await createTestDb();
    await materialize(db as never, job(), { drafts: [{ xText: "x".repeat(280) }] });
    const [row] = await db.select().from(drafts);
    expect((row.meta as { overLimit?: boolean }).overLimit).toBe(false);
  });

  it("does not flag overLimit when only linkedinText is present", async () => {
    const db = await createTestDb();
    await materialize(db as never, job(), { drafts: [{ linkedinText: "a".repeat(1000) }] });
    const [row] = await db.select().from(drafts);
    expect((row.meta as { overLimit?: boolean }).overLimit).toBe(false);
  });

  it("links ideaId from the job payload when the idea exists", async () => {
    const db = await createTestDb();
    const [idea] = await db.insert(ideas).values({ kind: "note", content: "seed" }).returning();
    const j = job({ payload: { ideaId: idea.id } });
    await materialize(db as never, j, { drafts: [{ xText: "hi" }] });
    const [row] = await db.select().from(drafts);
    expect(row.ideaId).toBe(idea.id);
  });

  it("tolerates an unknown ideaId by leaving it null", async () => {
    const db = await createTestDb();
    const j = job({ payload: { ideaId: "00000000-0000-0000-0000-000000000000" } });
    const outcome = await materialize(db as never, j, { drafts: [{ xText: "hi" }] });
    expect(outcome).toEqual({ ok: true });
    const [row] = await db.select().from(drafts);
    expect(row.ideaId).toBeNull();
  });

  it("tolerates a missing ideaId in the payload", async () => {
    const db = await createTestDb();
    const outcome = await materialize(db as never, job({ payload: {} }), { drafts: [{ xText: "hi" }] });
    expect(outcome).toEqual({ ok: true });
    const [row] = await db.select().from(drafts);
    expect(row.ideaId).toBeNull();
  });

  it("is idempotent by jobId: a second materialize call doesn't duplicate drafts", async () => {
    const db = await createTestDb();
    const j = job();
    const result = { drafts: [{ xText: "hi" }, { xText: "there" }] };
    await materialize(db as never, j, result);
    const outcome = await materialize(db as never, j, result);
    expect(outcome).toEqual({ ok: true });
    const rows = await db.select().from(drafts);
    expect(rows).toHaveLength(2);
  });

  it("works identically for generate_from_idea", async () => {
    const db = await createTestDb();
    const j = job({ kind: "generate_from_idea" });
    await materialize(db as never, j, { drafts: [{ xText: "hi" }] });
    const rows = await db.select().from(drafts);
    expect(rows).toHaveLength(1);
    expect(rows[0].jobId).toBe(j.id);
  });

  it("rejects an empty drafts array as invalid shape, without inserting anything", async () => {
    const db = await createTestDb();
    const outcome = await materialize(db as never, job(), { drafts: [] });
    expect(outcome).toEqual({ ok: false, error: "invalid result for kind" });
    expect(await db.select().from(drafts)).toHaveLength(0);
  });

  it("rejects a draft item with neither xText nor linkedinText", async () => {
    const db = await createTestDb();
    const outcome = await materialize(db as never, job(), { drafts: [{}] });
    expect(outcome.ok).toBe(false);
  });

  it("rejects a completely malformed result", async () => {
    const db = await createTestDb();
    const outcome = await materialize(db as never, job(), { nonsense: true });
    expect(outcome).toEqual({ ok: false, error: "invalid result for kind" });
  });
});

describe("materialize — revise_draft", () => {
  it("inserts a new draft with parentId, status kept, ideaId copied from the parent", async () => {
    const db = await createTestDb();
    const [idea] = await db.insert(ideas).values({ kind: "note", content: "seed" }).returning();
    const [parent] = await db.insert(drafts).values({ ideaId: idea.id, xText: "original", status: "candidate" }).returning();
    const j = job({ kind: "revise_draft", payload: { draftId: parent.id } });

    const outcome = await materialize(db as never, j, { xText: "punchier version" });
    expect(outcome).toEqual({ ok: true });

    const rows = await db.select().from(drafts).where(eq(drafts.parentId, parent.id));
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("kept");
    expect(rows[0].ideaId).toBe(idea.id);
    expect(rows[0].xText).toBe("punchier version");
    expect(rows[0].jobId).toBe(j.id);
  });

  it("is idempotent by jobId", async () => {
    const db = await createTestDb();
    const [parent] = await db.insert(drafts).values({ xText: "original", status: "candidate" }).returning();
    const j = job({ kind: "revise_draft", payload: { draftId: parent.id } });
    const result = { xText: "v2" };
    await materialize(db as never, j, result);
    const outcome = await materialize(db as never, j, result);
    expect(outcome).toEqual({ ok: true });
    const rows = await db.select().from(drafts).where(eq(drafts.jobId, j.id));
    expect(rows).toHaveLength(1);
  });

  it("fails gracefully when the parent draft no longer exists", async () => {
    const db = await createTestDb();
    const j = job({ kind: "revise_draft", payload: { draftId: "00000000-0000-0000-0000-000000000000" } });
    const outcome = await materialize(db as never, j, { xText: "v2" });
    expect(outcome.ok).toBe(false);
  });

  it("rejects a result with neither xText nor linkedinText", async () => {
    const db = await createTestDb();
    const [parent] = await db.insert(drafts).values({ xText: "original" }).returning();
    const j = job({ kind: "revise_draft", payload: { draftId: parent.id } });
    const outcome = await materialize(db as never, j, {});
    expect(outcome).toEqual({ ok: false, error: "invalid result for kind" });
  });

  it("a Humanize (M3.6): stores Jev's verdict as meta.slop and the loop's rounds as meta.humanize", async () => {
    const db = await createTestDb();
    const [parent] = await db.insert(drafts).values({ xText: "sloppy", linkedinText: "l".repeat(700), status: "kept" }).returning();
    const j = job({ kind: "revise_draft", payload: { draftId: parent.id, humanize: "x" } });
    const outcome = await materialize(db as never, j, {
      xText: "loose",
      humanize: { rounds: [{ round: 1, slopScore: 64, verdict: "slop" }, { round: 2, slopScore: 28, verdict: "human" }] },
      slop: { platform: "x", slopScore: 28, verdict: "human" },
    });
    expect(outcome).toEqual({ ok: true });
    const [revision] = await db.select().from(drafts).where(eq(drafts.parentId, parent.id));
    expect(revision.xText).toBe("loose");
    expect(revision.meta).toMatchObject({
      slop: { platform: "x", slopScore: 28, verdict: "human" },
      humanize: { rounds: [{ round: 1, slopScore: 64, verdict: "slop" }, { round: 2, slopScore: 28, verdict: "human" }] },
    });
    expect(typeof (revision.meta.slop as { at?: unknown }).at).toBe("string");
  });

  it("a plain revision still gets an empty meta; unknown result keys are still rejected", async () => {
    const db = await createTestDb();
    const [parent] = await db.insert(drafts).values({ xText: "original" }).returning();
    await materialize(db as never, job({ kind: "revise_draft", payload: { draftId: parent.id } }), { xText: "v2" });
    const [revision] = await db.select().from(drafts).where(eq(drafts.parentId, parent.id));
    expect(revision.meta).toEqual({});

    const other = job({ id: "22222222-2222-2222-2222-222222222222", kind: "revise_draft", payload: { draftId: parent.id } });
    expect(await materialize(db as never, other, { xText: "v3", extra: 1 })).toEqual({ ok: false, error: "invalid result for kind" });
    expect(await materialize(db as never, other, { xText: "v3", slop: { platform: "tiktok", slopScore: 1, verdict: "human" } }))
      .toEqual({ ok: false, error: "invalid result for kind" });
  });
});

describe("materialize — Edit with Claude revisions (M3.7)", () => {
  it("carries the platform the reply didn't touch, stores the request, voice, per-platform verdicts and the X LinkedIn was written from", async () => {
    const db = await createTestDb();
    const [parent] = await db.insert(drafts).values({ xText: "my new X", linkedinText: "old linkedin", status: "kept", meta: { xAtLinkedin: "old X", voice: "reaction" } }).returning();
    const j = job({ kind: "revise_draft", payload: { draftId: parent.id, mode: "sync_linkedin", label: "Update LinkedIn from X", instruction: "Rewrite the LinkedIn version from the X one.", voice: "reaction" } });
    expect(await materialize(db as never, j, { linkedinText: "fresh linkedin", slopByPlatform: { linkedin: { slopScore: 30, verdict: "human" } } })).toEqual({ ok: true });
    const [revision] = await db.select().from(drafts).where(eq(drafts.parentId, parent.id));
    expect(revision.xText).toBe("my new X");
    expect(revision.linkedinText).toBe("fresh linkedin");
    expect(revision.meta).toMatchObject({
      instruction: "Update LinkedIn from X", mode: "sync_linkedin", voice: "reaction", xAtLinkedin: "my new X",
      slopByPlatform: { linkedin: { slopScore: 30, verdict: "human" } }, slop: { platform: "linkedin", slopScore: 30 },
    });
  });

  it("an X-only reply keeps LinkedIn's X basis; a legacy Refine (no mode) records no request", async () => {
    const db = await createTestDb();
    const [parent] = await db.insert(drafts).values({ xText: "x1", linkedinText: "l1", status: "kept", meta: { xAtLinkedin: "x1" } }).returning();
    await materialize(db as never, job({ kind: "revise_draft", payload: { draftId: parent.id, instruction: "punchier" } }), { xText: "x2" });
    const [revision] = await db.select().from(drafts).where(eq(drafts.parentId, parent.id));
    expect(revision.linkedinText).toBe("l1");
    expect(revision.meta).toEqual({ xAtLinkedin: "x1" });
  });

  it("a two-platform Humanize stores both verdicts and both rounds; meta.slop keeps X's", async () => {
    const db = await createTestDb();
    const [parent] = await db.insert(drafts).values({ xText: "x", linkedinText: "l", status: "kept" }).returning();
    await materialize(db as never, job({ kind: "revise_draft", payload: { draftId: parent.id, mode: "humanize", label: "Humanize", instruction: "h" } }), {
      xText: "x2", linkedinText: "l2",
      rounds: { x: [{ round: 1, slopScore: 20, verdict: "human" }], linkedin: [{ round: 1, slopScore: 25, verdict: "human" }] },
      slopByPlatform: { x: { slopScore: 20, verdict: "human" }, linkedin: { slopScore: 25, verdict: "human" } },
    });
    const [revision] = await db.select().from(drafts).where(eq(drafts.parentId, parent.id));
    expect(revision.meta).toMatchObject({ slop: { platform: "x", slopScore: 20 }, rounds: { linkedin: [{ round: 1, slopScore: 25 }] }, xAtLinkedin: "x2" });
  });

  it("generated takes start with LinkedIn in step with their X, and the job's voice", async () => {
    const db = await createTestDb();
    await materialize(db as never, job({ id: "33333333-3333-3333-3333-333333333333", kind: "generate_from_idea", payload: { voice: "mine" } }), {
      drafts: [{ xText: "take x", linkedinText: "l".repeat(650) }],
    });
    const [take] = await db.select().from(drafts);
    expect(take.meta).toMatchObject({ overLimit: false, xAtLinkedin: "take x", voice: "mine" });
  });
});

describe("materialize — image_prompt", () => {
  it("updates the target draft's imagePrompt", async () => {
    const db = await createTestDb();
    const [draft] = await db.insert(drafts).values({ xText: "hi" }).returning();
    const j = job({ kind: "image_prompt", payload: { draftId: draft.id } });
    const outcome = await materialize(db as never, j, { imagePrompt: "a moody photo of..." });
    expect(outcome).toEqual({ ok: true });
    const [row] = await db.select().from(drafts).where(eq(drafts.id, draft.id));
    expect(row.imagePrompt).toBe("a moody photo of...");
  });

  it("rejects a missing imagePrompt", async () => {
    const db = await createTestDb();
    const [draft] = await db.insert(drafts).values({ xText: "hi" }).returning();
    const outcome = await materialize(
      db as never,
      job({ kind: "image_prompt", payload: { draftId: draft.id } }),
      {},
    );
    expect(outcome).toEqual({ ok: false, error: "invalid result for kind" });
  });
});

describe("materialize — analyze_style", () => {
  it("saves the styleGuide setting", async () => {
    const db = await createTestDb();
    const outcome = await materialize(db as never, job({ kind: "analyze_style" }), { styleGuide: "# Voice\n..." });
    expect(outcome).toEqual({ ok: true });
    expect(await getSetting(db as never, "styleGuide")).toBe("# Voice\n...");
    // When it was analyzed, for Settings' "N added since the last analysis".
    expect(typeof (await getSetting(db as never, "styleGuideAnalyzedAt"))).toBe("string");
  });

  it("rejects a missing styleGuide", async () => {
    const db = await createTestDb();
    const outcome = await materialize(db as never, job({ kind: "analyze_style" }), {});
    expect(outcome).toEqual({ ok: false, error: "invalid result for kind" });
  });
});

describe("materialize — learn_style (learning from the owner's choices)", () => {
  const lessons = [{ trait: "numbers", value: "yes", direction: "more", lift: 4.5, text: "Has a concrete number: 7 of 10 you kept, 1 of 9 you dropped." }];
  const learnJob = () => job({ kind: "learn_style", payload: { guide: "Short sentences.", lessons, basedOn: 19 } });

  it("keeps Claude's change as a proposal with its reasons and lessons; the guide itself stays", async () => {
    const db = await createTestDb();
    await setSetting(db as never, "styleGuide", "Short sentences.");
    const outcome = await materialize(db as never, learnJob(), {
      guide: " Short sentences.\nOpen with a number. ",
      changes: [{ summary: "Open with a number", reason: "7 of 10 posts you kept do, 1 of 9 you dropped." }],
    });
    expect(outcome).toEqual({ ok: true });
    expect(await getSetting(db as never, "styleGuide")).toBe("Short sentences.");
    expect(await getSetting(db as never, "styleProposal")).toEqual({
      guide: "Short sentences.\nOpen with a number.",
      changes: [{ summary: "Open with a number", reason: "7 of 10 posts you kept do, 1 of 9 you dropped." }],
      lessons,
      basedOn: 19,
      createdAt: expect.any(String),
    });
  });

  it("no change, or the same guide, proposes nothing", async () => {
    const db = await createTestDb();
    await setSetting(db as never, "styleGuide", "Short sentences.");
    expect(await materialize(db as never, learnJob(), { guide: "Short sentences.", changes: [] })).toEqual({ ok: true });
    expect(await materialize(db as never, learnJob(), { guide: "Short sentences. ", changes: [{ summary: "s", reason: "r" }] })).toEqual({ ok: true });
    expect(await getSetting(db as never, "styleProposal")).toBeNull();
  });

  it("rejects a malformed answer", async () => {
    const db = await createTestDb();
    for (const bad of [{}, { guide: "" , changes: [] }, { guide: "g" }, { guide: "g", changes: [{ summary: "s" }] }, { guide: "g", changes: [], extra: 1 }]) {
      expect(await materialize(db as never, learnJob(), bad)).toEqual({ ok: false, error: "invalid result for kind" });
    }
  });
});

describe("materialize — scout/unknown kinds", () => {
  it("no-ops for scout", async () => {
    const db = await createTestDb();
    const outcome = await materialize(db as never, job({ kind: "scout" }), { anything: 1 });
    expect(outcome).toEqual({ ok: true });
    expect(await db.select().from(drafts)).toHaveLength(0);
  });

  it("no-ops for an unrecognized kind", async () => {
    const db = await createTestDb();
    const outcome = await materialize(db as never, job({ kind: "some_future_kind" }), {});
    expect(outcome).toEqual({ ok: true });
  });
});

describe("materialize — the best three takes (2026-09-24)", () => {
  const slop = (slopScore: number) => ({ platform: "x" as const, slopScore, verdict: slopScore < 40 ? "human" : "slop" });

  async function ideaWithDb() {
    const db = await createTestDb();
    const [idea] = await db.insert(ideas).values({ kind: "note", content: "seed" }).returning();
    return { db, idea };
  }

  it("stores Jev's verdict on each take, like any check", async () => {
    const { db, idea } = await ideaWithDb();
    await materialize(db as never, job({ kind: "generate_from_idea", payload: { ideaId: idea.id } }), {
      drafts: [{ xText: "one", slop: slop(20) }, { xText: "two" }],
    });
    const rows = await db.select().from(drafts);
    const one = rows.find((r) => r.xText === "one")!;
    expect(one.meta).toMatchObject({ slop: { platform: "x", slopScore: 20, verdict: "human" }, slopByPlatform: { x: { slopScore: 20, verdict: "human" } } });
    expect(typeof (one.meta.slop as { at?: unknown }).at).toBe("string");
    expect(rows.find((r) => r.xText === "two")!.meta).not.toHaveProperty("slop");
  });

  it("new takes landing: the post keeps its chosen take and the most human others, three in all; the rest are discarded", async () => {
    const { db, idea } = await ideaWithDb();
    const [chosen] = await db.insert(drafts).values({ ideaId: idea.id, xText: "picked", status: "kept", meta: { slop: { platform: "x", slopScore: 85, verdict: "slop" } } }).returning();
    const [edit] = await db.insert(drafts).values({ ideaId: idea.id, parentId: chosen.id, xText: "picked, edited", status: "candidate" }).returning();
    const [oldGood] = await db.insert(drafts).values({ ideaId: idea.id, xText: "old good", meta: { slop: { platform: "x", slopScore: 15, verdict: "human" } } }).returning();
    const [oldBad] = await db.insert(drafts).values({ ideaId: idea.id, xText: "old bad", meta: { slop: { platform: "x", slopScore: 75, verdict: "slop" } } }).returning();
    const [published] = await db.insert(drafts).values({ ideaId: idea.id, xText: "scheduled", status: "used" }).returning();

    await materialize(db as never, job({ kind: "generate_from_idea", payload: { ideaId: idea.id } }), {
      drafts: [{ xText: "new best", slop: slop(5) }, { xText: "new mid", slop: slop(30) }, { xText: "new worst", slop: slop(60) }],
    });

    const rows = await db.select().from(drafts);
    const statusOf = (text: string) => rows.find((r) => r.xText === text)!.status;
    // Kept: the chosen take (whatever its score) and the two most human others.
    expect(statusOf("picked")).toBe("kept");
    expect(rows.find((r) => r.id === edit.id)!.status).toBe("candidate"); // a version of the chosen take stays with it
    expect(statusOf("new best")).toBe("candidate");
    expect(statusOf("old good")).toBe("candidate");
    // Discarded: the rest.
    expect(statusOf("new mid")).toBe("discarded");
    expect(statusOf("new worst")).toBe("discarded");
    expect(rows.find((r) => r.id === oldBad.id)!.status).toBe("discarded");
    // PostEcho's drop, not the owner's: learning from their choices leaves these out.
    expect(rows.find((r) => r.id === oldBad.id)!.meta).toMatchObject({ trimmed: true, slop: { slopScore: 75 } });
    expect(rows.find((r) => r.xText === "new mid")!.meta).toMatchObject({ trimmed: true });
    expect(rows.find((r) => r.xText === "old good")!.meta).not.toHaveProperty("trimmed");
    // Never touched: a used (scheduled or published) draft.
    expect(rows.find((r) => r.id === published.id)!.status).toBe("used");
    expect(oldGood.id).toBeTruthy();
  });

  it("no chosen take yet: the three most human of all", async () => {
    const { db, idea } = await ideaWithDb();
    await materialize(db as never, job({ kind: "generate_from_idea", payload: { ideaId: idea.id } }), {
      drafts: [{ xText: "a", slop: slop(50) }, { xText: "b", slop: slop(10) }, { xText: "c", slop: slop(30) }, { xText: "d", slop: slop(70) }],
    });
    const rows = await db.select().from(drafts);
    expect(rows.filter((r) => r.status === "candidate").map((r) => r.xText).sort()).toEqual(["a", "b", "c"]);
  });
});

describe("materialize — Humanize one platform keeps the other's score (2026-09-24)", () => {
  it("the platform the revision didn't touch keeps its score from the version before", async () => {
    const db = await createTestDb();
    const [parent] = await db.insert(drafts).values({
      xText: "x", linkedinText: "l", status: "kept",
      meta: { slopByPlatform: { x: { slopScore: 70, verdict: "slop", at: "2026-09-24T08:00:00.000Z" }, linkedin: { slopScore: 22, verdict: "human", at: "2026-09-24T08:00:00.000Z" } } },
    }).returning();
    await materialize(db as never, job({ kind: "revise_draft", payload: { draftId: parent.id, humanize: "x", mode: "humanize", label: "Humanize X", instruction: "h" } }), {
      xText: "x, humanized",
      humanize: { rounds: [{ round: 1, slopScore: 25, verdict: "human" }] },
      slop: { platform: "x", slopScore: 25, verdict: "human" },
    });
    const [revision] = await db.select().from(drafts).where(eq(drafts.parentId, parent.id));
    expect(revision.linkedinText).toBe("l");
    expect(revision.meta).toMatchObject({
      instruction: "Humanize X", mode: "humanize",
      slopByPlatform: { x: { slopScore: 25, verdict: "human" }, linkedin: { slopScore: 22, verdict: "human", at: "2026-09-24T08:00:00.000Z" } },
      slop: { platform: "x", slopScore: 25 },
    });
  });
});

describe("materialize — video_ideas (2026-09-27: \"post X pronti all'attacco senza titolo, 6+6 vanno bene\")", () => {
  const post = (i: number) => ({ xText: `Post ${i}: what the video says about ${i}.` });

  it("saves the ready posts under their video, in Claude's order, with no title; the text the agent read stays on the job", async () => {
    const db = await createTestDb();
    const [video] = await db.insert(ideas).values({ url: "https://youtu.be/v", kind: "youtube", title: "The talk", author: "Chan" }).returning();
    const job: MaterializeJob = { id: "00000000-0000-4000-8000-000000000001", kind: "video_ideas", payload: { ideaId: video.id } };
    expect(await materialize(db as never, job, { posts: Array.from({ length: 12 }, (_, i) => post(i)), source: "transcript", text: "the whole talk" })).toEqual({ ok: true });
    const rows = (await db.select().from(ideas).where(eq(ideas.kind, "video_idea"))).sort((a, b) => Number(a.meta.order) - Number(b.meta.order));
    expect(rows).toHaveLength(12);
    expect(rows[0]).toMatchObject({ source: "manual", status: "new", title: null, content: "Post 0: what the video says about 0.", author: "Chan" });
    expect(rows[0].meta).toMatchObject({
      jobId: job.id, videoId: video.id, videoTitle: "The talk", order: 0, format: "post", sourceName: "youtube", articleUrl: "https://youtu.be/v", fromDescription: false,
    });
    expect(rows[0].meta).not.toHaveProperty("aiStyle");
    expect(JSON.stringify(rows)).not.toContain("the whole talk");
    // The same result again (a retried post) adds nothing.
    await materialize(db as never, job, { posts: [post(0)] });
    expect(await db.select().from(ideas).where(eq(ideas.kind, "video_idea"))).toHaveLength(12);
  });

  it("keeps Jev's verdict on each post as the card's human score", async () => {
    const db = await createTestDb();
    const [video] = await db.insert(ideas).values({ url: "https://youtu.be/s", kind: "youtube", title: "T" }).returning();
    await materialize(db as never, { id: "00000000-0000-4000-8000-000000000005", kind: "video_ideas", payload: { ideaId: video.id } },
      { posts: [{ ...post(0), slop: { platform: "x", slopScore: 18, verdict: "human" } }] });
    const [row] = await db.select().from(ideas).where(eq(ideas.kind, "video_idea"));
    expect(row.meta.aiStyle).toMatchObject({ slopScore: 18, verdict: "human" });
  });

  it("a new batch for the video archives the unreviewed posts and keeps the Liked ones", async () => {
    const db = await createTestDb();
    const [video] = await db.insert(ideas).values({ url: "https://youtu.be/w", kind: "youtube", title: "T" }).returning();
    await materialize(db as never, { id: "00000000-0000-4000-8000-000000000002", kind: "video_ideas", payload: { ideaId: video.id } }, { posts: [post(0), post(1)] });
    const [first] = await db.select().from(ideas).where(eq(ideas.content, post(0).xText));
    await db.update(ideas).set({ status: "kept" }).where(eq(ideas.id, first.id));
    await materialize(db as never, { id: "00000000-0000-4000-8000-000000000003", kind: "video_ideas", payload: { ideaId: video.id } }, { posts: [post(5)] });
    const rows = await db.select().from(ideas).where(eq(ideas.kind, "video_idea"));
    expect(rows.map((r) => [r.content, r.status]).sort()).toEqual([[post(0).xText, "kept"], [post(1).xText, "archived"], [post(5).xText, "new"]]);
  });

  it("marks posts that came from the description, not the transcript", async () => {
    const db = await createTestDb();
    const [video] = await db.insert(ideas).values({ url: "https://youtu.be/d", kind: "youtube", title: "T" }).returning();
    await materialize(db as never, { id: "00000000-0000-4000-8000-000000000004", kind: "video_ideas", payload: { ideaId: video.id } }, { posts: [post(0)], source: "description" });
    const [row] = await db.select().from(ideas).where(eq(ideas.kind, "video_idea"));
    expect(row.meta.fromDescription).toBe(true);
  });

  it("refuses a result without posts, and the topics of an agent from before", async () => {
    const db = await createTestDb();
    expect(await materialize(db as never, { id: "j", kind: "video_ideas", payload: {} }, { posts: [] })).toEqual({ ok: false, error: "invalid result for kind" });
    expect(await materialize(db as never, { id: "j", kind: "video_ideas", payload: {} }, { ideas: [{ title: "T", summary: "S" }] }))
      .toEqual({ ok: false, error: "invalid result for kind" });
  });
});
