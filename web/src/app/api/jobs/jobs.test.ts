import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb } from "@/test/db";
import { ideas, jobs } from "@/db/schema";

const state: { db: Awaited<ReturnType<typeof createTestDb>> | null } = { db: null };
vi.mock("@/db", () => ({ get db() { return state.db; } }));
vi.mock("@/lib/session", async (orig) => ({
  ...(await orig()),
  requireSession: vi.fn(async () => null),
}));

const { GET } = await import("@/app/api/jobs/route");

beforeEach(async () => {
  state.db = await createTestDb();
  const { requireSession } = await import("@/lib/session");
  const mock = requireSession as unknown as ReturnType<typeof vi.fn>;
  mock.mockReset();
  mock.mockResolvedValue(null);
});

function req(qs = "") {
  return new Request(`http://test/api/jobs${qs}`);
}

describe("GET /api/jobs", () => {
  it("filters by kind", async () => {
    await state.db!.insert(jobs).values({ kind: "scout", payload: { query: "ai audio" } });
    await state.db!.insert(jobs).values({ kind: "generate_from_video", payload: { url: "https://youtu.be/x" } });

    const res = await GET(req("?kind=scout"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.jobs).toHaveLength(1);
    expect(body.jobs[0].kind).toBe("scout");
    expect(body.jobs[0].query).toBe("ai audio");
  });

  it("returns null query for a job kind whose payload has no query", async () => {
    await state.db!.insert(jobs).values({ kind: "generate_from_video", payload: { url: "https://youtu.be/x" } });
    const res = await GET(req("?kind=generate_from_video"));
    const body = await res.json();
    expect(body.jobs[0].query).toBeNull();
  });

  it("a repo_posts job carries its payload, so From a repo can say its steps and run it again; others don't", async () => {
    const payload = { ideaId: "00000000-0000-0000-0000-000000000001", source: { type: "folder", path: "/r" }, brief: "", format: "x", count: 3 };
    await state.db!.insert(jobs).values({ kind: "repo_posts", payload });
    await state.db!.insert(jobs).values({ kind: "generate_from_video", payload: { url: "https://youtu.be/x" } });
    const body = await (await GET(req())).json();
    expect(body.jobs.find((j: { kind: string }) => j.kind === "repo_posts").payload).toEqual(payload);
    expect(body.jobs.find((j: { kind: string }) => j.kind === "generate_from_video").payload).toBeUndefined();
  });

  it("rejects an invalid kind", async () => {
    const res = await GET(req("?kind=not-a-real-kind"));
    expect(res.status).toBe(400);
  });

  it("returns everything ordered by createdAt desc when kind is omitted", async () => {
    await state.db!.insert(jobs).values({
      kind: "scout", payload: { query: "older" }, createdAt: new Date("2020-01-01T00:00:00Z"),
    });
    await state.db!.insert(jobs).values({
      kind: "scout", payload: { query: "newer" }, createdAt: new Date("2020-01-02T00:00:00Z"),
    });
    const res = await GET(req());
    const body = await res.json();
    expect(body.jobs.map((j: { query: string }) => j.query)).toEqual(["newer", "older"]);
  });

  it("includes status, createdAt, finishedAt and result", async () => {
    await state.db!.insert(jobs).values({
      kind: "scout", payload: { query: "ai" }, status: "done", result: { pushed: 3 },
      finishedAt: new Date("2020-01-01T00:00:00Z"),
    });
    const res = await GET(req());
    const body = await res.json();
    expect(body.jobs[0]).toMatchObject({ status: "done", result: { pushed: 3 } });
    expect(body.jobs[0].createdAt).toBeTruthy();
    expect(body.jobs[0].finishedAt).toBeTruthy();
  });

  it("defaults the limit and rejects an out-of-range limit", async () => {
    for (let i = 0; i < 3; i++) {
      await state.db!.insert(jobs).values({ kind: "scout", payload: { query: `q${i}` } });
    }
    expect((await GET(req("?limit=0"))).status).toBe(400);
    expect((await GET(req("?limit=51"))).status).toBe(400);
    expect((await GET(req("?limit=abc"))).status).toBe(400);

    const res = await GET(req("?limit=2"));
    const body = await res.json();
    expect(body.jobs).toHaveLength(2);
  });

  describe("seedKind join (mode-scoped searches strip)", () => {
    it("joins the seed idea's kind when payload.seedIdeaId exists", async () => {
      const [video] = await state.db!.insert(ideas).values({ kind: "youtube", url: "https://youtu.be/x" }).returning();
      await state.db!.insert(jobs).values({ kind: "scout", payload: { query: "growth tips", seedIdeaId: video.id } });

      const res = await GET(req());
      const body = await res.json();
      expect(body.jobs[0].seedKind).toBe("youtube");
    });

    it("reports null seedKind for a topic search with no seed idea", async () => {
      await state.db!.insert(jobs).values({ kind: "scout", payload: { query: "ai audio" } });
      const res = await GET(req());
      const body = await res.json();
      expect(body.jobs[0].seedKind).toBeNull();
    });

    it("reports null seedKind if the seed idea no longer exists", async () => {
      await state.db!.insert(jobs).values({
        kind: "scout", payload: { query: "ai audio", seedIdeaId: "00000000-0000-0000-0000-000000000000" },
      });
      const res = await GET(req());
      const body = await res.json();
      expect(body.jobs[0].seedKind).toBeNull();
    });

    it("resolves seedKind for multiple jobs in one batched query", async () => {
      const [video] = await state.db!.insert(ideas).values({ kind: "youtube", url: "https://youtu.be/x" }).returning();
      const [post] = await state.db!.insert(ideas).values({ kind: "x_post", url: "https://x.com/a/status/1" }).returning();
      await state.db!.insert(jobs).values({ kind: "scout", payload: { query: "q1", seedIdeaId: video.id } });
      await state.db!.insert(jobs).values({ kind: "scout", payload: { query: "q2", seedIdeaId: post.id } });

      const res = await GET(req());
      const body = await res.json();
      const seedKindByQuery = Object.fromEntries(body.jobs.map((j: { query: string; seedKind: string }) => [j.query, j.seedKind]));
      expect(seedKindByQuery).toEqual({ q1: "youtube", q2: "x_post" });
    });
  });

  it("401s when the session is denied", async () => {
    const { requireSession } = await import("@/lib/session");
    (requireSession as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      Response.json({ error: "unauthorized" }, { status: 401 }),
    );
    const res = await GET(req());
    expect(res.status).toBe(401);
  });

  describe("?id= filter (task A6)", () => {
    it("returns only the matching job", async () => {
      const [a] = await state.db!.insert(jobs).values({ kind: "scout", payload: { query: "a" } }).returning();
      await state.db!.insert(jobs).values({ kind: "scout", payload: { query: "b" } });

      const res = await GET(req(`?id=${a.id}`));
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.jobs).toHaveLength(1);
      expect(body.jobs[0].id).toBe(a.id);
    });

    it("returns an empty list for a well-formed id that matches nothing", async () => {
      const res = await GET(req("?id=00000000-0000-0000-0000-000000000000"));
      expect(res.status).toBe(200);
      expect((await res.json()).jobs).toEqual([]);
    });

    it("rejects a non-uuid id", async () => {
      const res = await GET(req("?id=not-a-uuid"));
      expect(res.status).toBe(400);
    });

    it("combines with kind (AND, not OR)", async () => {
      const [a] = await state.db!.insert(jobs).values({ kind: "scout", payload: {} }).returning();
      const res = await GET(req(`?id=${a.id}&kind=generate_from_video`));
      expect(res.status).toBe(200);
      expect((await res.json()).jobs).toEqual([]);
    });
  });

  describe("?ideaId= filter (task A6, payload->>'ideaId')", () => {
    it("returns only jobs whose payload.ideaId matches", async () => {
      const [idea] = await state.db!.insert(ideas).values({ kind: "youtube", url: "https://youtu.be/x" }).returning();
      await state.db!.insert(jobs).values({ kind: "generate_from_video", payload: { ideaId: idea.id } });
      await state.db!.insert(jobs).values({ kind: "generate_from_idea", payload: { ideaId: "00000000-0000-0000-0000-000000000000" } });
      await state.db!.insert(jobs).values({ kind: "scout", payload: { query: "no idea here" } });

      const res = await GET(req(`?ideaId=${idea.id}`));
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.jobs).toHaveLength(1);
      expect(body.jobs[0].kind).toBe("generate_from_video");
    });

    it("returns an empty list for a well-formed ideaId that matches nothing", async () => {
      const res = await GET(req("?ideaId=00000000-0000-0000-0000-000000000000"));
      expect(res.status).toBe(200);
      expect((await res.json()).jobs).toEqual([]);
    });

    it("rejects a non-uuid ideaId", async () => {
      const res = await GET(req("?ideaId=not-a-uuid"));
      expect(res.status).toBe(400);
    });

    it("a video's topics job comes without the whole text the agent read: that stays on the server for Use", async () => {
      const [video] = await state.db!.insert(ideas).values({ kind: "youtube", url: "https://youtu.be/x" }).returning();
      await state.db!.insert(jobs).values({
        kind: "video_ideas", status: "done", payload: { ideaId: video.id },
        result: { ideas: [{ title: "t", summary: "s" }], source: "transcript", text: "the whole transcript" },
      });
      const body = await (await GET(req(`?ideaId=${video.id}&kind=video_ideas`))).json();
      expect(body.jobs[0].result).toEqual({ ideas: [{ title: "t", summary: "s" }], source: "transcript" });
    });

    it("does not match a job whose payload has no ideaId key at all", async () => {
      await state.db!.insert(jobs).values({ kind: "scout", payload: { query: "x" } });
      const res = await GET(req("?ideaId=00000000-0000-0000-0000-000000000000"));
      expect((await res.json()).jobs).toEqual([]);
    });
  });
});
