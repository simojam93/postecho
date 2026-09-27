import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createTestDb } from "@/test/db";

const state: { db: Awaited<ReturnType<typeof createTestDb>> | null } = { db: null };
vi.mock("@/db", () => ({ get db() { return state.db; } }));
vi.mock("@/lib/session", async (orig) => ({
  ...(await orig()),
  requireSession: vi.fn(async () => null),
}));
vi.mock("@/lib/enrich", () => ({
  enrich: vi.fn(async () => ({ kind: "youtube", title: "Video T", content: null, author: "Chan", meta: { thumbnailUrl: "u" } })),
  classifyUrl: () => "youtube",
}));

const { POST } = await import("@/app/api/videos/route");
const { jobs, ideas } = await import("@/db/schema");

beforeEach(async () => { state.db = await createTestDb(); });
afterEach(() => { vi.restoreAllMocks(); });

it("creates a youtube idea and enqueues generate_from_video", async () => {
  const res = await POST(new Request("http://test/api/videos", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url: "https://youtu.be/abc", instructions: "lessons", count: 5, originalLanguage: false }),
  }));
  expect(res.status).toBe(201);
  const ideaRows = await state.db!.select().from(ideas);
  const jobRows = await state.db!.select().from(jobs);
  expect(ideaRows).toHaveLength(1);
  expect(jobRows).toHaveLength(1);
  expect(jobRows[0].kind).toBe("generate_from_video");
  expect(jobRows[0].payload).toMatchObject({ url: "https://youtu.be/abc", count: 5, ideaId: ideaRows[0].id });
});

it("dedupes the idea row on resubmission but still enqueues a new job", async () => {
  const body = JSON.stringify({ url: "https://youtu.be/dup", instructions: "lessons", count: 5, originalLanguage: false });
  const req = () => new Request("http://test/api/videos", {
    method: "POST", headers: { "Content-Type": "application/json" }, body,
  });

  const first = await POST(req());
  expect(first.status).toBe(201);
  const firstBody = await first.json();
  expect(firstBody.existingIdea).toBeUndefined();

  const second = await POST(req());
  expect(second.status).toBe(201);
  const secondBody = await second.json();
  expect(secondBody.existingIdea).toBe(true);
  expect(secondBody.idea.id).toBe(firstBody.idea.id);
  expect(secondBody.job.id).not.toBe(firstBody.job.id);

  const ideaRows = await state.db!.select().from(ideas);
  const jobRows = await state.db!.select().from(jobs);
  expect(ideaRows).toHaveLength(1);
  expect(jobRows).toHaveLength(2);
  expect(jobRows.every((j) => (j.payload as { ideaId?: string }).ideaId === firstBody.idea.id)).toBe(true);
});

it("leaves two different urls unaffected", async () => {
  const reqFor = (url: string) => new Request("http://test/api/videos", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url, instructions: "", count: 5, originalLanguage: false }),
  });

  const a = await POST(reqFor("https://youtu.be/aaa"));
  const b = await POST(reqFor("https://youtu.be/bbb"));
  expect(a.status).toBe(201);
  expect(b.status).toBe(201);
  const aBody = await a.json();
  const bBody = await b.json();
  expect(aBody.existingIdea).toBeUndefined();
  expect(bBody.existingIdea).toBeUndefined();
  expect(aBody.idea.id).not.toBe(bBody.idea.id);

  const ideaRows = await state.db!.select().from(ideas);
  const jobRows = await state.db!.select().from(jobs);
  expect(ideaRows).toHaveLength(2);
  expect(jobRows).toHaveLength(2);
});

it("passes an optional transcript through to the job payload (task A9 manual fallback)", async () => {
  const res = await POST(new Request("http://test/api/videos", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url: "https://youtu.be/transcript-fallback", transcript: "pasted transcript text" }),
  }));
  expect(res.status).toBe(201);
  const jobRows = await state.db!.select().from(jobs);
  expect(jobRows[0].payload).toMatchObject({ transcript: "pasted transcript text" });
});

it("rejects a transcript over 200k chars", async () => {
  const res = await POST(new Request("http://test/api/videos", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url: "https://youtu.be/too-long", transcript: "a".repeat(200_001) }),
  }));
  expect(res.status).toBe(400);
});

it("rejects a non-youtube url", async () => {
  const { enrich } = await import("@/lib/enrich");
  (enrich as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ kind: "article", title: null, content: null, author: null, meta: {} });
  const res = await POST(new Request("http://test/api/videos", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url: "https://example.com", instructions: "", count: 5, originalLanguage: false }),
  }));
  expect(res.status).toBe(400);
});

it("returns 500 and cleans up the idea when the job insert fails (review regression)", async () => {
  // Force the SECOND db.insert call (the jobs insert) to throw, while letting
  // the first (the ideas insert) go through normally, to exercise the
  // best-effort cleanup path added per review. neon-http has no .transaction(),
  // so this two-step write can't roll back on its own — the route must clean
  // up the orphaned idea itself.
  const realInsert = state.db!.insert.bind(state.db);
  let calls = 0;
  vi.spyOn(state.db!, "insert").mockImplementation((...args: Parameters<typeof realInsert>) => {
    calls += 1;
    if (calls === 2) throw new Error("boom");
    return realInsert(...args);
  });

  const res = await POST(new Request("http://test/api/videos", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url: "https://youtu.be/abc", instructions: "lessons", count: 5, originalLanguage: false }),
  }));

  expect(res.status).toBe(500);
  expect((await res.json()).error).toBe("failed to enqueue job");

  vi.restoreAllMocks();
  const ideaRows = await state.db!.select().from(ideas);
  const jobRows = await state.db!.select().from(jobs);
  expect(ideaRows).toHaveLength(0);
  expect(jobRows).toHaveLength(0);
});
