import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb } from "@/test/db";
import { drafts, jobs } from "@/db/schema";
import type { JevClient, SlopCheck } from "jev-judge";

const state: { db: Awaited<ReturnType<typeof createTestDb>> | null } = { db: null };
vi.mock("@/db", () => ({ get db() { return state.db; } }));
vi.stubEnv("AGENT_TOKEN", "agent-token");

const fakeSlop: SlopCheck = { slopScore: 44, confidence: 0.8, verdict: "borderline", genericFiller: false, fillerScore: 0.2 };
vi.mock("jev-judge", async (orig) => ({ ...(await orig()), checkSlop: vi.fn(async () => fakeSlop) }));

const { POST: slopCheck } = await import("@/app/api/agent/slop-check/route");
const { POST: progress } = await import("@/app/api/agent/jobs/[id]/progress/route");
const { POST: postResult } = await import("@/app/api/agent/jobs/[id]/result/route");
const { GET: claim } = await import("@/app/api/agent/jobs/route");
const { setSlopDeps } = await import("@/lib/slop");
const { checkSlop } = await import("jev-judge");

const auth = { Authorization: "Bearer agent-token", "Content-Type": "application/json" };

function post(body: unknown, headers: Record<string, string> = auth) {
  return new Request("http://test", { method: "POST", headers, body: JSON.stringify(body) });
}

/** Write's Humanize: a revise_draft in humanize mode, claimed by the agent. */
async function claimedHumanizeJob() {
  const [draft] = await state.db!.insert(drafts).values({ xText: "sloppy" }).returning();
  await state.db!.insert(jobs).values({ kind: "revise_draft", payload: { draftId: draft.id, xText: "sloppy", instruction: "Humanize", humanize: "x" } });
  const res = await claim(new Request("http://test/api/agent/jobs?kinds=revise_draft&wait=0", { headers: auth }));
  expect(res.status).toBe(200);
  return (await res.json()).job as { id: string; claimedAt: string; kind: string };
}

beforeEach(async () => {
  state.db = await createTestDb();
  vi.mocked(checkSlop).mockReset().mockResolvedValue(fakeSlop);
  setSlopDeps({ jev: { systemOne: vi.fn() } as JevClient });
});

afterEach(() => setSlopDeps({}));

describe("POST /api/agent/slop-check", () => {
  it("scores the text for the agent over its bearer token, nothing persisted", async () => {
    const res = await slopCheck(post({ text: " a rewrite ", platform: "x" }));
    expect(res.status).toBe(200);
    expect((await res.json()).slop).toEqual(fakeSlop);
    expect(vi.mocked(checkSlop).mock.calls[0][1]).toEqual({ text: "a rewrite", platform: "x" });
  });

  it("401 without the agent token, 400 on a bad body, 503 without a Jev key", async () => {
    expect((await slopCheck(post({ text: "t" }, { "Content-Type": "application/json" }))).status).toBe(401);
    expect((await slopCheck(post({ text: "" }))).status).toBe(400);
    expect((await slopCheck(post({ text: "t", platform: "tiktok" }))).status).toBe(400);
    setSlopDeps({});
    vi.stubEnv("TYPESAFE_API_KEY", "");
    expect((await slopCheck(post({ text: "t" }))).status).toBe(503);
    vi.unstubAllEnvs();
    vi.stubEnv("AGENT_TOKEN", "agent-token");
  });
});

describe("POST /api/agent/jobs/:id/progress", () => {
  it("progress lands on the claimed Humanize's result until the final report replaces it", async () => {
    const job = await claimedHumanizeJob();
    expect(job.kind).toBe("revise_draft");

    const report = { kind: "humanize", round: 2, maxRounds: 3, phase: "rewriting", rounds: [{ round: 1, slopScore: 58, verdict: "borderline" }] };
    const res = await progress(post({ claimedAt: job.claimedAt, progress: report }), { params: Promise.resolve({ id: job.id }) });
    expect(res.status).toBe(200);
    let [row] = await state.db!.select().from(jobs).where(eq(jobs.id, job.id));
    expect(row.status).toBe("claimed");
    expect(row.result).toEqual({ progress: report });

    const done = await postResult(
      post({ ok: true, claimedAt: job.claimedAt, result: { xText: "loose", humanize: { rounds: [{ round: 1, slopScore: 58, verdict: "borderline" }, { round: 2, slopScore: 22, verdict: "human" }] }, slop: { platform: "x", slopScore: 22, verdict: "human" } } }),
      { params: Promise.resolve({ id: job.id }) },
    );
    expect(done.status).toBe(200);
    [row] = await state.db!.select().from(jobs).where(eq(jobs.id, job.id));
    expect(row.status).toBe("done");
    expect(row.result).toMatchObject({ xText: "loose", slop: { slopScore: 22 } });
    expect((row.result as Record<string, unknown>).progress).toBeUndefined();

    // A late progress report after the end matches nothing.
    const late = await progress(post({ claimedAt: job.claimedAt, progress: report }), { params: Promise.resolve({ id: job.id }) });
    expect(late.status).toBe(404);
  });

  it("404 for the wrong claim echo or an unknown job; 400 bad body; 413 oversized; 401 without the token", async () => {
    const job = await claimedHumanizeJob();
    const params = () => ({ params: Promise.resolve({ id: job.id }) });
    expect((await progress(post({ claimedAt: "2020-01-01T00:00:00.000Z", progress: {} }), params())).status).toBe(404);
    expect((await progress(post({ claimedAt: job.claimedAt, progress: {} }), { params: Promise.resolve({ id: "5c1d6b3e-1111-4222-8333-444455556666" }) })).status).toBe(404);
    expect((await progress(post({ claimedAt: job.claimedAt, progress: {} }), { params: Promise.resolve({ id: "nope" }) })).status).toBe(404);
    expect((await progress(post({ claimedAt: job.claimedAt }), params())).status).toBe(400);
    expect((await progress(post({ claimedAt: "not a date", progress: {} }), params())).status).toBe(400);
    expect((await progress(post({ claimedAt: job.claimedAt, progress: { blob: "x".repeat(9000) } }), params())).status).toBe(413);
    expect((await progress(post({ claimedAt: job.claimedAt, progress: {} }, { "Content-Type": "application/json" }), params())).status).toBe(401);
  });

  it("an invalid Humanize result fails the job", async () => {
    const job = await claimedHumanizeJob();
    const res = await postResult(post({ ok: true, claimedAt: job.claimedAt, result: { xText: "" } }), { params: Promise.resolve({ id: job.id }) });
    expect(res.status).toBe(400);
    const [row] = await state.db!.select().from(jobs).where(eq(jobs.id, job.id));
    expect(row.status).toBe("failed");
  });
});
