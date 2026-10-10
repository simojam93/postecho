import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb } from "@/test/db";
import { drafts, ideas, scheduledPosts } from "@/db/schema";

const state: { db: Awaited<ReturnType<typeof createTestDb>> | null } = { db: null };
vi.mock("@/db", () => ({ get db() { return state.db; } }));
vi.mock("@/lib/session", async (orig) => ({
  ...(await orig()),
  requireSession: vi.fn(async () => null),
}));

const { GET, PUT } = await import("@/app/api/settings/route");
const { POST: postAnalyzeStyle } = await import("@/app/api/settings/analyze-style/route");

function put(body: unknown) {
  return PUT(new Request("http://test", {
    method: "PUT", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }));
}

beforeEach(async () => {
  state.db = await createTestDb();
  // A mockResolvedValueOnce queued by one test must not leak into the next
  // test's call (same reset pattern as ideas.test.ts).
  const { requireSession } = await import("@/lib/session");
  const mock = requireSession as unknown as ReturnType<typeof vi.fn>;
  mock.mockReset();
  mock.mockResolvedValue(null);
});

describe("GET /api/settings", () => {
  it("returns defaults merged with stored values", async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.settings.leadTimeMinutes).toBe(5);
    expect(body.settings.topics).toEqual([]);
    expect(body.settings.identityName).toBe("");
    expect(body.settings.agentLastHeartbeatAt).toBeNull();
  });

  it("includes computed tasteCounts, defaulting to 0/0 with no ideas", async () => {
    const body = await (await GET()).json();
    expect(body.tasteCounts).toEqual({ kept: 0, skipped: 0, rated: 0 });
  });

  it("computes tasteCounts from used (kept) and dismissed (skipped) ideas, not a stored value", async () => {
    await state.db!.insert(ideas).values([
      { kind: "note", content: "kept one", status: "used" },
      { kind: "note", content: "kept two", status: "used" },
      { kind: "note", content: "skipped one", status: "dismissed" },
      { kind: "note", content: "still new", status: "new" },
    ]);
    const body = await (await GET()).json();
    expect(body.tasteCounts).toEqual({ kept: 2, skipped: 1, rated: 0 });
  });
});

describe("PUT /api/settings", () => {
  it("stores allowed keys", async () => {
    const ok = await PUT(new Request("http://test", {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ topics: ["ai"], leadTimeMinutes: 10, identityHandle: "@lovera_simone" }),
    }));
    expect(ok.status).toBe(200);
    const body = await (await GET()).json();
    expect(body.settings.topics).toEqual(["ai"]);
    expect(body.settings.leadTimeMinutes).toBe(10);
    expect(body.settings.identityHandle).toBe("@lovera_simone");
  });

  it("rejects unknown keys", async () => {
    const bad = await PUT(new Request("http://test", {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ nope: 1 }),
    }));
    expect(bad.status).toBe(400);
  });

  it("rejects agentLastHeartbeatAt (server-managed)", async () => {
    const bad = await PUT(new Request("http://test", {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agentLastHeartbeatAt: "2026-01-01T00:00:00Z" }),
    }));
    expect(bad.status).toBe(400);
  });

  it("validates value shapes (bad email, out-of-range lead time)", async () => {
    for (const payload of [{ notificationEmail: "not-an-email" }, { leadTimeMinutes: 0 }, { leadTimeMinutes: 999 }]) {
      const res = await PUT(new Request("http://test", {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      }));
      expect(res.status).toBe(400);
    }
  });

  describe("scoutMinScore", () => {
    it("defaults to 60 and stores an in-range update", async () => {
      const before = await (await GET()).json();
      expect(before.settings.scoutMinScore).toBe(60);

      const res = await put({ scoutMinScore: 80 });
      expect(res.status).toBe(200);
      const after = await (await GET()).json();
      expect(after.settings.scoutMinScore).toBe(80);
    });

    it("rejects an out-of-range value", async () => {
      for (const bad of [-1, 101, 50.5]) {
        const res = await put({ scoutMinScore: bad });
        expect(res.status).toBe(400);
      }
    });
  });

  describe("scoutResultsPerSource", () => {
    it("defaults to 5 and stores an in-range update", async () => {
      const before = await (await GET()).json();
      expect(before.settings.scoutResultsPerSource).toBe(5);

      const res = await put({ scoutResultsPerSource: 3 });
      expect(res.status).toBe(200);
      const after = await (await GET()).json();
      expect(after.settings.scoutResultsPerSource).toBe(3);
    });

    it("rejects an out-of-range value", async () => {
      for (const bad of [0, 11, 5.5]) {
        const res = await put({ scoutResultsPerSource: bad });
        expect(res.status).toBe(400);
      }
    });
  });

  describe("scoutResultsTotal", () => {
    it("defaults to 20 and stores an in-range update", async () => {
      const before = await (await GET()).json();
      expect(before.settings.scoutResultsTotal).toBe(20);

      const res = await put({ scoutResultsTotal: 30 });
      expect(res.status).toBe(200);
      const after = await (await GET()).json();
      expect(after.settings.scoutResultsTotal).toBe(30);
    });

    it("rejects an out-of-range value", async () => {
      for (const bad of [4, 51, 10.5]) {
        const res = await put({ scoutResultsTotal: bad });
        expect(res.status).toBe(400);
      }
    });
  });

  describe("scoutCandidatesPerSource", () => {
    it("defaults to 12 and stores an in-range update", async () => {
      const before = await (await GET()).json();
      expect(before.settings.scoutCandidatesPerSource).toBe(12);

      const res = await put({ scoutCandidatesPerSource: 20 });
      expect(res.status).toBe(200);
      const after = await (await GET()).json();
      expect(after.settings.scoutCandidatesPerSource).toBe(20);
    });

    it("rejects an out-of-range value", async () => {
      for (const bad of [4, 51, 10.5]) {
        const res = await put({ scoutCandidatesPerSource: bad });
        expect(res.status).toBe(400);
      }
    });
  });

  it("accepts empty-string email (clears it)", async () => {
    const res = await PUT(new Request("http://test", {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ notificationEmail: "" }),
    }));
    expect(res.status).toBe(200);
  });

  it("returns field-level error details on validation failure", async () => {
    const res = await put({ leadTimeMinutes: 0 });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(Array.isArray(body.fields.leadTimeMinutes)).toBe(true);
    expect(typeof body.fields.leadTimeMinutes[0]).toBe("string");
  });

  it("does not clobber other keys on a partial update", async () => {
    await put({ topics: ["a"] });
    await put({ leadTimeMinutes: 7 });
    const body = await (await GET()).json();
    expect(body.settings.topics).toEqual(["a"]);
    expect(body.settings.leadTimeMinutes).toBe(7);
  });

  it("rejects a malformed (non-JSON) body", async () => {
    const res = await PUT(new Request("http://test", {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: "{not valid json",
    }));
    expect(res.status).toBe(400);
  });

  describe("imageSpecs", () => {
    it("defaults to empty string and stores an update", async () => {
      const before = await (await GET()).json();
      expect(before.settings.imageSpecs).toBe("");

      const res = await put({ imageSpecs: "16:9, minimalist, no text overlays" });
      expect(res.status).toBe(200);
      const after = await (await GET()).json();
      expect(after.settings.imageSpecs).toBe("16:9, minimalist, no text overlays");
    });

    it("rejects a value over 4000 chars", async () => {
      const res = await put({ imageSpecs: "a".repeat(4001) });
      expect(res.status).toBe(400);
    });
  });

  describe("defaultSlots", () => {
    it("rejects an unknown platform key", async () => {
      const res = await put({ defaultSlots: { instagram: ["10:00"] } });
      expect(res.status).toBe(400);
    });

    it("rejects a malformed HH:MM slot", async () => {
      const res = await put({ defaultSlots: { x: ["9am"] } });
      expect(res.status).toBe(400);
    });

    it("rejects more than 6 slots for a platform", async () => {
      const res = await put({
        defaultSlots: { x: ["01:00", "02:00", "03:00", "04:00", "05:00", "06:00", "07:00"] },
      });
      expect(res.status).toBe(400);
    });

    it("accepts updating a single platform's slots", async () => {
      const res = await put({ defaultSlots: { x: ["11:00"] } });
      expect(res.status).toBe(200);
      const body = await (await GET()).json();
      expect(body.settings.defaultSlots.x).toEqual(["11:00"]);
    });
  });
});

describe("POST /api/settings/analyze-style", () => {
  function setExamples(x: string, linkedin: string) {
    return put({ toneExamplesX: x, toneExamplesLinkedin: linkedin });
  }

  it("401s when the session is denied", async () => {
    const { requireSession } = await import("@/lib/session");
    (requireSession as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      Response.json({ error: "unauthorized" }, { status: 401 }),
    );
    const res = await postAnalyzeStyle();
    expect(res.status).toBe(401);
  });

  it('400s with "add a few example posts first" when no examples are saved', async () => {
    const res = await postAnalyzeStyle();
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("add a few example posts first, or three posts to learn style from");
  });

  it("400s with fewer than 3 example blocks across both platforms combined", async () => {
    await setExamples("post one\n\npost two", "");
    expect((await postAnalyzeStyle()).status).toBe(400);
  });

  it("succeeds once the combined block count reaches 3, split across platforms", async () => {
    await setExamples("post one\n\npost two", "post three");
    expect((await postAnalyzeStyle()).status).toBe(201);
  });

  it("ignores blank blocks (runs of blank lines) when counting", async () => {
    await setExamples("post one\n\n\n\npost two\n\n   \n\n", "post three");
    expect((await postAnalyzeStyle()).status).toBe(201);
  });

  it("three style inspiration posts are enough without the owner's own; they go with the job (2026-09-24)", async () => {
    const { setSetting } = await import("@/lib/settings");
    const item = (n: number) => ({ id: `s${n}`, ideaId: null, text: `inspiring post ${n}`, author: "a", url: null, kind: "bluesky", slopScore: null, addedAt: "2026-09-24T08:00:00.000Z" });
    await setSetting(state.db as never, "styleInspiration", [item(1), item(2)]);
    expect((await postAnalyzeStyle()).status).toBe(400);
    await setSetting(state.db as never, "styleInspiration", [item(1), item(2), item(3)]);
    const res = await postAnalyzeStyle();
    expect(res.status).toBe(201);
    expect((await res.json()).job.payload.inspiration).toEqual(["inspiring post 1", "inspiring post 2", "inspiring post 3"]);
  });

  it("enqueues an analyze_style job carrying the examples and toneForm", async () => {
    await setExamples("post one\n\npost two\n\npost three", "");
    const res = await postAnalyzeStyle();
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.job.kind).toBe("analyze_style");
    expect(res.headers.get("X-PostEcho-Job")).toBe(body.job.id);
    expect(body.job.payload).toMatchObject({
      toneExamplesX: "post one\n\npost two\n\npost three",
      toneExamplesLinkedin: "",
      toneForm: {},
    });
  });
});

describe("GET /api/settings and the library (2026-09-24)", () => {
  it("never carries the style inspiration or reference lists — they have their own routes", async () => {
    const { setSetting } = await import("@/lib/settings");
    await setSetting(state.db as never, "references", [{ id: "r", name: "Bio", text: "x".repeat(5000), enabled: true, addedAt: "2026-09-24T00:00:00Z" }]);
    const body = await (await GET()).json();
    expect(body.settings).not.toHaveProperty("references");
    expect(body.settings).not.toHaveProperty("styleInspiration");
    expect(body.settings).toHaveProperty("styleGuideAnalyzedAt", null);
  });
});

describe("auth", () => {
  it("GET returns 401 when the session is denied", async () => {
    const { requireSession } = await import("@/lib/session");
    (requireSession as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      Response.json({ error: "unauthorized" }, { status: 401 }),
    );
    const res = await GET();
    expect(res.status).toBe(401);
  });

  it("PUT returns 401 when the session is denied", async () => {
    const { requireSession } = await import("@/lib/session");
    (requireSession as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      Response.json({ error: "unauthorized" }, { status: 401 }),
    );
    const res = await put({ topics: ["ai"] });
    expect(res.status).toBe(401);
  });
});

describe("the X API key (2026-09-24)", () => {
  // Shaped like an X bearer token, and plainly not one.
  const TOKEN = "not-a-real-x-bearer-token-only-for-tests-0123456789%2BFAKE";

  beforeEach(() => {
    vi.stubEnv("SESSION_SECRET", "a-session-secret-that-is-long-enough-1234");
  });

  it("is never sent to the browser: GET says whether it's there and its last four characters", async () => {
    let body = await (await GET()).json();
    expect(body.x).toEqual({ connected: false, hint: null });
    expect(body.settings.xPostsPerSearch).toBe(20);

    expect((await put({ xBearerToken: TOKEN })).status).toBe(200);
    body = await (await GET()).json();
    expect(body.x).toEqual({ connected: true, hint: "…FAKE" });
    expect(JSON.stringify(body)).not.toContain(TOKEN.slice(10, 40));
    expect(body.settings).not.toHaveProperty("xBearerToken");
  });

  it("is stored sealed, not in the clear, and \"\" removes it", async () => {
    await put({ xBearerToken: `  ${TOKEN}  ` });
    const { getSetting } = await import("@/lib/settings");
    const stored = await getSetting(state.db! as never, "xBearerToken");
    expect(stored.startsWith("v1.")).toBe(true);
    expect(stored).not.toContain(TOKEN.slice(10, 40));
    const { loadXConfig } = await import("@/lib/x-config");
    expect((await loadXConfig(state.db! as never)).token).toBe(TOKEN);

    expect((await put({ xBearerToken: "" })).status).toBe(200);
    expect((await (await GET()).json()).x).toEqual({ connected: false, hint: null });
  });

  it("rejects what isn't a bearer token, and a budget outside 10–100", async () => {
    expect((await put({ xBearerToken: "short" })).status).toBe(400);
    expect((await put({ xBearerToken: "has spaces in it and is long enough" })).status).toBe(400);
    expect((await put({ xPostsPerSearch: 5 })).status).toBe(400);
    expect((await put({ xPostsPerSearch: 101 })).status).toBe(400);
    expect((await put({ xPostsPerSearch: 40 })).status).toBe(200);
    expect((await (await GET()).json()).settings.xPostsPerSearch).toBe(40);
  });

  it("the scout's env carries the key only once one is saved", async () => {
    const { scoutEnv } = await import("@/lib/x-config");
    const base = { NODE_ENV: "test" } as NodeJS.ProcessEnv;
    expect(await scoutEnv(state.db! as never, base)).toBe(base);
    await put({ xBearerToken: TOKEN, xPostsPerSearch: 30 });
    expect(await scoutEnv(state.db! as never, base)).toEqual({ NODE_ENV: "test", X_BEARER_TOKEN: TOKEN, X_POSTS_PER_SEARCH: "30" });
  });
});

describe("disconnected sources (2026-09-25)", () => {
  it("stores the list of sources the owner disconnected, and refuses what isn't a source name", async () => {
    expect((await put({ disabledSources: ["hackernews", "x_post"] })).status).toBe(200);
    expect((await (await GET()).json()).settings.disabledSources).toEqual(["hackernews", "x_post"]);
    expect((await put({ disabledSources: ["Not A Name!"] })).status).toBe(400);
  });
});

describe("what to show you first (2026-09-26)", () => {
  it("returns the default order, and saves a new one", async () => {
    expect((await (await GET()).json()).settings.findOrder).toEqual(["story", "opinion", "problem", "news", "tool"]);
    expect((await put({ findOrder: ["opinion", "story", "problem", "news", "tool"] })).status).toBe(200);
    expect((await (await GET()).json()).settings.findOrder).toEqual(["opinion", "story", "problem", "news", "tool"]);
  });

  it("rejects an order with a kind missing, repeated or unknown", async () => {
    expect((await put({ findOrder: ["story", "opinion"] })).status).toBe(400);
    expect((await put({ findOrder: ["story", "story", "problem", "news", "tool"] })).status).toBe(400);
    expect((await put({ findOrder: ["story", "poem", "problem", "news", "tool"] })).status).toBe(400);
  });

  it("counts the votes per kind", async () => {
    const [idea] = await state.db!.insert(ideas).values({ kind: "devto", content: "c", status: "used", meta: { postKind: "story" } }).returning();
    const [draft] = await state.db!.insert(drafts).values({ ideaId: idea.id, xText: "p", status: "used" }).returning();
    await state.db!.insert(scheduledPosts).values({
      draftId: draft.id, platform: "x", text: "p", status: "posted_manually", postedBy: "manual",
      publishAt: new Date(Date.now() - 86_400_000), outcome: "good", ratedAt: new Date(),
    });
    const body = await (await GET()).json();
    expect(body.kindCounts.story).toEqual({ good: 1, bad: 0 });
    expect(body.tasteCounts.rated).toBe(1);
  });
});

describe("the Claude model (2026-09-26, Settings › AI tools)", () => {
  it("defaults to Sonnet, saves Opus or Haiku, and refuses anything else", async () => {
    expect((await (await GET()).json()).settings.claudeModel).toBe("sonnet");
    expect((await put({ claudeModel: "opus" })).status).toBe(200);
    expect((await (await GET()).json()).settings.claudeModel).toBe("opus");
    expect((await put({ claudeModel: "gpt-5" })).status).toBe(400);
  });
});
