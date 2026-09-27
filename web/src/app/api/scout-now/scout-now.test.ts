import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb } from "@/test/db";
import type { ScoutRunSummary } from "@/lib/scout-run";

const state: { db: Awaited<ReturnType<typeof createTestDb>> | null } = { db: null };
vi.mock("@/db", () => ({ get db() { return state.db; } }));
vi.mock("@/lib/session", async (orig) => ({
  ...(await orig()),
  requireSession: vi.fn(async () => null),
}));
vi.mock("@/lib/scout-run", () => ({ runScoutSearch: vi.fn() }));

const routeModule = await import("@/app/api/scout-now/route");
const { POST } = routeModule;
const { setSetting } = await import("@/lib/settings");
const { runScoutSearch } = await import("@/lib/scout-run");

function summaryFor(query: string): ScoutRunSummary {
  return {
    query, candidates: 1, judged: 1, inserted: 1, skippedDuplicates: 0,
    rounds: 1, minScore: 60, resultsTotal: 20,
    perSource: {
      bluesky: { status: "ok", candidates: 1, judged: 1, strong: 1, inserted: 1, skippedDuplicates: 0 },
      hackernews: { status: "ok", candidates: 0, judged: 0, strong: 0, inserted: 0, skippedDuplicates: 0 },
    },
  };
}

beforeEach(async () => {
  state.db = await createTestDb();
  const { requireSession } = await import("@/lib/session");
  const mock = requireSession as unknown as ReturnType<typeof vi.fn>;
  mock.mockReset();
  mock.mockResolvedValue(null);
  vi.mocked(runScoutSearch).mockReset();
  vi.mocked(runScoutSearch).mockImplementation(async (_db, input) => summaryFor(input.query));
});

describe("POST /api/scout-now", () => {
  it("exports maxDuration = 60", () => {
    expect(routeModule.maxDuration).toBe(60);
  });

  it("runs one scout search per configured topic (query = judgeTopic = topic) and returns their summaries", async () => {
    await setSetting(state.db as never, "topics", ["ai audio", "indie saas"]);
    const res = await POST();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.results).toEqual([summaryFor("ai audio"), summaryFor("indie saas")]);
    expect(runScoutSearch).toHaveBeenNthCalledWith(1, state.db, { query: "ai audio", judgeTopic: "ai audio" });
    expect(runScoutSearch).toHaveBeenNthCalledWith(2, state.db, { query: "indie saas", judgeTopic: "indie saas" });
  });

  it("runs topics sequentially, not concurrently", async () => {
    await setSetting(state.db as never, "topics", ["a", "b"]);
    const log: string[] = [];
    vi.mocked(runScoutSearch).mockImplementation(async (_db, input) => {
      log.push(`start:${input.query}`);
      await new Promise((resolve) => setTimeout(resolve, 5));
      log.push(`end:${input.query}`);
      return summaryFor(input.query);
    });
    await POST();
    expect(log).toEqual(["start:a", "end:a", "start:b", "end:b"]);
  });

  it("returns {results: [], reason: 'no topics configured'} (still 200) when none are set", async () => {
    const res = await POST();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ results: [], reason: "no topics configured" });
    expect(runScoutSearch).not.toHaveBeenCalled();
  });

  it("401s when the session is denied, without running any search", async () => {
    const { requireSession } = await import("@/lib/session");
    (requireSession as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      Response.json({ error: "unauthorized" }, { status: 401 }),
    );
    const res = await POST();
    expect(res.status).toBe(401);
    expect(runScoutSearch).not.toHaveBeenCalled();
  });

  it("500s and logs when a scout run throws", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    await setSetting(state.db as never, "topics", ["ai"]);
    vi.mocked(runScoutSearch).mockRejectedValueOnce(new Error("jev down"));
    const res = await POST();
    expect(res.status).toBe(500);
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});
