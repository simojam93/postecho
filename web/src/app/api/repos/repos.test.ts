import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb } from "@/test/db";

const state: { db: Awaited<ReturnType<typeof createTestDb>> | null } = { db: null };
vi.mock("@/db", () => ({ get db() { return state.db; } }));
vi.mock("@/lib/session", async (orig) => ({
  ...(await orig()),
  requireSession: vi.fn(async () => null),
}));

const { POST: create } = await import("@/app/api/repos/route");
const { POST: pick } = await import("@/app/api/repos/pick/route");
const { ideas, jobs } = await import("@/db/schema");
const { setSetting } = await import("@/lib/settings");

const post = (body: unknown) => create(new Request("http://test/api/repos", { method: "POST", body: JSON.stringify(body) }));
const UPDATE = "Update the agent: git pull, then restart npm run dev.";

beforeEach(async () => { state.db = await createTestDb(); });
afterEach(() => { vi.clearAllMocks(); });

describe("POST /api/repos", () => {
  it("saves a folder as a repo source and asks the agent for posts from it", async () => {
    const res = await post({ source: { type: "folder", path: "/Users/me/dev/postecho/" }, brief: "tier gating", format: "x", count: 3 });
    expect(res.status).toBe(201);
    const body = await res.json();
    const [repo] = await state.db!.select().from(ideas);
    expect(repo).toMatchObject({ kind: "repo", source: "manual", status: "new", url: "file:///Users/me/dev/postecho", title: "postecho" });
    expect(repo.meta).toMatchObject({ sourceType: "folder" });
    const [job] = await state.db!.select().from(jobs);
    expect(res.headers.get("X-PostEcho-Job")).toBe(job.id);
    expect(body).toEqual({ ideaId: repo.id, jobId: job.id });
    expect(job.kind).toBe("repo_posts");
    expect(job.payload).toEqual({
      ideaId: repo.id, source: { type: "folder", path: "/Users/me/dev/postecho" }, brief: "tier gating", format: "x", count: 3,
    });
  });

  it("a GitHub link is normalized; brief and count have defaults", async () => {
    const res = await post({ source: { type: "github", url: "http://www.github.com/simojam93/jev-judge.git" }, format: "article" });
    expect(res.status).toBe(201);
    const [repo] = await state.db!.select().from(ideas);
    expect(repo).toMatchObject({ kind: "repo", url: "https://github.com/simojam93/jev-judge", title: "simojam93/jev-judge" });
    expect(repo.meta).toMatchObject({ sourceType: "github" });
    const [job] = await state.db!.select().from(jobs);
    expect(job.payload).toEqual({
      ideaId: repo.id, source: { type: "github", url: "https://github.com/simojam93/jev-judge" }, brief: "", format: "article", count: 3,
    });
  });

  it("the same source again reuses its idea, back among the sources, with a new job", async () => {
    await post({ source: { type: "github", url: "https://github.com/a/b" }, format: "x" });
    const [first] = await state.db!.select().from(ideas);
    const { eq } = await import("drizzle-orm");
    await state.db!.update(ideas).set({ status: "dismissed" }).where(eq(ideas.id, first.id));
    const res = await post({ source: { type: "github", url: "https://github.com/a/b/" }, format: "linkedin", count: 1 });
    expect((await res.json()).ideaId).toBe(first.id);
    const rows = await state.db!.select().from(ideas);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("new");
    expect(await state.db!.select().from(jobs)).toHaveLength(2);
  });

  it("a GitHub repo the scout found before becomes the repo source", async () => {
    await state.db!.insert(ideas).values({ kind: "github", source: "scout", url: "https://github.com/a/b", title: "a/b: a thing" });
    const res = await post({ source: { type: "github", url: "https://github.com/a/b" }, format: "x" });
    expect(res.status).toBe(201);
    const rows = await state.db!.select().from(ideas);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "repo", source: "manual", status: "new", title: "a/b" });
  });

  it("refuses a bad link, an empty path, a bad format or count, with no job", async () => {
    const bad = [
      { source: { type: "github", url: "https://gitlab.com/a/b" }, format: "x" },
      { source: { type: "github", url: "https://github.com/a/b/tree/main" }, format: "x" },
      { source: { type: "folder", path: "  " }, format: "x" },
      { source: { type: "folder", path: "/a" }, format: "thread" },
      { source: { type: "folder", path: "/a" }, format: "x", count: 0 },
      { source: { type: "folder", path: "/a" }, format: "x", count: 7 },
      { source: { type: "folder", path: "/a" }, format: "x", count: 2.5 },
      null,
    ];
    for (const body of bad) {
      const res = await post(body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(typeof (await res.json()).error).toBe("string");
    }
    expect(await state.db!.select().from(jobs)).toHaveLength(0);
    expect(await state.db!.select().from(ideas)).toHaveLength(0);
  });

  it("an agent too old for the job: the update message, before anything is saved", async () => {
    await setSetting(state.db as never, "agentKinds", ["video_ideas"]);
    const res = await post({ source: { type: "folder", path: "/a" }, format: "x" });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: UPDATE });
    expect(await state.db!.select().from(jobs)).toHaveLength(0);
    expect(await state.db!.select().from(ideas)).toHaveLength(0);
  });
});

describe("POST /api/repos/pick", () => {
  const pickReq = () => pick();

  it("asks the agent to open the folder picker", async () => {
    const res = await pickReq();
    expect(res.status).toBe(201);
    const [job] = await state.db!.select().from(jobs);
    expect(job).toMatchObject({ kind: "pick_folder", payload: {}, status: "queued" });
    expect(res.headers.get("X-PostEcho-Job")).toBe(job.id);
    expect(await res.json()).toEqual({ jobId: job.id });
  });

  it("an agent too old for it: the update message, no job", async () => {
    await setSetting(state.db as never, "agentKinds", ["repo_posts"]);
    const res = await pickReq();
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: UPDATE });
    expect(await state.db!.select().from(jobs)).toHaveLength(0);
  });
});
