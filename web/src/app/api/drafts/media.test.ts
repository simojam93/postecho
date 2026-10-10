import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb } from "@/test/db";

const state: { db: Awaited<ReturnType<typeof createTestDb>> | null } = { db: null };
vi.mock("@/db", () => ({ get db() { return state.db; } }));
vi.mock("@/lib/session", async (orig) => ({
  ...(await orig()),
  requireSession: vi.fn(async () => null),
}));

const { GET, POST } = await import("@/app/api/drafts/[id]/media/route");
const { drafts, ideas, jobs } = await import("@/db/schema");
const { setSetting } = await import("@/lib/settings");

const UPDATE = "Update the agent: git pull, then restart npm run dev.";
const MISSING = "00000000-0000-4000-8000-000000000099";

const params = (id: string) => ({ params: Promise.resolve({ id }) });
const ask = (id: string, body: unknown) => POST(new Request(`http://test/api/drafts/${id}/media`, { method: "POST", body: JSON.stringify(body) }), params(id));
const look = (id: string) => GET(new Request(`http://test/api/drafts/${id}/media`), params(id));

beforeEach(async () => { state.db = await createTestDb(); });
afterEach(() => { vi.clearAllMocks(); });

/** A repo source, one of its posts used in Compose, and the draft. */
async function repoDraft(source: "folder" | "github", draft: Partial<typeof drafts.$inferInsert> = { xText: "Gating runs first." }) {
  const db = state.db!;
  const [repo] = await db.insert(ideas).values(source === "folder"
    ? { kind: "repo", url: "file:///Users/me/dev/app", title: "app", meta: { sourceType: "folder", path: "/Users/me/dev/app" } }
    : { kind: "repo", url: "https://github.com/a/b", title: "a/b", meta: { sourceType: "github" } }).returning();
  const [post] = await db.insert(ideas).values({ kind: "repo_post", content: "Gating runs first.", meta: { repoId: repo.id, format: "x" } }).returning();
  const [row] = await db.insert(drafts).values({ ideaId: post.id, status: "kept", ...draft }).returning();
  return { repo, post, draft: row };
}

describe("POST /api/drafts/:id/media (media from a repo, 2026-10-11)", () => {
  it("asks the agent for a card for a post from a repo, with the job header", async () => {
    const { repo, draft } = await repoDraft("github");
    const res = await ask(draft.id, { kind: "card" });
    expect(res.status).toBe(201);
    const [job] = await state.db!.select().from(jobs);
    expect(res.headers.get("X-PostEcho-Job")).toBe(job.id);
    expect(await res.json()).toEqual({ jobId: job.id });
    expect(job.kind).toBe("post_media");
    expect(job.payload).toEqual({
      draftId: draft.id, repoId: repo.id, source: { type: "github", url: "https://github.com/a/b" },
      kind: "card", postText: "Gating runs first.", format: "x",
    });
  });

  it("screenshots and a video for a folder on this computer, never for a GitHub repository", async () => {
    const folder = await repoDraft("folder", { xText: "X text", linkedinText: "LinkedIn text" });
    const res = await ask(folder.draft.id, { kind: "screenshots" });
    expect(res.status).toBe(201);
    const [job] = await state.db!.select().from(jobs);
    expect(job.payload).toMatchObject({
      source: { type: "folder", path: "/Users/me/dev/app" }, kind: "screenshots", postText: "X text\n\nLinkedIn text", format: "linkedin",
    });

    const github = await repoDraft("github");
    for (const kind of ["screenshots", "video"]) {
      const refused = await ask(github.draft.id, { kind });
      expect(refused.status).toBe(400);
      expect((await refused.json()).error).toBe("Screenshots and videos are made only from a folder on this computer.");
    }
    expect(await state.db!.select().from(jobs)).toHaveLength(1);
  });

  it("an article sends its title and body", async () => {
    const { draft } = await repoDraft("github", { articleTitle: "What we learned", articleText: "Body." });
    await ask(draft.id, { kind: "images" });
    const [job] = await state.db!.select().from(jobs);
    expect(job.payload).toMatchObject({ postText: "What we learned\n\nBody.", format: "article" });
  });

  it("refuses a post that isn't from a repo, an unknown draft and an unknown kind", async () => {
    const [idea] = await state.db!.insert(ideas).values({ kind: "note", content: "a" }).returning();
    const [other] = await state.db!.insert(drafts).values({ ideaId: idea.id, xText: "hi" }).returning();
    const res = await ask(other.id, { kind: "card" });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("Media are made for posts from a repo.");
    expect((await ask(MISSING, { kind: "card" })).status).toBe(404);
    expect((await ask("nope", { kind: "card" })).status).toBe(404);
    const { draft } = await repoDraft("folder");
    expect((await ask(draft.id, { kind: "gif" })).status).toBe(400);
    expect(await state.db!.select().from(jobs)).toHaveLength(0);
  });

  it("409 when the agent doesn't make media yet, or already makes some for this post", async () => {
    const { draft } = await repoDraft("folder");
    await setSetting(state.db as never, "agentKinds", ["repo_posts"]);
    const old = await ask(draft.id, { kind: "card" });
    expect(old.status).toBe(409);
    expect((await old.json()).error).toBe(UPDATE);

    await setSetting(state.db as never, "agentKinds", ["repo_posts", "post_media"]);
    expect((await ask(draft.id, { kind: "card" })).status).toBe(201);
    const busy = await ask(draft.id, { kind: "images" });
    expect(busy.status).toBe(409);
    expect((await busy.json()).error).toBe("PostEcho is already making media for this post.");
  });
});

describe("GET /api/drafts/:id/media", () => {
  it("says which kinds the source allows, the media and the latest media job", async () => {
    const { draft } = await repoDraft("github");
    await state.db!.update(drafts).set({ meta: { media: [{ file: "card-a.png", kind: "card", kept: true, jobId: "j" }] } }).where(eq(drafts.id, draft.id));
    const [job] = await state.db!.insert(jobs).values({ kind: "post_media", payload: { draftId: draft.id, kind: "images" }, status: "claimed" }).returning();
    const res = await look(draft.id);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.kinds).toEqual(["images", "card"]);
    expect(body.media).toEqual([{ file: "card-a.png", kind: "card", kept: true, jobId: "j" }]);
    expect(body.job).toMatchObject({ id: job.id, status: "claimed", payload: { kind: "images" } });

    const folder = await repoDraft("folder");
    expect((await (await look(folder.draft.id)).json()).kinds).toEqual(["images", "card", "screenshots", "video"]);
  });

  it("no kinds for a post that isn't from a repo; 404 for an unknown draft", async () => {
    const [other] = await state.db!.insert(drafts).values({ xText: "hi" }).returning();
    expect(await (await look(other.id)).json()).toEqual({ kinds: [], media: [], job: null });
    expect((await look(MISSING)).status).toBe(404);
  });
});
