import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb } from "@/test/db";
import { drafts, ideas, jobs } from "@/db/schema";

const state: { db: Awaited<ReturnType<typeof createTestDb>> | null } = { db: null };
vi.mock("@/db", () => ({ get db() { return state.db; } }));
vi.mock("@/lib/session", async (orig) => ({
  ...(await orig()),
  requireSession: vi.fn(async () => null),
}));

const { GET, DELETE } = await import("@/app/api/drafts/route");
const { PATCH } = await import("@/app/api/drafts/[id]/route");
const { POST: postFromIdea } = await import("@/app/api/drafts/from-idea/route");
const { POST: postRevise } = await import("@/app/api/drafts/[id]/revise/route");
const { POST: postImagePrompt } = await import("@/app/api/drafts/[id]/image-prompt/route");

beforeEach(async () => {
  state.db = await createTestDb();
  const { requireSession } = await import("@/lib/session");
  const mock = requireSession as unknown as ReturnType<typeof vi.fn>;
  mock.mockReset();
  mock.mockResolvedValue(null);
});

function denySession() {
  return import("@/lib/session").then(({ requireSession }) => {
    (requireSession as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      Response.json({ error: "unauthorized" }, { status: 401 }),
    );
  });
}

function getReq(qs = "") {
  return new Request(`http://test/api/drafts${qs}`);
}

function jsonReq(url: string, method: string, body?: unknown) {
  return new Request(url, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

describe("GET /api/drafts", () => {
  it("401s when the session is denied", async () => {
    await denySession();
    expect((await GET(getReq())).status).toBe(401);
  });

  it("lists drafts newest first, joined with the idea summary and latest job status", async () => {
    const [idea] = await state.db!.insert(ideas).values({ kind: "youtube", url: "https://youtu.be/x", title: "A talk" }).returning();
    await state.db!.insert(jobs).values({ kind: "generate_from_video", payload: { ideaId: idea.id }, status: "done" });
    await state.db!.insert(drafts).values({ ideaId: idea.id, xText: "hi" });

    const res = await GET(getReq());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.drafts).toHaveLength(1);
    expect(body.drafts[0].idea).toMatchObject({ id: idea.id, title: "A talk" });
    expect(body.drafts[0].latestJobStatus).toBe("done");
  });

  it("filters by ideaId", async () => {
    const [idea] = await state.db!.insert(ideas).values({ kind: "note", content: "a" }).returning();
    await state.db!.insert(drafts).values({ ideaId: idea.id, xText: "for idea" });
    await state.db!.insert(drafts).values({ xText: "no idea" });

    const res = await GET(getReq(`?ideaId=${idea.id}`));
    const body = await res.json();
    expect(body.drafts).toHaveLength(1);
    expect(body.drafts[0].xText).toBe("for idea");
  });

  it("rejects an invalid ideaId", async () => {
    expect((await GET(getReq("?ideaId=not-a-uuid"))).status).toBe(400);
  });

  it("filters by status", async () => {
    await state.db!.insert(drafts).values({ xText: "a candidate", status: "candidate" });
    await state.db!.insert(drafts).values({ xText: "a keeper", status: "kept" });
    const res = await GET(getReq("?status=kept"));
    const body = await res.json();
    expect(body.drafts).toHaveLength(1);
    expect(body.drafts[0].xText).toBe("a keeper");
  });

  it("rejects an invalid status", async () => {
    expect((await GET(getReq("?status=bogus"))).status).toBe(400);
  });

  it("respects a valid limit and rejects an invalid one", async () => {
    for (let i = 0; i < 3; i++) await state.db!.insert(drafts).values({ xText: `d${i}` });
    expect((await GET(getReq("?limit=0"))).status).toBe(400);
    expect((await GET(getReq("?limit=abc"))).status).toBe(400);
    const res = await GET(getReq("?limit=2"));
    expect((await res.json()).drafts).toHaveLength(2);
  });
});

describe("PATCH /api/drafts/:id", () => {
  it("401s when the session is denied", async () => {
    await denySession();
    const res = await PATCH(
      jsonReq("http://test/api/drafts/x", "PATCH", { status: "kept" }),
      { params: Promise.resolve({ id: "00000000-0000-0000-0000-000000000000" }) },
    );
    expect(res.status).toBe(401);
  });

  it("updates xText, linkedinText, status and favorite", async () => {
    const [draft] = await state.db!.insert(drafts).values({ xText: "old" }).returning();
    const res = await PATCH(
      jsonReq("http://test/api/drafts/x", "PATCH", {
        xText: "new text", linkedinText: "a linkedin version", status: "kept", favorite: true,
      }),
      { params: Promise.resolve({ id: draft.id }) },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.draft).toMatchObject({
      xText: "new text", linkedinText: "a linkedin version", status: "kept", favorite: true,
    });
  });

  it("saves an article's title and body (posts from a repo, 2026-10-10)", async () => {
    const [draft] = await state.db!.insert(drafts).values({ articleTitle: "Old", articleText: "Old body" }).returning();
    const res = await PATCH(
      jsonReq("http://test/api/drafts/x", "PATCH", { articleTitle: "What we shipped", articleText: "A long body" }),
      { params: Promise.resolve({ id: draft.id }) },
    );
    expect(res.status).toBe(200);
    expect((await res.json()).draft).toMatchObject({ articleTitle: "What we shipped", articleText: "A long body" });
  });

  it("400s for an article title over 100 characters or a body over 12,000", async () => {
    const [draft] = await state.db!.insert(drafts).values({ articleTitle: "T", articleText: "B" }).returning();
    const params = { params: Promise.resolve({ id: draft.id }) };
    expect((await PATCH(jsonReq("http://test/api/drafts/x", "PATCH", { articleTitle: "a".repeat(101) }), params)).status).toBe(400);
    expect((await PATCH(jsonReq("http://test/api/drafts/x", "PATCH", { articleText: "a".repeat(12001) }), params)).status).toBe(400);
  });

  it("404s for a non-uuid id", async () => {
    const res = await PATCH(
      jsonReq("http://test/api/drafts/x", "PATCH", { status: "kept" }),
      { params: Promise.resolve({ id: "not-a-uuid" }) },
    );
    expect(res.status).toBe(404);
  });

  it("404s for a well-formed uuid that doesn't exist", async () => {
    const res = await PATCH(
      jsonReq("http://test/api/drafts/x", "PATCH", { status: "kept" }),
      { params: Promise.resolve({ id: "00000000-0000-0000-0000-000000000000" }) },
    );
    expect(res.status).toBe(404);
  });

  it("400s for an invalid status value", async () => {
    const [draft] = await state.db!.insert(drafts).values({ xText: "old" }).returning();
    const res = await PATCH(
      jsonReq("http://test/api/drafts/x", "PATCH", { status: "not-a-real-status" }),
      { params: Promise.resolve({ id: draft.id }) },
    );
    expect(res.status).toBe(400);
  });

  it("400s for an empty body (no fields to update)", async () => {
    const [draft] = await state.db!.insert(drafts).values({ xText: "old" }).returning();
    const res = await PATCH(
      jsonReq("http://test/api/drafts/x", "PATCH", {}),
      { params: Promise.resolve({ id: draft.id }) },
    );
    expect(res.status).toBe(400);
  });

  it("400s for an unknown field (strict body)", async () => {
    const [draft] = await state.db!.insert(drafts).values({ xText: "old" }).returning();
    const res = await PATCH(
      jsonReq("http://test/api/drafts/x", "PATCH", { nonsense: true }),
      { params: Promise.resolve({ id: draft.id }) },
    );
    expect(res.status).toBe(400);
  });
});

describe("POST /api/drafts/from-idea", () => {
  it("401s when the session is denied", async () => {
    await denySession();
    const res = await postFromIdea(jsonReq("http://test/api/drafts/from-idea", "POST", { ideaId: "x" }));
    expect(res.status).toBe(401);
  });

  it("400s on a missing/invalid ideaId", async () => {
    expect((await postFromIdea(jsonReq("http://test/api/drafts/from-idea", "POST", {}))).status).toBe(400);
    expect((await postFromIdea(jsonReq("http://test/api/drafts/from-idea", "POST", { ideaId: "not-a-uuid" }))).status).toBe(400);
  });

  it("404s when the idea doesn't exist", async () => {
    const res = await postFromIdea(
      jsonReq("http://test/api/drafts/from-idea", "POST", { ideaId: "00000000-0000-0000-0000-000000000000" }),
    );
    expect(res.status).toBe(404);
  });

  it("enqueues a generate_from_idea job with seedText/seedUrl derived from the idea, marks it used", async () => {
    const [idea] = await state.db!.insert(ideas).values({
      kind: "x_post", url: "https://x.com/a/status/1", content: "the idea's content", title: "a title",
    }).returning();

    const res = await postFromIdea(
      jsonReq("http://test/api/drafts/from-idea", "POST", { ideaId: idea.id, instructions: "make it punchy", count: 5 }),
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.job.kind).toBe("generate_from_idea");
    expect(body.job.payload).toMatchObject({
      ideaId: idea.id,
      // An X post names its author's handle, so Claude's tag for them is exact (2026-09-24).
      seedText: "Post on X by @a:\nthe idea's content",
      seedUrl: "https://x.com/a/status/1",
      instructions: "make it punchy",
      count: 5,
    });

    const [updatedIdea] = await state.db!.select().from(ideas).where(eq(ideas.id, idea.id));
    expect(updatedIdea.status).toBe("used");
  });

  it("defaults instructions to empty string and count to 3", async () => {
    const [idea] = await state.db!.insert(ideas).values({ kind: "note", content: "seed" }).returning();
    const res = await postFromIdea(jsonReq("http://test/api/drafts/from-idea", "POST", { ideaId: idea.id }));
    const body = await res.json();
    expect(body.job.payload).toMatchObject({ instructions: "", count: 3 });
  });

  it("falls back seedText to title, then url, when content is absent", async () => {
    const [ideaWithTitle] = await state.db!.insert(ideas).values({ kind: "article", url: "https://example.com/a", title: "a title" }).returning();
    const res1 = await postFromIdea(jsonReq("http://test/api/drafts/from-idea", "POST", { ideaId: ideaWithTitle.id }));
    expect((await res1.json()).job.payload.seedText).toBe("a title");

    const [ideaUrlOnly] = await state.db!.insert(ideas).values({ kind: "article", url: "https://example.com/b" }).returning();
    const res2 = await postFromIdea(jsonReq("http://test/api/drafts/from-idea", "POST", { ideaId: ideaUrlOnly.id }));
    expect((await res2.json()).job.payload.seedText).toBe("https://example.com/b");
  });

  it("rejects an out-of-range count", async () => {
    const [idea] = await state.db!.insert(ideas).values({ kind: "note", content: "seed" }).returning();
    const res = await postFromIdea(jsonReq("http://test/api/drafts/from-idea", "POST", { ideaId: idea.id, count: 6 }));
    expect(res.status).toBe(400);
  });
});

describe("POST /api/drafts/:id/revise", () => {
  it("401s when the session is denied", async () => {
    await denySession();
    const res = await postRevise(
      jsonReq("http://test", "POST", { instruction: "punchier" }),
      { params: Promise.resolve({ id: "00000000-0000-0000-0000-000000000000" }) },
    );
    expect(res.status).toBe(401);
  });

  it("404s when the draft doesn't exist", async () => {
    const res = await postRevise(
      jsonReq("http://test", "POST", { instruction: "punchier" }),
      { params: Promise.resolve({ id: "00000000-0000-0000-0000-000000000000" }) },
    );
    expect(res.status).toBe(404);
  });

  it("400s on a missing or too-long instruction", async () => {
    const [draft] = await state.db!.insert(drafts).values({ xText: "original" }).returning();
    expect((await postRevise(jsonReq("http://test", "POST", {}), { params: Promise.resolve({ id: draft.id }) })).status).toBe(400);
    expect((await postRevise(
      jsonReq("http://test", "POST", { instruction: "x".repeat(501) }),
      { params: Promise.resolve({ id: draft.id }) },
    )).status).toBe(400);
  });

  it("enqueues a revise_draft job carrying the draft's current text and the instruction", async () => {
    const [draft] = await state.db!.insert(drafts).values({ xText: "original x", linkedinText: "original linkedin" }).returning();
    const res = await postRevise(
      jsonReq("http://test", "POST", { instruction: "make it punchier" }),
      { params: Promise.resolve({ id: draft.id }) },
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.job.kind).toBe("revise_draft");
    expect(res.headers.get("X-PostEcho-Job")).toBe(body.job.id);
    expect(body.job.payload).toMatchObject({
      draftId: draft.id, xText: "original x", linkedinText: "original linkedin", instruction: "make it punchier",
    });
    expect(body.job.payload.humanize).toBeUndefined();
  });

  it("Humanize (M3.6): `humanize` puts the platform in the payload for the agent's Claude <-> Jev loop", async () => {
    const [draft] = await state.db!.insert(drafts).values({ xText: "original x", linkedinText: "original linkedin" }).returning();
    const res = await postRevise(
      jsonReq("http://test", "POST", { instruction: "Rewrite the X text so it reads human", humanize: "x" }),
      { params: Promise.resolve({ id: draft.id }) },
    );
    expect(res.status).toBe(201);
    expect((await res.json()).job.payload).toMatchObject({ humanize: "x", instruction: "Rewrite the X text so it reads human" });
  });

  it("Edit with Claude: the source (the full read first), the voice and the requests so far go with the job", async () => {
    const [idea] = await state.db!.insert(ideas).values({
      kind: "hackernews", url: "https://news.ycombinator.com/item?id=9", content: "card text",
      meta: { deepReadText: "the full HN story and article" },
    }).returning();
    const [v1] = await state.db!.insert(drafts).values({ ideaId: idea.id, xText: "x1", linkedinText: "l1", status: "candidate" }).returning();
    const [v2] = await state.db!.insert(drafts).values({ ideaId: idea.id, parentId: v1.id, xText: "x2", linkedinText: "l1", status: "kept", meta: { instruction: "Shorter", mode: "custom" } }).returning();
    const res = await postRevise(
      jsonReq("http://test", "POST", { instruction: "Rewrite the LinkedIn version from the X one.", mode: "sync_linkedin", label: "Update LinkedIn from X" }),
      { params: Promise.resolve({ id: v2.id }) },
    );
    expect(res.status).toBe(201);
    expect((await res.json()).job.payload).toMatchObject({
      draftId: v2.id, xText: "x2", linkedinText: "l1", mode: "sync_linkedin", label: "Update LinkedIn from X",
      voice: "reaction", sourceText: "the full HN story and article", history: ["Shorter"],
    });
  });

  it("a post from a repo: moving it to the other platform sends the repository, so the agent reads all of it (2026-10-10)", async () => {
    const [repo] = await state.db!.insert(ideas).values({ kind: "repo", url: "https://github.com/a/b", title: "a/b", meta: { sourceType: "github" } }).returning();
    const [folder] = await state.db!.insert(ideas).values({ kind: "repo", url: "file:///Users/me/dev/p", title: "p", meta: { sourceType: "folder", path: "/Users/me/dev/p" } }).returning();
    const [fromGithub] = await state.db!.insert(ideas).values({ kind: "repo_post", content: "the X post", meta: { repoId: repo.id, format: "x" } }).returning();
    const [fromFolder] = await state.db!.insert(ideas).values({ kind: "repo_post", content: "another", meta: { repoId: folder.id, format: "x" } }).returning();
    const [d1] = await state.db!.insert(drafts).values({ ideaId: fromGithub.id, xText: "the X post", status: "kept" }).returning();
    const [d2] = await state.db!.insert(drafts).values({ ideaId: fromFolder.id, xText: "another", status: "kept" }).returning();
    const li = await postRevise(jsonReq("http://test", "POST", { instruction: "Write the LinkedIn version", mode: "sync_linkedin" }), { params: Promise.resolve({ id: d1.id }) });
    expect((await li.json()).job.payload.repo).toEqual({ type: "github", url: "https://github.com/a/b" });
    const li2 = await postRevise(jsonReq("http://test", "POST", { instruction: "Write the LinkedIn version", mode: "sync_linkedin" }), { params: Promise.resolve({ id: d2.id }) });
    expect((await li2.json()).job.payload.repo).toEqual({ type: "folder", path: "/Users/me/dev/p" });
    const edit = await postRevise(jsonReq("http://test", "POST", { instruction: "shorter", mode: "custom" }), { params: Promise.resolve({ id: d1.id }) });
    expect((await edit.json()).job.payload.repo).toBeUndefined();
  });

  it("Edit with Claude: a voice switch is remembered on the idea; the default follows where the idea came from", async () => {
    const [note] = await state.db!.insert(ideas).values({ kind: "note", content: "my notes" }).returning();
    const [draft] = await state.db!.insert(drafts).values({ ideaId: note.id, xText: "x", status: "kept" }).returning();
    const custom = await postRevise(jsonReq("http://test", "POST", { instruction: "shorter", mode: "custom" }), { params: Promise.resolve({ id: draft.id }) });
    expect((await custom.json()).job.payload).toMatchObject({ voice: "mine", sourceText: "my notes", history: [] });

    const res = await postRevise(jsonReq("http://test", "POST", { instruction: "as a reaction", mode: "voice", voice: "reaction" }), { params: Promise.resolve({ id: draft.id }) });
    expect((await res.json()).job.payload).toMatchObject({ mode: "voice", voice: "reaction" });
    const [after] = await state.db!.select().from(ideas).where(eq(ideas.id, note.id));
    expect(after.meta).toMatchObject({ voice: "reaction" });
  });

  it("Edit with Claude: 400 for a sync with nothing to sync from, a voice switch without a voice, an unknown mode", async () => {
    const [xOnly] = await state.db!.insert(drafts).values({ xText: "only x" }).returning();
    const [liOnly] = await state.db!.insert(drafts).values({ linkedinText: "only linkedin" }).returning();
    const call = (id: string, body: unknown) => postRevise(jsonReq("http://test", "POST", body), { params: Promise.resolve({ id }) });
    expect((await call(liOnly.id, { instruction: "i", mode: "sync_linkedin" })).status).toBe(400);
    expect((await call(xOnly.id, { instruction: "i", mode: "sync_x" })).status).toBe(400);
    expect((await call(xOnly.id, { instruction: "i", mode: "voice" })).status).toBe(400);
    expect((await call(xOnly.id, { instruction: "i", mode: "rewrite-everything" })).status).toBe(400);
    expect((await call(xOnly.id, { instruction: "i", mode: "sync_linkedin", label: "x".repeat(121) })).status).toBe(400);
  });

  it("Humanize: 400 when that platform has no text, or for an unknown platform", async () => {
    const [draft] = await state.db!.insert(drafts).values({ xText: "only x" }).returning();
    const params = { params: Promise.resolve({ id: draft.id }) };
    expect((await postRevise(jsonReq("http://test", "POST", { instruction: "h", humanize: "linkedin" }), params)).status).toBe(400);
    expect((await postRevise(jsonReq("http://test", "POST", { instruction: "h", humanize: "tiktok" }), { params: Promise.resolve({ id: draft.id }) })).status).toBe(400);
  });
});

describe("POST /api/drafts/:id/image-prompt", () => {
  it("401s when the session is denied", async () => {
    await denySession();
    const res = await postImagePrompt(
      jsonReq("http://test", "POST"),
      { params: Promise.resolve({ id: "00000000-0000-0000-0000-000000000000" }) },
    );
    expect(res.status).toBe(401);
  });

  it("404s when the draft doesn't exist", async () => {
    const res = await postImagePrompt(
      jsonReq("http://test", "POST"),
      { params: Promise.resolve({ id: "00000000-0000-0000-0000-000000000000" }) },
    );
    expect(res.status).toBe(404);
  });

  it("enqueues an image_prompt job carrying the draft's text and the saved imageSpecs", async () => {
    const { setSetting } = await import("@/lib/settings");
    await setSetting(state.db as never, "imageSpecs", "16:9, minimalist, no stock photos");
    const [draft] = await state.db!.insert(drafts).values({ xText: "hi", linkedinText: "hello" }).returning();

    const res = await postImagePrompt(jsonReq("http://test", "POST"), { params: Promise.resolve({ id: draft.id }) });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.job.kind).toBe("image_prompt");
    expect(res.headers.get("X-PostEcho-Job")).toBe(body.job.id);
    expect(body.job.payload).toMatchObject({
      draftId: draft.id, xText: "hi", linkedinText: "hello", imageSpecs: "16:9, minimalist, no stock photos",
    });
  });
});

describe("GET /api/drafts?view=in-progress", () => {
  it("401s when the session is denied", async () => {
    await denySession();
    expect((await GET(getReq("?view=in-progress"))).status).toBe(401);
  });

  it("returns one post per idea that has kept/candidate drafts", async () => {
    const [idea] = await state.db!.insert(ideas).values({ kind: "x_post", url: "https://x.com/a/status/1", title: "A" }).returning();
    await state.db!.insert(jobs).values({ kind: "generate_from_idea", payload: { ideaId: idea.id }, status: "claimed" });
    await state.db!.insert(drafts).values({ ideaId: idea.id, xText: "take 1", status: "candidate" });
    const [kept] = await state.db!.insert(drafts).values({ ideaId: idea.id, xText: "take 2", status: "kept" }).returning();
    await state.db!.insert(drafts).values({ ideaId: idea.id, xText: "binned", status: "discarded" });

    const res = await GET(getReq("?view=in-progress"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.posts).toEqual([{
      ideaId: idea.id,
      idea: { id: idea.id, title: "A", url: "https://x.com/a/status/1", kind: "x_post" },
      chosenDraftId: kept.id,
      takeCount: 2,
      latestJobStatus: "claimed",
    }]);
  });

  it("returns an empty list when nothing is in progress", async () => {
    await state.db!.insert(drafts).values({ xText: "binned", status: "discarded" });
    const body = await (await GET(getReq("?view=in-progress"))).json();
    expect(body.posts).toEqual([]);
  });

  it("rejects an unknown view", async () => {
    expect((await GET(getReq("?view=bogus"))).status).toBe(400);
  });
});

describe("DELETE /api/drafts?ideaId=", () => {
  function del(qs: string) {
    return DELETE(new Request(`http://test/api/drafts${qs}`, { method: "DELETE" }));
  }

  it("401s when the session is denied", async () => {
    await denySession();
    expect((await del("?ideaId=00000000-0000-0000-0000-000000000000")).status).toBe(401);
  });

  it("400s on a missing or non-uuid ideaId", async () => {
    expect((await del("")).status).toBe(400);
    expect((await del("?ideaId=not-a-uuid")).status).toBe(400);
  });

  it("discards the idea's kept/candidate drafts, leaves used ones and other ideas alone, and reports the count", async () => {
    const [idea] = await state.db!.insert(ideas).values({ kind: "note", content: "removed", status: "used" }).returning();
    const [other] = await state.db!.insert(ideas).values({ kind: "note", content: "other" }).returning();
    await state.db!.insert(drafts).values([
      { ideaId: idea.id, xText: "take 1", status: "candidate" },
      { ideaId: idea.id, xText: "take 2", status: "kept" },
      { ideaId: idea.id, xText: "published", status: "used" },
      { ideaId: idea.id, xText: "binned", status: "discarded" },
      { ideaId: other.id, xText: "elsewhere", status: "candidate" },
    ]);

    const res = await del(`?ideaId=${idea.id}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ideaId: idea.id, discarded: 2 });

    const rows = await state.db!.select().from(drafts);
    expect(Object.fromEntries(rows.map((d) => [d.xText, d.status]))).toEqual({
      "take 1": "discarded", "take 2": "discarded", published: "used", binned: "discarded", elsewhere: "candidate",
    });
    // The idea stays as it was (on Liked); only the other post is still in progress.
    const [unchanged] = await state.db!.select().from(ideas).where(eq(ideas.id, idea.id));
    expect(unchanged.status).toBe("used");
    const { posts } = await (await GET(getReq("?view=in-progress"))).json();
    expect(posts.map((p: { ideaId: string }) => p.ideaId)).toEqual([other.id]);
  });

  it("is a no-op 200 with discarded: 0 for an unknown idea", async () => {
    const res = await del("?ideaId=00000000-0000-0000-0000-000000000000");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ideaId: "00000000-0000-0000-0000-000000000000", discarded: 0 });
  });
});

describe("ready to schedule (schedule in a row, 2026-10-10)", () => {
  it("a draft is not ready until the owner says so: readyAt starts null", async () => {
    const [draft] = await state.db!.insert(drafts).values({ xText: "A post" }).returning();
    expect(draft.readyAt).toBeNull();
  });
});
