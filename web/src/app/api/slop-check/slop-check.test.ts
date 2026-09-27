import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb } from "@/test/db";
import { drafts } from "@/db/schema";
import type { JevClient, SlopCheck } from "jev-judge";

const state: { db: Awaited<ReturnType<typeof createTestDb>> | null } = { db: null };
vi.mock("@/db", () => ({ get db() { return state.db; } }));
vi.mock("@/lib/session", async (orig) => ({
  ...(await orig()),
  requireSession: vi.fn(async () => null),
}));

const fakeSlopCheck: SlopCheck = { slopScore: 20, confidence: 0.7, verdict: "human", genericFiller: false, fillerScore: 0.1 };
vi.mock("jev-judge", async (orig) => ({
  ...(await orig()),
  checkSlop: vi.fn(async () => fakeSlopCheck),
}));

const { POST } = await import("@/app/api/slop-check/route");
const { setSlopDeps } = await import("@/lib/slop");
const { checkSlop } = await import("jev-judge");

const fakeClient: JevClient = { systemOne: vi.fn() };

function req(body: unknown) {
  return new Request("http://test/api/slop-check", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(async () => {
  state.db = await createTestDb();
  const { requireSession } = await import("@/lib/session");
  const mock = requireSession as unknown as ReturnType<typeof vi.fn>;
  mock.mockReset();
  mock.mockResolvedValue(null);
  vi.mocked(checkSlop).mockReset();
  vi.mocked(checkSlop).mockResolvedValue(fakeSlopCheck);
});

afterEach(() => {
  setSlopDeps({});
  vi.unstubAllEnvs();
});

describe("POST /api/slop-check", () => {
  it("401s when the session is denied", async () => {
    const { requireSession } = await import("@/lib/session");
    (requireSession as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      Response.json({ error: "unauthorized" }, { status: 401 }),
    );
    const res = await POST(req({ text: "hello" }));
    expect(res.status).toBe(401);
  });

  it("400s on missing/empty/too-long text", async () => {
    expect((await POST(req({}))).status).toBe(400);
    expect((await POST(req({ text: "" }))).status).toBe(400);
    expect((await POST(req({ text: "x".repeat(5001) }))).status).toBe(400);
  });

  it("400s on an invalid platform", async () => {
    expect((await POST(req({ text: "hi", platform: "bluesky" }))).status).toBe(400);
  });

  it("400s on an invalid draftId", async () => {
    setSlopDeps({ jev: fakeClient });
    expect((await POST(req({ text: "hi", draftId: "not-a-uuid" }))).status).toBe(400);
  });

  it("503s when no Jev client is available (TYPESAFE_API_KEY unset, none injected)", async () => {
    vi.stubEnv("TYPESAFE_API_KEY", "");
    const res = await POST(req({ text: "hello" }));
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error).toBe("slop check disabled: TYPESAFE_API_KEY not set");
    expect(checkSlop).not.toHaveBeenCalled();
  });

  it("returns the slop check result shape", async () => {
    setSlopDeps({ jev: fakeClient });
    const res = await POST(req({ text: "hello world", platform: "linkedin" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.slop).toEqual(fakeSlopCheck);
    expect(checkSlop).toHaveBeenCalledWith(fakeClient, { text: "hello world", platform: "linkedin" });
  });

  it("persists the result onto drafts.meta.slop when draftId is given", async () => {
    setSlopDeps({ jev: fakeClient });
    const [draft] = await state.db!.insert(drafts).values({ xText: "hi" }).returning();
    const res = await POST(req({ text: "hi", platform: "x", draftId: draft.id }));
    expect(res.status).toBe(200);

    const rows = await state.db!.select().from(drafts);
    const meta = rows[0].meta as { slop?: { verdict: string; platform: string } };
    expect(meta.slop).toMatchObject({ verdict: "human", platform: "x" });
  });
});
