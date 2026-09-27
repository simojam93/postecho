import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb } from "@/test/db";
import type { ScoutRunSummary } from "@/lib/scout-run";

const state: { db: Awaited<ReturnType<typeof createTestDb>> | null } = { db: null };
vi.mock("@/db", () => ({ get db() { return state.db; } }));
vi.mock("@/lib/scout-run", () => ({ runScoutSearch: vi.fn() }));

const routeModule = await import("@/app/api/cron/scout/route");
const { GET } = routeModule;
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
  // Re-stubbed before every test (rather than once at module scope) so a
  // test that overrides it to simulate "unset" can't leak into the next one.
  vi.stubEnv("CRON_SECRET", "s3cret");
  vi.mocked(runScoutSearch).mockReset();
  vi.mocked(runScoutSearch).mockImplementation(async (_db, input) => summaryFor(input.query));
});

function req(bearer?: string) {
  return new Request("http://test/api/cron/scout", {
    headers: bearer !== undefined ? { Authorization: `Bearer ${bearer}` } : {},
  });
}

describe("GET /api/cron/scout", () => {
  it("exports maxDuration = 60", () => {
    expect(routeModule.maxDuration).toBe(60);
  });

  it("runs one scout search per configured topic when the bearer matches", async () => {
    await setSetting(state.db as never, "topics", ["ai", "indie saas"]);
    const res = await GET(req("s3cret"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.results).toEqual([summaryFor("ai"), summaryFor("indie saas")]);
    expect(runScoutSearch).toHaveBeenNthCalledWith(1, state.db, { query: "ai", judgeTopic: "ai" });
    expect(runScoutSearch).toHaveBeenNthCalledWith(2, state.db, { query: "indie saas", judgeTopic: "indie saas" });
  });

  it("returns 200 {results: [], reason} when authorized but no topics are configured", async () => {
    const res = await GET(req("s3cret"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ results: [], reason: "no topics configured" });
    expect(runScoutSearch).not.toHaveBeenCalled();
  });

  it("401s on a wrong bearer, without running any search", async () => {
    await setSetting(state.db as never, "topics", ["ai"]);
    const res = await GET(req("nope"));
    expect(res.status).toBe(401);
    expect(runScoutSearch).not.toHaveBeenCalled();
  });

  it("401s when the bearer header is missing", async () => {
    await setSetting(state.db as never, "topics", ["ai"]);
    const res = await GET(req());
    expect(res.status).toBe(401);
  });

  it("fails closed (401) when CRON_SECRET is unset, even with a bearer value", async () => {
    vi.stubEnv("CRON_SECRET", "");
    await setSetting(state.db as never, "topics", ["ai"]);
    const res = await GET(req("s3cret"));
    expect(res.status).toBe(401);
  });
});
