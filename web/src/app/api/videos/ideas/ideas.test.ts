import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createTestDb } from "@/test/db";

const state: { db: Awaited<ReturnType<typeof createTestDb>> | null } = { db: null };
vi.mock("@/db", () => ({ get db() { return state.db; } }));
vi.mock("@/lib/session", async (orig) => ({
  ...(await orig()),
  requireSession: vi.fn(async () => null),
}));
const enrich = vi.fn(async () => ({ kind: "youtube", title: "Intervista a Alberto Dalmasso", content: null, author: "Mr. RIP", meta: { thumbnailUrl: "u" } }));
vi.mock("@/lib/enrich", () => ({ enrich: (...args: unknown[]) => enrich(...(args as [])), classifyUrl: () => "youtube" }));
const videoDescriptionFor = vi.fn(async () => null as string | null);
vi.mock("@/lib/sources/youtube", () => ({ videoDescriptionFor: (...args: unknown[]) => videoDescriptionFor(...(args as [])) }));

const { POST, VIDEO_IDEAS_COUNT } = await import("@/app/api/videos/ideas/route");
const { jobs, ideas } = await import("@/db/schema");
const { eq } = await import("drizzle-orm");

const post = (body: unknown) => POST(new Request("http://test/api/videos/ideas", { method: "POST", body: JSON.stringify(body) }));

beforeEach(async () => { state.db = await createTestDb(); });
afterEach(() => { vi.clearAllMocks(); });

it("saves the video and asks the Mac for a dozen post ideas from its transcript — no search (2026-09-27)", async () => {
  const res = await post({ url: "https://www.youtube.com/watch?v=abc" });
  expect(res.status).toBe(201);
  const [video] = await state.db!.select().from(ideas);
  expect(video).toMatchObject({ kind: "youtube", source: "manual", status: "new", title: "Intervista a Alberto Dalmasso" });
  const [job] = await state.db!.select().from(jobs);
  expect(VIDEO_IDEAS_COUNT).toBe(12);
  expect(res.headers.get("X-PostEcho-Job")).toBe(job.id);
  expect(job).toMatchObject({ kind: "video_ideas", payload: { ideaId: video.id, url: "https://www.youtube.com/watch?v=abc", count: 12 } });
});

it("the same video pasted again is back on the Videos tab, with a new job; a pasted transcript goes along", async () => {
  await post({ url: "https://youtu.be/dup" });
  const [video] = await state.db!.select().from(ideas);
  await state.db!.update(ideas).set({ status: "dismissed", source: "scout" }).where(eq(ideas.id, video.id));
  await post({ url: "https://youtu.be/dup", transcript: "the whole talk" });
  const rows = await state.db!.select().from(ideas);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ status: "new", source: "manual" });
  const all = await state.db!.select().from(jobs);
  expect(all).toHaveLength(2);
  expect(all.find((j) => (j.payload as { transcript?: string }).transcript === "the whole talk")).toBeTruthy();
});

it("sends the video's description along, for when YouTube has no transcript at all", async () => {
  videoDescriptionFor.mockResolvedValueOnce("Alberto Dalmasso on how Satispay grew.\n00:00 Intro\n05:12 The first merchants");
  await post({ url: "https://youtu.be/desc" });
  const [job] = await state.db!.select().from(jobs);
  expect((job.payload as { description?: string }).description).toContain("00:00 Intro");
});

it("says to paste a YouTube link otherwise", async () => {
  enrich.mockResolvedValueOnce({ kind: "article", title: "A page", content: null, author: null, meta: {} } as never);
  expect((await post({ url: "https://example.com/a" })).status).toBe(400);
  expect((await post({ url: "not a url" })).status).toBe(400);
  expect(await state.db!.select().from(jobs)).toHaveLength(0);
});
