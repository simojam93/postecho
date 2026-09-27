import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb } from "@/test/db";
import { ideas } from "@/db/schema";
import { deriveQuery } from "@/lib/query";
import type { ScoutRunSummary } from "@/lib/scout-run";

const state: { db: Awaited<ReturnType<typeof createTestDb>> | null } = { db: null };
vi.mock("@/db", () => ({ get db() { return state.db; } }));
vi.mock("@/lib/session", async (orig) => ({
  ...(await orig()),
  requireSession: vi.fn(async () => null),
}));

const fakeXPost = { kind: "x_post" as const, title: "t", content: "a post about voice cloning growth", author: "a", meta: {} };
vi.mock("@/lib/enrich", async (orig) => ({
  ...(await orig()),
  enrich: vi.fn(async () => fakeXPost),
}));

const fakeScoutSummary: ScoutRunSummary = {
  query: "q", candidates: 3, judged: 3, inserted: 2, skippedDuplicates: 1,
  rounds: 1, minScore: 60, resultsTotal: 20,
  perSource: {
    bluesky: { status: "ok", candidates: 2, judged: 2, strong: 2, inserted: 1, skippedDuplicates: 1 },
    hackernews: { status: "ok", candidates: 1, judged: 1, strong: 1, inserted: 1, skippedDuplicates: 0 },
  },
};
vi.mock("@/lib/scout-run", () => ({ runScoutSearch: vi.fn(async () => fakeScoutSummary) }));

const routeModule = await import("@/app/api/search/route");
const { POST } = routeModule;
const { runScoutSearch } = await import("@/lib/scout-run");

beforeEach(async () => {
  state.db = await createTestDb();
  const { requireSession } = await import("@/lib/session");
  const mock = requireSession as unknown as ReturnType<typeof vi.fn>;
  mock.mockReset();
  mock.mockResolvedValue(null);
  const { enrich } = await import("@/lib/enrich");
  (enrich as unknown as ReturnType<typeof vi.fn>).mockReset();
  (enrich as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(fakeXPost);
  vi.mocked(runScoutSearch).mockReset();
  vi.mocked(runScoutSearch).mockResolvedValue(fakeScoutSummary);
});

function req(body: unknown) {
  return new Request("http://test/api/search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/search", () => {
  it("asked for its steps, streams them as it goes, then the answer it would otherwise give (2026-09-27)", async () => {
    vi.mocked(runScoutSearch).mockImplementation(async (_db, _input, deps) => {
      deps?.onStep?.({ step: "searching", round: 1, sources: 2 });
      deps?.onStep?.({ step: "ranking", round: 1, posts: 3 });
      return fakeScoutSummary;
    });
    const res = await POST(new Request("http://test/api/search", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/x-ndjson" },
      body: JSON.stringify({ input: "https://x.com/a/status/1" }),
    }));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/x-ndjson");
    const lines = (await res.text()).trim().split("\n").map((line) => JSON.parse(line));
    expect(lines.slice(0, 3)).toEqual([
      { step: { step: "reading" } },
      { step: { step: "searching", round: 1, sources: 2 } },
      { step: { step: "ranking", round: 1, posts: 3 } },
    ]);
    expect(lines[3].done.status).toBe(201);
    expect(lines[3].done.body.scout).toEqual(fakeScoutSummary);
  });

  it("a refusal comes as the streamed answer too, with its status", async () => {
    const res = await POST(new Request("http://test/api/search", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/x-ndjson" },
      body: JSON.stringify({ input: "not a link", mode: "videos" }),
    }));
    const lines = (await res.text()).trim().split("\n").map((line) => JSON.parse(line));
    expect(lines).toEqual([{ done: { status: 400, body: { error: "paste a YouTube link" } } }]);
  });

  it("exports maxDuration = 60", () => {
    expect(routeModule.maxDuration).toBe(60);
  });

  it("text seed: saves a note, derives a query, and runs the scout inline", async () => {
    const text = "brainstorming posts about ai voice cloning growth strategy launch";
    const res = await POST(req({ input: text }));
    expect(res.status).toBe(201);
    const body = await res.json();

    expect(body.idea.kind).toBe("note");
    expect(body.existing).toBe(false);
    expect(body.query).toBe(deriveQuery(text));
    expect(body.scout).toEqual(fakeScoutSummary);

    expect(runScoutSearch).toHaveBeenCalledTimes(1);
    const [dbArg, input] = vi.mocked(runScoutSearch).mock.calls[0];
    expect(dbArg).toBe(state.db);
    expect(input).toEqual({ query: deriveQuery(text), judgeTopic: text, seedIdeaId: body.idea.id });
    // The seed remembers the words it was searched with (the chips' tooltip pairs them).
    const [seed] = await state.db!.select().from(ideas);
    expect(seed.meta).toMatchObject({ searchQuery: deriveQuery(text) });
  });

  it("x url seed: saves an x_post idea and runs the scout with judgeTopic = the enriched content", async () => {
    const res = await POST(req({ input: "https://x.com/a/status/1" }));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.idea.kind).toBe("x_post");
    expect(body.query).toBe(deriveQuery(fakeXPost.content));

    const [, input] = vi.mocked(runScoutSearch).mock.calls[0];
    expect(input).toMatchObject({ query: deriveQuery(fakeXPost.content), judgeTopic: fakeXPost.content });
  });

  it("videos mode with an article url: 400 'paste a YouTube link', scout never runs", async () => {
    const { enrich } = await import("@/lib/enrich");
    (enrich as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      kind: "article", title: "An article", content: "body", author: null, meta: {},
    });
    const res = await POST(req({ input: "https://example.com/post", mode: "videos" }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("paste a YouTube link");
    expect(runScoutSearch).not.toHaveBeenCalled();
  });

  it("videos mode with a matching youtube url: 201, scout still runs inline", async () => {
    const { enrich } = await import("@/lib/enrich");
    (enrich as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      kind: "youtube", title: "A talk about growth", content: null, author: "Some Channel", meta: {},
    });
    const res = await POST(req({ input: "https://youtu.be/abc", mode: "videos" }));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.idea.kind).toBe("youtube");
    expect(body.scout).toEqual(fakeScoutSummary);
    expect(runScoutSearch).toHaveBeenCalledTimes(1);
  });

  it("url seed with nothing enrichable falls back to the url's path slug for the query", async () => {
    const { enrich } = await import("@/lib/enrich");
    (enrich as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      kind: "article", title: null, content: null, author: null, meta: {},
    });
    const res = await POST(req({ input: "https://example.com/blog/the-future-of-remote-work" }));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.query).toBe("future remote work");
  });

  it("url seed with no metadata and a meaningless slug: 422, nothing saved, scout never runs", async () => {
    const { enrich } = await import("@/lib/enrich");
    (enrich as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      kind: "article", title: null, content: null, author: null, meta: {},
    });
    const res = await POST(req({ input: "https://www.paulgraham.com/ds.html" }));
    expect(res.status).toBe(422);
    expect((await res.json()).error).toMatch(/Paste the text/);
    expect(runScoutSearch).not.toHaveBeenCalled();
    expect(await state.db!.select().from(ideas)).toHaveLength(0);
  });

  it("the same seed twice: still 201 both times, existing:true the second time, scout runs again", async () => {
    const first = await POST(req({ input: "https://x.com/a/status/dup" }));
    expect(first.status).toBe(201);
    expect((await first.json()).existing).toBe(false);

    const second = await POST(req({ input: "https://x.com/a/status/dup" }));
    expect(second.status).toBe(201);
    expect((await second.json()).existing).toBe(true);

    expect(runScoutSearch).toHaveBeenCalledTimes(2);
  });

  // Note dedupe (M1.5 search-results UX round) — same existing:true contract
  // as the url case above, this time for a free-text seed (lib/ideas.ts's
  // saveIdeaFromInput note-dedupe branch, exercised end-to-end through the route).
  it("the same free-text seed twice (different case/whitespace): existing:true the second time, scout still runs", async () => {
    const first = await POST(req({ input: "brainstorming posts about ai voice cloning growth strategy launch" }));
    expect(first.status).toBe(201);
    const firstBody = await first.json();
    expect(firstBody.existing).toBe(false);

    const second = await POST(req({ input: "  Brainstorming posts about AI voice cloning growth strategy launch  " }));
    expect(second.status).toBe(201);
    const secondBody = await second.json();
    expect(secondBody.existing).toBe(true);
    expect(secondBody.idea.id).toBe(firstBody.idea.id);

    expect(runScoutSearch).toHaveBeenCalledTimes(2);
  });

  it("rejects an empty input without running the scout", async () => {
    const res = await POST(req({ input: "" }));
    expect(res.status).toBe(400);
    expect(runScoutSearch).not.toHaveBeenCalled();
  });

  it("rejects an input over 2000 chars", async () => {
    const res = await POST(req({ input: "x".repeat(2001) }));
    expect(res.status).toBe(400);
  });

  it("rejects an invalid mode", async () => {
    const res = await POST(req({ input: "an idea", mode: "not-a-mode" }));
    expect(res.status).toBe(400);
  });

  it("401s when the session is denied, without running the scout", async () => {
    const { requireSession } = await import("@/lib/session");
    (requireSession as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      Response.json({ error: "unauthorized" }, { status: 401 }),
    );
    const res = await POST(req({ input: "an idea" }));
    expect(res.status).toBe(401);
    expect(runScoutSearch).not.toHaveBeenCalled();
  });

  it("500s and logs when runScoutSearch throws", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(runScoutSearch).mockRejectedValueOnce(new Error("jev down"));
    const res = await POST(req({ input: "an idea" }));
    expect(res.status).toBe(500);
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});
