import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb } from "@/test/db";
import { drafts, ideas, jobs } from "@/db/schema";
import type { DeepRead } from "@/lib/deep-read";

const state: { db: Awaited<ReturnType<typeof createTestDb>> | null } = { db: null };
vi.mock("@/db", () => ({ get db() { return state.db; } }));
vi.mock("@/lib/session", async (orig) => ({
  ...(await orig()),
  requireSession: vi.fn(async () => null),
}));
vi.mock("@/lib/deep-read", async (orig) => ({
  ...(await orig()),
  needsDeepRead: vi.fn(() => true),
  deepRead: vi.fn(async () => null),
}));

const routeModule = await import("@/app/api/drafts/from-idea/route");
const { POST } = routeModule;
const { deepRead, needsDeepRead } = await import("@/lib/deep-read");

const HN_URL = "https://news.ycombinator.com/item?id=41";
const fakeRead: DeepRead = {
  text: "How We built a $1M ARR open source SaaS\nLink: https://blog.example.com/arr\n\nArticle extract (blog.example.com):\nWe doubled down…\n\nDiscussion highlights on Hacker News (1 of the comments):\n— alice: Great write-up.\nDiscussion: " + HN_URL,
  title: "How We built a $1M ARR open source SaaS",
  summary: "We doubled down on self-serve onboarding.",
  articleUrl: "https://blog.example.com/arr",
  discussionUrl: HN_URL,
  parts: ["article", "discussion"],
  notes: [],
};

async function insertHnIdea() {
  const [row] = await state.db!.insert(ideas).values({
    url: HN_URL,
    kind: "hackernews",
    title: null,
    content: "How We built a $1M ARR open source SaaS",
    author: "caust1c",
    source: "scout",
    status: "new",
    meta: { topic: "indie saas", rank: 68, sourceName: "hackernews", sourceId: "41" },
  }).returning();
  return row;
}

function req(body: unknown) {
  return new Request("http://test/api/drafts/from-idea", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(async () => {
  state.db = await createTestDb();
  const { requireSession } = await import("@/lib/session");
  vi.mocked(requireSession).mockReset().mockResolvedValue(null);
  vi.mocked(needsDeepRead).mockReset().mockReturnValue(true);
  vi.mocked(deepRead).mockReset().mockResolvedValue(null);
});

describe("POST /api/drafts/from-idea", () => {
  it("exports maxDuration = 30 for the bounded third-party reads", () => {
    expect(routeModule.maxDuration).toBe(30);
  });

  it("deep read gathered: the job seeds from it, the idea keeps the text and is marked read + used", async () => {
    vi.mocked(deepRead).mockResolvedValueOnce(fakeRead);
    const idea = await insertHnIdea();

    const res = await POST(req({ ideaId: idea.id }));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.read).toEqual(["article", "discussion"]);
    expect(res.headers.get("X-PostEcho-Job")).toBe(body.job.id);
    expect(vi.mocked(deepRead)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(deepRead).mock.calls[0][0]).toMatchObject({ kind: "hackernews", url: HN_URL });

    const [job] = await state.db!.select().from(jobs).where(eq(jobs.id, body.job.id));
    expect(job.kind).toBe("generate_from_idea");
    expect(job.payload).toEqual({
      ideaId: idea.id,
      seedText: fakeRead.text,
      seedUrl: "https://blog.example.com/arr",
      discussionUrl: HN_URL,
      voice: "reaction",
      ownText: false,
      instructions: "",
      count: 3,
    });

    const [after] = await state.db!.select().from(ideas).where(eq(ideas.id, idea.id));
    expect(after.status).toBe("used");
    expect(after.content).toBe("How We built a $1M ARR open source SaaS — We doubled down on self-serve onboarding.");
    expect(after.meta).toMatchObject({
      topic: "indie saas", rank: 68, sourceId: "41",
      deepReadText: fakeRead.text,
      deepReadParts: ["article", "discussion"],
      articleUrl: "https://blog.example.com/arr",
      discussionUrl: HN_URL,
    });
    expect(typeof after.meta.deepReadAt).toBe("string");
    expect(Number.isNaN(new Date(after.meta.deepReadAt as string).getTime())).toBe(false);
  });

  it("nothing gathered: today's title-plus-link seed, the idea untouched but for its status", async () => {
    const idea = await insertHnIdea();
    const res = await POST(req({ ideaId: idea.id, count: 2 }));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.read).toEqual([]);

    const [job] = await state.db!.select().from(jobs).where(eq(jobs.id, body.job.id));
    expect(job.payload).toEqual({
      ideaId: idea.id,
      seedText: "How We built a $1M ARR open source SaaS",
      seedUrl: HN_URL,
      discussionUrl: null,
      voice: "reaction",
      ownText: false,
      instructions: "",
      count: 2,
    });
    const [after] = await state.db!.select().from(ideas).where(eq(ideas.id, idea.id));
    expect(after.status).toBe("used");
    expect(after.content).toBe("How We built a $1M ARR open source SaaS");
    expect(after.meta.deepReadAt).toBeUndefined();
  });

  it("a read that throws is logged and falls back the same way", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(deepRead).mockRejectedValueOnce(new Error("network down"));
    const idea = await insertHnIdea();
    const res = await POST(req({ ideaId: idea.id }));
    expect(res.status).toBe(201);
    expect(errorSpy).toHaveBeenCalled();
    const [job] = await state.db!.select().from(jobs);
    expect(job.payload).toMatchObject({ seedText: "How We built a $1M ARR open source SaaS", seedUrl: HN_URL });
    errorSpy.mockRestore();
  });

  it("a card the scout already read: its stored text and links seed the job, nothing is fetched", async () => {
    vi.mocked(needsDeepRead).mockReturnValue(false);
    const [idea] = await state.db!.insert(ideas).values({
      url: HN_URL, kind: "hackernews", title: null, source: "scout", status: "new", author: "caust1c",
      content: "How We built a $1M ARR open source SaaS — We doubled down on self-serve onboarding.",
      meta: {
        topic: "indie saas", deepReadAt: "2026-09-23T08:00:00.000Z", deepReadText: fakeRead.text,
        deepReadParts: ["article", "discussion"], articleUrl: "https://blog.example.com/arr", discussionUrl: HN_URL,
      },
    }).returning();

    const res = await POST(req({ ideaId: idea.id }));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.read).toEqual(["article", "discussion"]);
    expect(vi.mocked(deepRead)).not.toHaveBeenCalled();

    const [job] = await state.db!.select().from(jobs).where(eq(jobs.id, body.job.id));
    expect(job.payload).toMatchObject({ seedText: fakeRead.text, seedUrl: "https://blog.example.com/arr", discussionUrl: HN_URL });
    const [after] = await state.db!.select().from(ideas).where(eq(ideas.id, idea.id));
    expect(after.status).toBe("used");
    expect(after.meta.deepReadAt).toBe("2026-09-23T08:00:00.000Z");
  });

  it("does not read when the rule says no (already read, rich content, a note…)", async () => {
    vi.mocked(needsDeepRead).mockReturnValue(false);
    const idea = await insertHnIdea();
    const res = await POST(req({ ideaId: idea.id }));
    expect(res.status).toBe(201);
    expect(vi.mocked(deepRead)).not.toHaveBeenCalled();
  });

  it("404 for an unknown idea, 400 for a bad body, 401 when the session is denied — no job, no read", async () => {
    expect((await POST(req({ ideaId: "5c1d6b3e-1111-4222-8333-444455556666" }))).status).toBe(404);
    expect((await POST(req({ nope: true }))).status).toBe(400);
    expect((await POST(req({ ideaId: "not-a-uuid" }))).status).toBe(400);

    const { requireSession } = await import("@/lib/session");
    vi.mocked(requireSession).mockResolvedValueOnce(Response.json({ error: "unauthorized" }, { status: 401 }));
    const idea = await insertHnIdea();
    expect((await POST(req({ ideaId: idea.id }))).status).toBe(401);

    expect(await state.db!.select().from(jobs)).toHaveLength(0);
    expect(vi.mocked(deepRead)).not.toHaveBeenCalled();
  });

  it("the owner's own text (a manual note) is flagged ownText, and never deep-read", async () => {
    const [note] = await state.db!.insert(ideas).values({ kind: "note", source: "manual", content: "I rebuilt onboarding in a weekend." }).returning();
    const { needsDeepRead: realRule } = await vi.importActual<typeof import("@/lib/deep-read")>("@/lib/deep-read");
    vi.mocked(needsDeepRead).mockImplementation(realRule);
    const res = await POST(req({ ideaId: note.id, instructions: "in Italian" }));
    expect(res.status).toBe(201);
    const { job } = await res.json();
    expect(job.payload).toMatchObject({ seedText: "I rebuilt onboarding in a weekend.", voice: "mine", ownText: true, instructions: "in Italian" });
    expect(vi.mocked(deepRead)).not.toHaveBeenCalled();
  });

  it("a voice switched in Write wins over where the idea came from", async () => {
    vi.mocked(needsDeepRead).mockReturnValue(false);
    const [idea] = await state.db!.insert(ideas).values({ url: HN_URL, kind: "hackernews", source: "scout", status: "new", content: "t", meta: { voice: "mine" } }).returning();
    const { job } = await (await POST(req({ ideaId: idea.id }))).json();
    expect(job.payload).toMatchObject({ voice: "mine", ownText: true });
  });

  it("a video's ready post becomes the post's version as it is, with its score: no job, no takes (2026-09-27)", async () => {
    const [post] = await state.db!.insert(ideas).values({
      kind: "video_idea", title: null, content: "Cole reused one sentence for ten years. That's the whole trick.",
      meta: { videoId: "v", articleUrl: "https://youtu.be/v", order: 0, format: "post", aiStyle: { slopScore: 18, verdict: "human", at: "2026-09-27T10:00:00.000Z" } },
    }).returning();

    const res = await POST(req({ ideaId: post.id }));
    expect(res.status).toBe(201);
    expect(await state.db!.select().from(jobs)).toHaveLength(0);
    const rows = await state.db!.select().from(drafts).where(eq(drafts.ideaId, post.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: "kept", xText: post.content, linkedinText: null });
    expect(rows[0].meta).toMatchObject({
      voice: "mine", overLimit: false,
      slop: { platform: "x", slopScore: 18, verdict: "human" }, slopByPlatform: { x: { slopScore: 18, verdict: "human" } },
    });
    const [after] = await state.db!.select().from(ideas).where(eq(ideas.id, post.id));
    expect(after.status).toBe("used");

    // Use again: the post is already in Write.
    expect((await POST(req({ ideaId: post.id }))).status).toBe(201);
    expect(await state.db!.select().from(drafts).where(eq(drafts.ideaId, post.id))).toHaveLength(1);
  });

  describe("a post from a repo becomes the post's version as it is: no job (2026-10-10)", () => {
    const repoPost = async (format: string, content: string, title?: string) => (await state.db!.insert(ideas).values({
      kind: "repo_post", title: title ?? null, content,
      meta: { jobId: "00000000-0000-4000-8000-000000000001", repoId: "r", format, order: 0, ...(title ? { title } : {}) },
    }).returning())[0];

    it("an X post", async () => {
      const post = await repoPost("x", "We shipped tier gating in a week.");
      expect((await POST(req({ ideaId: post.id }))).status).toBe(201);
      expect(await state.db!.select().from(jobs)).toHaveLength(0);
      const rows = await state.db!.select().from(drafts).where(eq(drafts.ideaId, post.id));
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ status: "kept", xText: post.content, linkedinText: null, articleTitle: null, articleText: null });
      expect(rows[0].meta).toMatchObject({ voice: "mine", overLimit: false });
      const [after] = await state.db!.select().from(ideas).where(eq(ideas.id, post.id));
      expect(after.status).toBe("used");
      // Use again: the post is already in Write.
      expect((await POST(req({ ideaId: post.id }))).status).toBe(201);
      expect(await state.db!.select().from(drafts).where(eq(drafts.ideaId, post.id))).toHaveLength(1);
    });

    it("a LinkedIn post", async () => {
      const post = await repoPost("linkedin", "A longer post about the launch. ".repeat(25));
      expect((await POST(req({ ideaId: post.id }))).status).toBe(201);
      const [draft] = await state.db!.select().from(drafts).where(eq(drafts.ideaId, post.id));
      expect(draft).toMatchObject({ status: "kept", xText: null, linkedinText: post.content, articleTitle: null, articleText: null });
      expect(draft.meta).toMatchObject({ voice: "mine" });
    });

    it("an X article: its title and body", async () => {
      const post = await repoPost("article", "Intro.\n\nHow it works\n\nThe body.", "What tier gating taught us");
      expect((await POST(req({ ideaId: post.id }))).status).toBe(201);
      const [draft] = await state.db!.select().from(drafts).where(eq(drafts.ideaId, post.id));
      expect(draft).toMatchObject({
        status: "kept", xText: null, linkedinText: null, articleTitle: "What tier gating taught us", articleText: post.content,
      });
      expect(await state.db!.select().from(jobs)).toHaveLength(0);
    });
  });

  it("a Videos topic writes from the whole text its video_ideas job read, about that topic (2026-09-27)", async () => {
    const [video] = await state.db!.insert(ideas).values({ url: "https://youtu.be/v", kind: "youtube", title: "The talk" }).returning();
    const [ideasJob] = await state.db!.insert(jobs).values({
      kind: "video_ideas", status: "done", payload: { ideaId: video.id },
      result: { ideas: [{ title: "Repetition beats novelty", summary: "Cole reused one sentence for ten years." }], source: "transcript", text: "the whole talk" },
    }).returning();
    const [topic] = await state.db!.insert(ideas).values({
      kind: "video_idea", title: "Repetition beats novelty", content: "Cole reused one sentence for ten years.",
      meta: { jobId: ideasJob.id, videoId: video.id, articleUrl: "https://youtu.be/v", order: 0 },
    }).returning();

    const res = await POST(req({ ideaId: topic.id, instructions: "shorter" }));
    expect(res.status).toBe(201);
    const { job } = await res.json();
    expect(res.headers.get("X-PostEcho-Job")).toBe(job.id);
    expect(job.kind).toBe("generate_from_video");
    expect(job.payload).toEqual({
      ideaId: topic.id,
      url: "https://youtu.be/v",
      transcript: "the whole talk",
      topic: { title: "Repetition beats novelty", summary: "Cole reused one sentence for ten years." },
      instructions: "shorter",
      count: 3,
      originalLanguage: false,
      voice: "reaction",
    });
    expect(vi.mocked(deepRead)).not.toHaveBeenCalled();
    const [after] = await state.db!.select().from(ideas).where(eq(ideas.id, topic.id));
    expect(after.status).toBe("used");
  });

  it("a Videos idea from before the topics keeps writing from its stored passage", async () => {
    const [old] = await state.db!.insert(ideas).values({
      kind: "video_idea", title: "An idea", content: "Angle",
      meta: { videoId: "v", articleUrl: "https://youtu.be/v", deepReadText: "An idea\n\nFrom the video: the passage" },
    }).returning();
    const { job } = await (await POST(req({ ideaId: old.id }))).json();
    expect(job.kind).toBe("generate_from_idea");
    expect(job.payload.seedText).toContain("the passage");
  });

  it("a YouTube card writes from the video's transcript (generate_from_video), as a reaction, and is marked used", async () => {
    const [video] = await state.db!.insert(ideas).values({ url: "https://www.youtube.com/watch?v=abc", kind: "youtube", source: "scout", status: "new", title: "A talk" }).returning();
    const res = await POST(req({ ideaId: video.id }));
    expect(res.status).toBe(201);
    const { job } = await res.json();
    expect(res.headers.get("X-PostEcho-Job")).toBe(job.id);
    expect(job.kind).toBe("generate_from_video");
    expect(job.payload).toEqual({ ideaId: video.id, url: "https://www.youtube.com/watch?v=abc", instructions: "", count: 3, originalLanguage: false, voice: "reaction" });
    expect(vi.mocked(deepRead)).not.toHaveBeenCalled();
    const [after] = await state.db!.select().from(ideas).where(eq(ideas.id, video.id));
    expect(after.status).toBe("used");
  });
});
