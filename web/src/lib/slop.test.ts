import { afterEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb } from "@/test/db";
import { drafts } from "@/db/schema";
import type { JevClient, SlopCheck } from "jev-judge";

const fakeSlopCheck: SlopCheck = { slopScore: 72, confidence: 0.8, verdict: "slop", genericFiller: true, fillerScore: 0.9 };
vi.mock("jev-judge", async (orig) => ({
  ...(await orig()),
  checkSlop: vi.fn(async () => fakeSlopCheck),
  createJevClient: vi.fn(),
}));

const { runSlopCheck, getSlopClient, setSlopDeps } = await import("@/lib/slop");
const { checkSlop, createJevClient } = await import("jev-judge");

const fakeClient: JevClient = { systemOne: vi.fn() };

afterEach(() => {
  setSlopDeps({});
  vi.unstubAllEnvs();
  vi.mocked(checkSlop).mockClear();
  vi.mocked(createJevClient).mockReset();
});

describe("getSlopClient", () => {
  it("returns null when no client is injected and no Jev key is set", async () => {
    vi.stubEnv("TYPESAFE_API_KEY", "");
    const db = await createTestDb();
    expect(await getSlopClient(db as never)).toBeNull();
  });

  it("builds a client with the deployment's TYPESAFE_API_KEY", async () => {
    vi.stubEnv("TYPESAFE_API_KEY", "key123");
    vi.mocked(createJevClient).mockReturnValue(fakeClient);
    const db = await createTestDb();
    expect(await getSlopClient(db as never)).toBe(fakeClient);
    expect(createJevClient).toHaveBeenCalledWith({ apiKey: "key123" });
  });

  it("prefers an injected client via setSlopDeps over building one", async () => {
    vi.stubEnv("TYPESAFE_API_KEY", "key123");
    setSlopDeps({ jev: fakeClient });
    const db = await createTestDb();
    expect(await getSlopClient(db as never)).toBe(fakeClient);
    expect(createJevClient).not.toHaveBeenCalled();
  });
});

describe("runSlopCheck", () => {
  it("returns the checkSlop result", async () => {
    const db = await createTestDb();
    const result = await runSlopCheck(db as never, fakeClient, { text: "some draft text" });
    expect(result).toEqual(fakeSlopCheck);
    expect(checkSlop).toHaveBeenCalledWith(fakeClient, { text: "some draft text", platform: undefined });
  });

  it("persists the result onto drafts.meta.slop when draftId is given, preserving other meta keys", async () => {
    const db = await createTestDb();
    const [draft] = await db.insert(drafts).values({ xText: "hi", meta: { overLimit: false } }).returning();
    await runSlopCheck(db as never, fakeClient, { text: "hi", platform: "x", draftId: draft.id });

    const [row] = await db.select().from(drafts).where(eq(drafts.id, draft.id));
    const meta = row.meta as {
      overLimit?: boolean;
      slop?: { platform: string; slopScore: number; verdict: string; at: string };
    };
    expect(meta.overLimit).toBe(false);
    expect(meta.slop).toMatchObject({ platform: "x", slopScore: 72, verdict: "slop" });
    expect(typeof meta.slop!.at).toBe("string");
    expect((row.meta as { slopByPlatform?: Record<string, unknown> }).slopByPlatform).toMatchObject({ x: { slopScore: 72, verdict: "slop" } });
  });

  it("does not touch any draft when draftId is omitted", async () => {
    const db = await createTestDb();
    const [draft] = await db.insert(drafts).values({ xText: "hi" }).returning();
    await runSlopCheck(db as never, fakeClient, { text: "hi" });
    const [row] = await db.select().from(drafts).where(eq(drafts.id, draft.id));
    expect(row.meta).toEqual({});
  });

  it("tolerates a draftId that doesn't exist (no crash)", async () => {
    const db = await createTestDb();
    const result = await runSlopCheck(db as never, fakeClient, {
      text: "hi", draftId: "00000000-0000-0000-0000-000000000000",
    });
    expect(result).toEqual(fakeSlopCheck);
  });
});
