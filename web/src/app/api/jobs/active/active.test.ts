import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb } from "@/test/db";
import { drafts, ideas, jobs } from "@/db/schema";

const state: { db: Awaited<ReturnType<typeof createTestDb>> | null } = { db: null };
vi.mock("@/db", () => ({ get db() { return state.db; } }));
vi.mock("@/lib/session", async (orig) => ({ ...(await orig()), requireSession: vi.fn(async () => null) }));

const { GET, RECENT_END_MS } = await import("@/app/api/jobs/active/route");

beforeEach(async () => { state.db = await createTestDb(); });

describe("GET /api/jobs/active (2026-09-27: the sidebar's \"charging… tick verde\")", () => {
  it("lists the jobs queued or running and those that just ended, with no payload or result", async () => {
    const now = Date.now();
    await state.db!.insert(jobs).values([
      { kind: "video_ideas", status: "queued", payload: { url: "https://youtu.be/q" } },
      { kind: "revise_draft", status: "claimed", payload: {} },
      { kind: "generate_from_idea", status: "done", payload: {}, finishedAt: new Date(now - 60_000), result: { drafts: [] } },
      { kind: "generate_from_video", status: "failed", payload: {}, finishedAt: new Date(now - 30_000) },
      { kind: "revise_draft", status: "done", payload: {}, finishedAt: new Date(now - RECENT_END_MS - 60_000) },
    ]);
    const body = await (await GET()).json();
    expect(body.jobs.map((j: { kind: string; status: string }) => `${j.kind}:${j.status}`).sort()).toEqual([
      "generate_from_idea:done", "generate_from_video:failed", "revise_draft:claimed", "video_ideas:queued",
    ]);
    expect(Object.keys(body.jobs[0]).sort()).toEqual(["id", "kind", "status"]);
  });

  it("names the post a screenshots or video job is for, for the notice that they're ready (2026-10-11)", async () => {
    const [idea] = await state.db!.insert(ideas).values({ kind: "repo", title: "idea" } as never).returning();
    const [draft] = await state.db!.insert(drafts).values({ ideaId: idea!.id, xText: "PostEcho now writes posts straight from your code, and checks they sound human." } as never).returning();
    await state.db!.insert(jobs).values([
      { kind: "post_media", status: "claimed", payload: { draftId: draft!.id, kind: "video" } },
      { kind: "post_media", status: "claimed", payload: { draftId: draft!.id, kind: "card" } },
    ]);
    const body = await (await GET()).json();
    const video = body.jobs.find((j: { media?: unknown }) => j.media);
    expect(video.media).toEqual({ kind: "video", ideaId: idea!.id, title: "PostEcho now writes posts straight from your co…" });
    expect(body.jobs.filter((j: { media?: unknown }) => j.media)).toHaveLength(1);
  });
});
