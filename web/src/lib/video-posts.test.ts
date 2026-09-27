import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import type { JevClient, PostJudgment } from "jev-judge";
import { createTestDb } from "@/test/db";
import { ideas } from "@/db/schema";
import { setSlopDeps } from "@/lib/slop";

vi.mock("jev-judge", async (orig) => ({ ...(await orig<typeof import("jev-judge")>()), judgePosts: vi.fn() }));
const { judgePosts } = await import("jev-judge");
const { rankVideoPosts } = await import("@/lib/video-posts");

const judgment = (id: string, rank: number): PostJudgment => ({
  id, relevance: 80, relevanceConfidence: 0.8, quality: rank, qualityConfidence: 0.8, tasteFit: 0.7, rank, isSpam: false, spamScore: 0, kind: "opinion", kindFit: 0.9,
});

let db: Awaited<ReturnType<typeof createTestDb>>;
beforeEach(async () => {
  db = await createTestDb();
  vi.stubEnv("TYPESAFE_API_KEY", "");
  vi.mocked(judgePosts).mockReset();
});
afterEach(() => { setSlopDeps({}); vi.unstubAllEnvs(); });

async function topics() {
  const rows = await db.insert(ideas).values(["Writing beats short video", "Repetition beats novelty"].map((title, order) => ({
    kind: "video_idea" as const, title, content: `${title}, in a sentence.`, meta: { videoId: "v", order },
  }))).returning();
  return rows.map((row) => row.id);
}

describe("rankVideoPosts (2026-09-27: \"in un secondo… capisci quali sono migliori\")", () => {
  it("scores each topic like a Trends result, against the video and the owner's kinds", async () => {
    setSlopDeps({ jev: {} as JevClient });
    const [a, b] = await topics();
    vi.mocked(judgePosts).mockResolvedValue([judgment(a!, 44), judgment(b!, 91)]);
    await rankVideoPosts(db as never, [a!, b!], "The talk");

    const call = vi.mocked(judgePosts).mock.calls[0]![1];
    expect(call.topic).toBe("The talk");
    expect(call.posts).toEqual([
      { id: a, text: "Writing beats short video. Writing beats short video, in a sentence." },
      { id: b, text: "Repetition beats novelty. Repetition beats novelty, in a sentence." },
    ]);
    expect(call.kinds?.length).toBeGreaterThan(0);
    const [second] = await db.select().from(ideas).where(eq(ideas.id, b!));
    expect(second.meta).toMatchObject({ order: 1, rank: 91, tasteFit: 0.7, postKind: "opinion" });
  });

  it("without Jev, or when it fails, the topics keep Claude's order", async () => {
    const [a] = await topics();
    await rankVideoPosts(db as never, [a!], "The talk");
    expect(judgePosts).not.toHaveBeenCalled();

    setSlopDeps({ jev: {} as JevClient });
    vi.mocked(judgePosts).mockRejectedValue(new Error("jev down"));
    await expect(rankVideoPosts(db as never, [a!], "The talk")).resolves.toBeUndefined();
    const [row] = await db.select().from(ideas).where(eq(ideas.id, a!));
    expect(row.meta).not.toHaveProperty("rank");
  });
});
