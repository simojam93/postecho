import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb } from "@/test/db";
import { getSetting, setSetting } from "@/lib/settings";

const state: { db: Awaited<ReturnType<typeof createTestDb>> | null; loggedIn: boolean } = { db: null, loggedIn: true };
vi.mock("@/db", () => ({ get db() { return state.db; } }));
vi.mock("@/lib/session", () => ({
  requireSession: async () => (state.loggedIn ? null : Response.json({ error: "unauthorized" }, { status: 401 })),
}));

const { GET, POST } = await import("@/app/api/style-learning/route");

const proposal = {
  guide: "Short sentences.\nOpen with a number.",
  changes: [{ summary: "Open with a number", reason: "7 of 10 posts you kept do, 1 of 9 you dropped." }],
  lessons: [],
  basedOn: 19,
  createdAt: "2026-09-27T09:00:00.000Z",
};

function post(body: unknown) {
  return POST(new Request("http://test", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }));
}

beforeEach(async () => {
  state.db = await createTestDb();
  state.loggedIn = true;
  vi.stubEnv("TYPESAFE_API_KEY", "");
});

describe("GET /api/style-learning", () => {
  it("the waiting suggestion and how far the next look is", async () => {
    await setSetting(state.db as never, "styleProposal", proposal);
    const res = await GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ proposal, running: false, choices: 0, newChoices: 0, learnedAt: null, needed: 15 });
  });

  it("401 when signed out", async () => {
    state.loggedIn = false;
    expect((await GET()).status).toBe(401);
    expect((await post({ action: "apply" })).status).toBe(401);
  });
});

describe("POST /api/style-learning", () => {
  it("apply makes it the guide and stops it waiting", async () => {
    await setSetting(state.db as never, "styleGuide", "Short sentences.");
    await setSetting(state.db as never, "styleProposal", proposal);
    const res = await post({ action: "apply" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, styleGuide: proposal.guide });
    expect(await getSetting(state.db as never, "styleGuide")).toBe(proposal.guide);
    expect(await getSetting(state.db as never, "styleProposal")).toBeNull();
  });

  it("dismiss drops it and leaves the guide alone", async () => {
    await setSetting(state.db as never, "styleGuide", "Short sentences.");
    await setSetting(state.db as never, "styleProposal", proposal);
    expect(await (await post({ action: "dismiss" })).json()).toEqual({ ok: true });
    expect(await getSetting(state.db as never, "styleGuide")).toBe("Short sentences.");
    expect(await getSetting(state.db as never, "styleProposal")).toBeNull();
  });

  it("409 with nothing waiting, 400 on a bad body", async () => {
    expect((await post({ action: "apply" })).status).toBe(409);
    expect((await post({ action: "later" })).status).toBe(400);
    expect((await post({ action: "apply", extra: 1 })).status).toBe(400);
  });
});
