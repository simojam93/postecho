import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb } from "@/test/db";
import { drafts, ideas, jobKind, jobs } from "@/db/schema";

const state: { db: Awaited<ReturnType<typeof createTestDb>> | null } = { db: null };
vi.mock("@/db", () => ({ get db() { return state.db; } }));
vi.stubEnv("AGENT_TOKEN", "agent-token");
// The heartbeat's after-the-answer work, kept to run by hand.
const { afterTasks } = vi.hoisted(() => ({ afterTasks: [] as Array<() => unknown> }));
vi.mock("next/server", async (orig) => ({ ...(await orig<typeof import("next/server")>()), after: (task: () => unknown) => { afterTasks.push(task); } }));

const { GET } = await import("@/app/api/agent/jobs/route");
const { POST: postResult } = await import("@/app/api/agent/jobs/[id]/result/route");
const { POST: heartbeat } = await import("@/app/api/agent/heartbeat/route");
const { GET: getProfile } = await import("@/app/api/agent/profile/route");

const auth = { Authorization: "Bearer agent-token" };

function claimReq(kinds = "generate_from_video", wait = "0") {
  return new Request(`http://test/api/agent/jobs?kinds=${kinds}&wait=${wait}`, { headers: auth });
}

function resultReq(id: string, body: Record<string, unknown>) {
  return postResult(
    new Request("http://test", {
      method: "POST", headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id }) },
  );
}

beforeEach(async () => { state.db = await createTestDb(); });

describe("agent auth", () => {
  it("rejects wrong token", async () => {
    const res = await GET(new Request("http://test/api/agent/jobs?kinds=chat&wait=0", {
      headers: { Authorization: "Bearer nope" },
    }));
    expect(res.status).toBe(401);
  });

  it("rejects when AGENT_TOKEN unset", async () => {
    vi.stubEnv("AGENT_TOKEN", "");
    const res = await GET(claimReq());
    expect(res.status).toBe(401);
    vi.stubEnv("AGENT_TOKEN", "agent-token");
  });
});

describe("claim", () => {
  it("400 without kinds", async () => {
    const res = await GET(new Request("http://test/api/agent/jobs?wait=0", { headers: auth }));
    expect(res.status).toBe(400);
  });

  it("returns 204 when no jobs", async () => {
    expect((await GET(claimReq())).status).toBe(204);
  });

  it("never claims for a caller that already went away — the job stays queued", async () => {
    await state.db!.insert(jobs).values({ kind: "video_ideas", payload: { url: "https://youtu.be/x" } });
    const controller = new AbortController();
    controller.abort();
    const res = await GET(new Request("http://test/api/agent/jobs?kinds=video_ideas&wait=0", { headers: auth, signal: controller.signal }));
    expect(res.status).toBe(499);
    const [row] = await state.db!.select().from(jobs);
    expect(row.status).toBe("queued");
    expect(row.claimedAt).toBeNull();
  });

  it("a caller that goes away during the wait stops the long-poll", async () => {
    const controller = new AbortController();
    const started = Date.now();
    setTimeout(() => controller.abort(), 50);
    const res = await GET(new Request("http://test/api/agent/jobs?kinds=video_ideas&wait=5", { headers: auth, signal: controller.signal }));
    expect(res.status).toBe(499);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("claims the oldest queued job of a requested kind", async () => {
    await state.db!.insert(jobs).values({ kind: "scout", payload: { n: 0 } });
    await state.db!.insert(jobs).values({ kind: "generate_from_video", payload: { n: 1 }, createdAt: new Date(Date.now() - 60_000) });
    await state.db!.insert(jobs).values({ kind: "generate_from_video", payload: { n: 2 } });

    const res = await GET(claimReq());
    expect(res.status).toBe(200);
    const { job } = await res.json();
    expect(job.kind).toBe("generate_from_video");
    expect(job.payload).toMatchObject({ n: 1 });
    expect(typeof job.claimedAt).toBe("string");

    const res2 = await GET(claimReq());
    expect((await res2.json()).job.payload).toMatchObject({ n: 2 });

    expect((await GET(claimReq())).status).toBe(204);
  });

  it("supports multiple kinds", async () => {
    await state.db!.insert(jobs).values({ kind: "scout", payload: {} });
    const res = await GET(claimReq("generate_from_video,scout"));
    expect(res.status).toBe(200);
  });

  it("accepts every job_kind enum value in one kinds= list (the agent claims all its kinds at once)", async () => {
    await state.db!.insert(jobs).values({ kind: "generate_from_idea", payload: { seedText: "an idea" } });
    const res = await GET(claimReq(jobKind.enumValues.join(",")));
    expect(res.status).toBe(200);
    expect((await res.json()).job.kind).toBe("generate_from_idea");
  });

  it("rejects invalid kinds", async () => {
    const res = await GET(claimReq("generate_from_video,DROP TABLE"));
    expect(res.status).toBe(400);
  });

  it("re-queues stale claimed jobs (older than 10 min)", async () => {
    const stale = new Date(Date.now() - 11 * 60 * 1000);
    await state.db!.insert(jobs).values({ kind: "generate_from_video", payload: {}, status: "claimed", claimedAt: stale });
    const res = await GET(claimReq());
    expect(res.status).toBe(200);
  });

  it("does not re-queue fresh claimed jobs", async () => {
    await state.db!.insert(jobs).values({ kind: "generate_from_video", payload: {}, status: "claimed", claimedAt: new Date() });
    expect((await GET(claimReq())).status).toBe(204);
  });

  it("wait-loop pickup: claims a job inserted after the poll has started", async () => {
    const pending = GET(claimReq("generate_from_video", "3"));
    setTimeout(() => {
      // drizzle's query builders are lazy `QueryPromise`s: nothing runs until
      // `.then()`/await is actually called on them, so this needs a real
      // `.catch()` (which calls `.then()` internally) to fire — a bare `void`
      // on the un-awaited builder would silently never execute the insert.
      state.db!.insert(jobs).values({ kind: "generate_from_video", payload: { late: true } }).catch(() => {});
    }, 300);

    const res = await pending;
    expect(res.status).toBe(200);
    const { job } = await res.json();
    expect(job.payload).toMatchObject({ late: true });
  });

  it("concurrent claims on a single queued job produce exactly one winner", async () => {
    await state.db!.insert(jobs).values({ kind: "generate_from_video", payload: {} });

    const results = await Promise.all([claimReq(), claimReq(), claimReq()].map((req) => GET(req)));
    const statuses = results.map((r) => r.status).sort();
    expect(statuses).toEqual([200, 204, 204]);
  });
});

describe("result", () => {
  it("stores result and marks done", async () => {
    const [j] = await state.db!.insert(jobs)
      .values({ kind: "generate_from_video", payload: {}, status: "claimed", claimedAt: new Date() })
      .returning();
    const res = await resultReq(
      j.id,
      { ok: true, result: { drafts: [{ xText: "hello" }] }, claimedAt: j.claimedAt!.toISOString() },
    );
    expect(res.status).toBe(200);
    const rows = await state.db!.select().from(jobs);
    expect(rows[0].status).toBe("done");
    expect(rows[0].finishedAt).not.toBeNull();
  });

  it("materializes drafts before marking done, linked to the job and idea (task A3)", async () => {
    const [idea] = await state.db!.insert(ideas).values({ kind: "note", content: "seed" }).returning();
    const [j] = await state.db!.insert(jobs)
      .values({ kind: "generate_from_video", payload: { ideaId: idea.id }, status: "claimed", claimedAt: new Date() })
      .returning();
    const res = await resultReq(j.id, {
      ok: true,
      result: { drafts: [{ xText: "hello" }, { linkedinText: "a longer post" }] },
      claimedAt: j.claimedAt!.toISOString(),
    });
    expect(res.status).toBe(200);

    const draftRows = await state.db!.select().from(drafts);
    expect(draftRows).toHaveLength(2);
    expect(draftRows.every((d) => d.jobId === j.id)).toBe(true);
    expect(draftRows.every((d) => d.ideaId === idea.id)).toBe(true);
    expect(draftRows.every((d) => d.status === "candidate")).toBe(true);
  });

  it("an invalid result shape for the job's kind marks it failed and returns 400, without touching drafts (task A3)", async () => {
    const [j] = await state.db!.insert(jobs)
      .values({ kind: "generate_from_video", payload: {}, status: "claimed", claimedAt: new Date() })
      .returning();
    const res = await resultReq(j.id, { ok: true, result: {}, claimedAt: j.claimedAt!.toISOString() });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("invalid result for kind");

    const rows = await state.db!.select().from(jobs);
    expect(rows[0].status).toBe("failed");
    expect(rows[0].result).toMatchObject({ error: "invalid result for kind" });
    expect(await state.db!.select().from(drafts)).toHaveLength(0);
  });

  it("marks failed with error", async () => {
    const [j] = await state.db!.insert(jobs)
      .values({ kind: "generate_from_video", payload: {}, status: "claimed", claimedAt: new Date() })
      .returning();
    const res = await resultReq(j.id, { ok: false, error: "transcript blocked", claimedAt: j.claimedAt!.toISOString() });
    expect(res.status).toBe(200);
    const rows = await state.db!.select().from(jobs);
    expect(rows[0].status).toBe("failed");
    expect(rows[0].result).toMatchObject({ error: "transcript blocked" });
  });

  it("404 for queued (unclaimed) job and for unknown/invalid ids", async () => {
    const [j] = await state.db!.insert(jobs).values({ kind: "scout", payload: {} }).returning();
    const body = { ok: true, result: {}, claimedAt: new Date().toISOString() };
    expect((await resultReq(j.id, body)).status).toBe(404);
    expect((await resultReq("00000000-0000-0000-0000-000000000000", body)).status).toBe(404);
    expect((await resultReq("not-a-uuid", body)).status).toBe(404);
  });

  it("rejects malformed bodies", async () => {
    const [j] = await state.db!.insert(jobs)
      .values({ kind: "scout", payload: {}, status: "claimed", claimedAt: new Date() })
      .returning();
    const res = await resultReq(j.id, { ok: "yes" });
    expect(res.status).toBe(400);
  });

  it("400 when claimedAt is missing or not a valid date", async () => {
    const [j] = await state.db!.insert(jobs)
      .values({ kind: "scout", payload: {}, status: "claimed", claimedAt: new Date() })
      .returning();
    expect((await resultReq(j.id, { ok: true, result: {} })).status).toBe(400);
    expect((await resultReq(j.id, { ok: true, result: {}, claimedAt: "not-a-date" })).status).toBe(400);
  });

  it("late result after requeue: a superseded claim's echo can't attach to the re-claim", async () => {
    await state.db!.insert(jobs).values({ kind: "generate_from_video", payload: {} });

    const claimA = await (await GET(claimReq())).json();
    const jobA = claimA.job;

    // Simulate the 10-minute stale-claim sweep without waiting 10 minutes:
    // force the row back to queued with claimed_at nulled, exactly like
    // requeueStaleClaims does.
    await state.db!.update(jobs).set({ status: "queued", claimedAt: null }).where(eq(jobs.id, jobA.id));

    const claimB = await (await GET(claimReq())).json();
    const jobB = claimB.job;
    expect(jobB.id).toBe(jobA.id);

    const lateReport = await resultReq(jobA.id, { ok: true, result: {}, claimedAt: jobA.claimedAt });
    expect(lateReport.status).toBe(404);

    const freshReport = await resultReq(
      jobB.id,
      { ok: true, result: { drafts: [{ xText: "hi" }] }, claimedAt: jobB.claimedAt },
    );
    expect(freshReport.status).toBe(200);
  });

  it("double result post: a second report against the same echo is rejected", async () => {
    await state.db!.insert(jobs).values({ kind: "scout", payload: {} });
    const { job } = await (await GET(claimReq("scout"))).json();

    const body = { ok: true, result: {}, claimedAt: job.claimedAt };
    expect((await resultReq(job.id, body)).status).toBe(200);
    expect((await resultReq(job.id, body)).status).toBe(404);
  });
});

describe("profile", () => {
  it("rejects wrong token", async () => {
    const res = await getProfile(new Request("http://test", { headers: { Authorization: "Bearer nope" } }));
    expect(res.status).toBe(401);
  });

  it("rejects when AGENT_TOKEN unset", async () => {
    vi.stubEnv("AGENT_TOKEN", "");
    const res = await getProfile(new Request("http://test", { headers: auth }));
    expect(res.status).toBe(401);
    vi.stubEnv("AGENT_TOKEN", "agent-token");
  });

  it("returns the tone/identity shape the agent needs, defaults when unset", async () => {
    const res = await getProfile(new Request("http://test", { headers: auth }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      identityName: "",
      identityHandle: "",
      toneExamplesX: "",
      toneExamplesLinkedin: "",
      toneForm: {},
      styleGuide: "",
      topics: [],
      imageSpecs: "",
      references: [],
    });
  });

  it("carries the enabled reference material, in order, within its budget", async () => {
    const { setSetting } = await import("@/lib/settings");
    await setSetting(state.db as never, "references", [
      { id: "a", name: "Bio", text: "UX designer.", enabled: true, addedAt: "2026-09-24T00:00:00Z" },
      { id: "b", name: "Off", text: "hidden", enabled: false, addedAt: "2026-09-24T00:00:00Z" },
      { id: "c", name: "Big", text: "y".repeat(20000), enabled: true, addedAt: "2026-09-24T00:00:00Z" },
    ]);
    const body = await (await getProfile(new Request("http://test", { headers: auth }))).json();
    expect(body.references.map((r: { name: string }) => r.name)).toEqual(["Bio", "Big"]);
    expect(body.references[1].text.length).toBeLessThanOrEqual(12000 + 2);
  });

  it("reflects stored settings and never includes notificationEmail", async () => {
    const { setSetting } = await import("@/lib/settings");
    await setSetting(state.db as never, "identityName", "Simone");
    await setSetting(state.db as never, "identityHandle", "@simone");
    await setSetting(state.db as never, "topics", ["ai audio"]);
    await setSetting(state.db as never, "imageSpecs", "16:9, minimalist");
    await setSetting(state.db as never, "notificationEmail", "simone@example.com");

    const res = await getProfile(new Request("http://test", { headers: auth }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.identityName).toBe("Simone");
    expect(body.identityHandle).toBe("@simone");
    expect(body.topics).toEqual(["ai audio"]);
    expect(body.imageSpecs).toBe("16:9, minimalist");
    expect(body).not.toHaveProperty("notificationEmail");
    expect(JSON.stringify(body)).not.toContain("simone@example.com");
  });
});

describe("heartbeat", () => {
  it("stores last heartbeat in kv", async () => {
    const res = await heartbeat(new Request("http://test", {
      method: "POST", headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({ kinds: ["generate_from_video"] }),
    }));
    expect(res.status).toBe(200);
    const { getSetting } = await import("@/lib/settings");
    const hb = await getSetting(state.db as never, "agentLastHeartbeatAt");
    expect(hb).toBeTruthy();
    expect(new Date(hb as string).getTime()).toBeGreaterThan(Date.now() - 10_000);
  });

  it("remembers the job kinds the agent says it serves (posts from a repo, 2026-10-10)", async () => {
    const beat = (body: unknown) => heartbeat(new Request("http://test", {
      method: "POST", headers: { ...auth, "Content-Type": "application/json" }, body: JSON.stringify(body),
    }));
    const { getSetting } = await import("@/lib/settings");
    expect((await beat({ kinds: ["a", "b"] })).status).toBe(200);
    expect(await getSetting(state.db as never, "agentKinds")).toEqual(["a", "b"]);
    // Anything but a list of strings leaves the last list as it was.
    expect((await beat({ kinds: [1, "c"] })).status).toBe(200);
    expect((await beat({})).status).toBe(200);
    expect(await getSetting(state.db as never, "agentKinds")).toEqual(["a", "b"]);
  });

  it("answers with the Claude model the owner picked, Sonnet by default (2026-09-26)", async () => {
    const beat = () => heartbeat(new Request("http://test", {
      method: "POST", headers: { ...auth, "Content-Type": "application/json" }, body: JSON.stringify({ kinds: [] }),
    }));
    expect(await (await beat()).json()).toEqual({ ok: true, claudeModel: "sonnet" });
    const { setSetting } = await import("@/lib/settings");
    await setSetting(state.db as never, "claudeModel", "opus");
    expect(await (await beat()).json()).toEqual({ ok: true, claudeModel: "opus" });
  });

  it("after answering, may look at the owner's choices for the style guide: at most once a day", async () => {
    afterTasks.length = 0;
    const res = await heartbeat(new Request("http://test", {
      method: "POST", headers: { ...auth, "Content-Type": "application/json" }, body: JSON.stringify({ kinds: [] }),
    }));
    expect(res.status).toBe(200);
    expect(afterTasks).toHaveLength(1);
    await afterTasks[0]!();
    const { getSetting } = await import("@/lib/settings");
    expect(await getSetting(state.db as never, "styleLearnCheckedAt")).toBeTruthy();
  });
});
