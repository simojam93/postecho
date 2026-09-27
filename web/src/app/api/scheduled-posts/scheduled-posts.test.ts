import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb } from "@/test/db";
import { drafts, ideas, scheduledPosts } from "@/db/schema";
import { setSetting } from "@/lib/settings";

const state: { db: Awaited<ReturnType<typeof createTestDb>> | null } = { db: null };
vi.mock("@/db", () => ({ get db() { return state.db; } }));
vi.mock("@/lib/session", async (orig) => ({
  ...(await orig()),
  requireSession: vi.fn(async () => null),
}));
// /run publishes for real (lib/publishers/run.ts) — only the provider is faked.
vi.mock("@/lib/email", async (orig) => ({
  ...(await orig()),
  sendMail: vi.fn(async () => ({ sent: true, id: "em_test" })),
}));
// The vote's kind backfill runs after the response (next/server's after): run it at once, faked.
vi.mock("next/server", async (orig) => ({ ...(await orig()), after: vi.fn((task: () => unknown) => { void task(); }) }));
vi.mock("@/lib/idea-kind", () => ({ backfillIdeaKind: vi.fn(async () => {}) }));
vi.stubEnv("SESSION_SECRET", "test-secret-test-secret-test-secret!");

const { GET, POST } = await import("@/app/api/scheduled-posts/route");
const { DELETE, PATCH } = await import("@/app/api/scheduled-posts/[id]/route");
const { POST: run } = await import("@/app/api/scheduled-posts/[id]/run/route");
const { GET: getSlots } = await import("@/app/api/scheduled-posts/slots/route");
const { POST: markPosted } = await import("@/app/api/scheduled-posts/mark-posted/route");

const UNKNOWN_ID = "00000000-0000-0000-0000-000000000000";
const FUTURE = "2030-01-01T16:00:00.000Z";

beforeEach(async () => {
  state.db = await createTestDb();
  const { requireSession } = await import("@/lib/session");
  const mock = requireSession as unknown as ReturnType<typeof vi.fn>;
  mock.mockReset();
  mock.mockResolvedValue(null);
});

function denySession() {
  return import("@/lib/session").then(({ requireSession }) => {
    (requireSession as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      Response.json({ error: "unauthorized" }, { status: 401 }),
    );
  });
}

function jsonReq(url: string, method: string, body?: unknown) {
  return new Request(url, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

const listReq = (qs = "") => new Request(`http://test/api/scheduled-posts${qs}`);
const createReq = (body: unknown) => jsonReq("http://test/api/scheduled-posts", "POST", body);
const params = (id: string) => ({ params: Promise.resolve({ id }) });
const del = (id: string) => DELETE(new Request(`http://test/api/scheduled-posts/${id}`, { method: "DELETE" }), params(id));
const slotsReq = (qs: string) => getSlots(new Request(`http://test/api/scheduled-posts/slots${qs}`));
const markReq = (body: unknown) => markPosted(jsonReq("http://test/api/scheduled-posts/mark-posted", "POST", body));

async function insertDraft(values: Partial<typeof drafts.$inferInsert> = { xText: "hello", linkedinText: "hello there" }) {
  const [draft] = await state.db!.insert(drafts).values(values).returning();
  return draft;
}

describe("GET /api/scheduled-posts", () => {
  it("401s when the session is denied", async () => {
    await denySession();
    expect((await GET(listReq())).status).toBe(401);
  });

  it("lists the queue soonest first, joined with the draft texts and idea title", async () => {
    const [idea] = await state.db!.insert(ideas).values({ kind: "note", content: "seed", title: "A talk" }).returning();
    const draft = await insertDraft({ ideaId: idea.id, xText: "x text", linkedinText: "li text" });
    await state.db!.insert(scheduledPosts).values([
      { draftId: draft.id, platform: "linkedin", text: "li text", publishAt: new Date("2030-01-02T08:00:00Z") },
      { draftId: draft.id, platform: "x", text: "x text", publishAt: new Date(FUTURE) },
    ]);

    const res = await GET(listReq());
    expect(res.status).toBe(200);
    const { posts } = await res.json();
    expect(posts).toHaveLength(2);
    expect(posts[0]).toMatchObject({
      draftId: draft.id, platform: "x", text: "x text", status: "queued", publishAt: FUTURE,
      xText: "x text", linkedinText: "li text", ideaTitle: "A talk",
    });
    expect(posts[1].platform).toBe("linkedin");
  });

  it("filters by from (inclusive), to (exclusive) and status", async () => {
    const draft = await insertDraft();
    await state.db!.insert(scheduledPosts).values([
      { draftId: draft.id, platform: "x", text: "hello", publishAt: new Date("2030-01-01T00:00:00Z"), status: "published" },
      { draftId: draft.id, platform: "x", text: "hello", publishAt: new Date("2030-01-15T12:00:00Z") },
      { draftId: draft.id, platform: "x", text: "hello", publishAt: new Date("2030-02-01T00:00:00Z"), status: "canceled" },
    ]);
    const january = await (await GET(listReq("?from=2030-01-01T00:00:00Z&to=2030-02-01T00:00:00Z"))).json();
    expect(january.posts.map((p: { status: string }) => p.status)).toEqual(["published", "queued"]);
    const queued = await (await GET(listReq("?status=queued"))).json();
    expect(queued.posts).toHaveLength(1);
  });

  it("400s on an invalid from, to or status", async () => {
    expect((await GET(listReq("?from=yesterday"))).status).toBe(400);
    expect((await GET(listReq("?to=garbage"))).status).toBe(400);
    expect((await GET(listReq("?status=cancelled"))).status).toBe(400);
  });
});

describe("POST /api/scheduled-posts", () => {
  it("401s when the session is denied", async () => {
    await denySession();
    expect((await POST(createReq({ draftId: UNKNOWN_ID, platform: "x", publishAt: FUTURE }))).status).toBe(401);
  });

  it("400s on a malformed body", async () => {
    const draft = await insertDraft();
    expect((await POST(createReq({}))).status).toBe(400);
    expect((await POST(createReq({ draftId: "not-a-uuid", platform: "x", publishAt: FUTURE }))).status).toBe(400);
    expect((await POST(createReq({ draftId: draft.id, platform: "threads", publishAt: FUTURE }))).status).toBe(400);
    expect((await POST(createReq({ draftId: draft.id, platform: "x", publishAt: "next tuesday" }))).status).toBe(400);
    expect((await POST(createReq({ draftId: draft.id, platform: "x", publishAt: FUTURE, extra: 1 }))).status).toBe(400);
    expect((await POST(new Request("http://test/api/scheduled-posts", { method: "POST", body: "not json" }))).status).toBe(400);
  });

  it("201s with the queued row and marks the draft used", async () => {
    const draft = await insertDraft({ xText: "hello", status: "kept" });
    const res = await POST(createReq({ draftId: draft.id, platform: "x", publishAt: FUTURE }));
    expect(res.status).toBe(201);
    const { post } = await res.json();
    expect(post).toMatchObject({ draftId: draft.id, platform: "x", text: "hello", status: "queued", publishAt: FUTURE });
    const [used] = await state.db!.select().from(drafts).where(eq(drafts.id, draft.id));
    expect(used.status).toBe("used");
  });

  it("accepts a browser-local datetime string too", async () => {
    const draft = await insertDraft();
    // What datetime-local would produce if the client didn't normalize; Date parses it as server-local time.
    const res = await POST(createReq({ draftId: draft.id, platform: "x", publishAt: "2030-01-01T17:00" }));
    expect(res.status).toBe(201);
  });

  it("404s for an unknown draft", async () => {
    const res = await POST(createReq({ draftId: UNKNOWN_ID, platform: "x", publishAt: FUTURE }));
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ code: "draft_not_found" });
  });

  it("400s with a code when the text is missing, too long, or the time is in the past", async () => {
    const linkedinOnly = await insertDraft({ linkedinText: "only linkedin" });
    const noText = await POST(createReq({ draftId: linkedinOnly.id, platform: "x", publishAt: FUTURE }));
    expect(noText.status).toBe(400);
    expect(await noText.json()).toMatchObject({ code: "no_text" });

    const long = await insertDraft({ xText: "x".repeat(281) });
    const tooLong = await POST(createReq({ draftId: long.id, platform: "x", publishAt: FUTURE }));
    expect(tooLong.status).toBe(400);
    expect(await tooLong.json()).toMatchObject({ code: "too_long" });

    const past = await POST(createReq({ draftId: long.id, platform: "linkedin", publishAt: "2020-01-01T00:00:00Z" }));
    expect(past.status).toBe(400);
    expect(await past.json()).toMatchObject({ code: "in_past" });
  });

  it("409s when the draft is already queued for that platform", async () => {
    const draft = await insertDraft();
    expect((await POST(createReq({ draftId: draft.id, platform: "x", publishAt: FUTURE }))).status).toBe(201);
    const res = await POST(createReq({ draftId: draft.id, platform: "x", publishAt: "2030-01-02T16:00:00Z" }));
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: "conflict" });
    // The other platform is a separate queue.
    expect((await POST(createReq({ draftId: draft.id, platform: "linkedin", publishAt: FUTURE }))).status).toBe(201);
  });
});

describe("DELETE /api/scheduled-posts/:id", () => {
  it("401s when the session is denied", async () => {
    await denySession();
    expect((await del(UNKNOWN_ID)).status).toBe(401);
  });

  it("404s for a malformed or unknown id", async () => {
    expect((await del("not-a-uuid")).status).toBe(404);
    expect((await del(UNKNOWN_ID)).status).toBe(404);
  });

  it("cancels a queued row and is idempotent", async () => {
    const draft = await insertDraft();
    const created = await (await POST(createReq({ draftId: draft.id, platform: "x", publishAt: FUTURE }))).json();
    const res = await del(created.post.id);
    expect(res.status).toBe(200);
    expect((await res.json()).post).toMatchObject({ id: created.post.id, status: "canceled" });
    const again = await del(created.post.id);
    expect(again.status).toBe(200);
    expect((await again.json()).post.status).toBe("canceled");
  });
});

describe("GET /api/scheduled-posts/slots", () => {
  it("401s when the session is denied", async () => {
    await denySession();
    expect((await slotsReq("?platform=x")).status).toBe(401);
  });

  it("400s on a missing/unknown platform or an out-of-range days", async () => {
    expect((await slotsReq("")).status).toBe(400);
    expect((await slotsReq("?platform=threads")).status).toBe(400);
    expect((await slotsReq("?platform=x&days=0")).status).toBe(400);
    expect((await slotsReq("?platform=x&days=32")).status).toBe(400);
    expect((await slotsReq("?platform=x&days=soon")).status).toBe(400);
  });

  it("returns the next free default slots as future UTC ISO strings", async () => {
    const before = Date.now();
    const res = await slotsReq("?platform=x");
    expect(res.status).toBe(200);
    const { slots } = await res.json();
    expect(slots.length).toBeGreaterThanOrEqual(12);
    for (const slot of slots) {
      expect(slot).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
      expect(new Date(slot).getTime()).toBeGreaterThan(before);
    }
    const { slots: oneDay } = await (await slotsReq("?platform=linkedin&days=1")).json();
    expect(oneDay.length).toBeLessThanOrEqual(1);
  });

  it("never proposes a slot for today (Europe/Rome): the first suggestion is on tomorrow's date or later", async () => {
    const { wallClockOf } = await import("@/lib/schedule");
    const today = wallClockOf(new Date());
    const todayKey = today.year * 10_000 + today.month * 100 + today.day;
    const { slots } = await (await slotsReq("?platform=x&days=3")).json();
    expect(slots.length).toBeGreaterThan(0);
    for (const slot of slots) {
      const wall = wallClockOf(new Date(slot));
      expect(wall.year * 10_000 + wall.month * 100 + wall.day).toBeGreaterThan(todayKey);
    }
  });

  it("leaves out a slot that is already taken", async () => {
    const draft = await insertDraft();
    const { slots } = await (await slotsReq("?platform=x")).json();
    expect((await POST(createReq({ draftId: draft.id, platform: "x", publishAt: slots[0] }))).status).toBe(201);
    const { slots: after } = await (await slotsReq("?platform=x")).json();
    expect(after).toEqual(slots.slice(1));
  });
});

describe("POST /api/scheduled-posts/mark-posted", () => {
  it("with a time ahead, records it as scheduled on the platform itself; a time already past is refused (2026-09-24)", async () => {
    const draft = await insertDraft({ xText: "scheduled on X itself" });
    const at = new Date(Date.now() + 26 * 3_600_000).toISOString();
    const res = await markReq({ draftId: draft.id, platform: "x", publishAt: at });
    expect(res.status).toBe(201);
    const { post } = await res.json();
    expect(post).toMatchObject({ platform: "x", status: "posted_manually", publishAt: at, publishedAt: at, externalId: null });

    const other = await insertDraft({ xText: "too late" });
    const past = await markReq({ draftId: other.id, platform: "x", publishAt: new Date(Date.now() - 10 * 60_000).toISOString() });
    expect(past.status).toBe(400);
    expect(await past.json()).toMatchObject({ code: "in_past" });
  });

  it("401s when the session is denied", async () => {
    await denySession();
    expect((await markReq({ draftId: UNKNOWN_ID })).status).toBe(401);
  });

  it("400s on a malformed body", async () => {
    expect((await markReq({})).status).toBe(400);
    expect((await markReq({ draftId: "nope" })).status).toBe(400);
    expect((await markReq({ draftId: UNKNOWN_ID, platform: "threads" })).status).toBe(400);
  });

  it("404s for an unknown draft and 400s for one without X text", async () => {
    expect((await markReq({ draftId: UNKNOWN_ID })).status).toBe(404);
    const linkedinOnly = await insertDraft({ linkedinText: "only linkedin" });
    const res = await markReq({ draftId: linkedinOnly.id });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: "no_text" });
  });

  it("201s with a posted_manually LinkedIn row when platform is linkedin", async () => {
    const draft = await insertDraft({ linkedinText: "posted on linkedin by hand" });
    const res = await markReq({ draftId: draft.id, platform: "linkedin" });
    expect(res.status).toBe(201);
    const { post } = await res.json();
    expect(post).toMatchObject({ draftId: draft.id, platform: "linkedin", text: "posted on linkedin by hand", status: "posted_manually", postedBy: "manual" });
    // No X text on this draft: asking for X is still a 400.
    expect((await markReq({ draftId: draft.id, platform: "x" })).status).toBe(400);
  });

  it("201s with a posted_manually X row and marks the draft used", async () => {
    const draft = await insertDraft({ xText: "posted by hand", status: "kept" });
    const res = await markReq({ draftId: draft.id });
    expect(res.status).toBe(201);
    const { post } = await res.json();
    expect(post).toMatchObject({ draftId: draft.id, platform: "x", text: "posted by hand", status: "posted_manually", postedBy: "manual" });
    expect(typeof post.publishedAt).toBe("string");
    const [used] = await state.db!.select().from(drafts).where(eq(drafts.id, draft.id));
    expect(used.status).toBe("used");
  });
});

describe("POST /api/scheduled-posts/:id/run", () => {
  it("401s when the session is denied", async () => {
    await denySession();
    expect((await run(jsonReq("http://test", "POST"), params(UNKNOWN_ID))).status).toBe(401);
  });

  it("404s a malformed id", async () => {
    expect((await run(jsonReq("http://test", "POST"), params("not-a-uuid"))).status).toBe(404);
  });

  it("404s an unknown id", async () => {
    expect((await run(jsonReq("http://test", "POST"), params(UNKNOWN_ID))).status).toBe(404);
  });

  it("runs a queued row by hand — the due email goes out and the row becomes emailed; running again is a resend", async () => {
    await setSetting(state.db!, "notificationEmail", "owner@example.com");
    const draft = await insertDraft();
    const created = await (await POST(createReq({ draftId: draft.id, platform: "x", publishAt: FUTURE }))).json();

    const res = await run(jsonReq("http://test", "POST"), params(created.post.id));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.post).toMatchObject({ id: created.post.id, status: "emailed" });
    expect(body.emailed).toEqual([created.post.id]);
    expect(body.sent).toBe(true);

    const again = await run(jsonReq("http://test", "POST"), params(created.post.id));
    expect(again.status).toBe(200);
    expect((await again.json()).post.status).toBe("emailed");
  });
});

describe("PATCH /api/scheduled-posts/:id — How did it do? (2026-09-26)", () => {
  const patch = (id: string, body: unknown) => PATCH(jsonReq(`http://test/api/scheduled-posts/${id}`, "PATCH", body), params(id));
  async function outRow() {
    const draft = await insertDraft();
    const hourAgo = new Date(Date.now() - 3_600_000);
    const [row] = await state.db!.insert(scheduledPosts).values({
      draftId: draft.id, platform: "x", text: "hello", status: "posted_manually", postedBy: "manual", publishAt: hourAgo, publishedAt: hourAgo,
    }).returning();
    return row;
  }

  it("saves a vote, asks for the idea's kind after the response, and takes the vote back", async () => {
    const { backfillIdeaKind } = await import("@/lib/idea-kind");
    const row = await outRow();
    const res = await patch(row.id, { outcome: "good" });
    expect(res.status).toBe(200);
    expect((await res.json()).post).toMatchObject({ outcome: "good" });
    expect(backfillIdeaKind).toHaveBeenCalledWith(expect.anything(), row.draftId);
    const cleared = await patch(row.id, { outcome: null });
    expect((await cleared.json()).post).toMatchObject({ outcome: null, ratedAt: null });
  });

  it("409 for a post that isn't out; 400 for a bad vote or one mixed with an edit; 404 for an unknown id", async () => {
    const draft = await insertDraft();
    const [queued] = await state.db!.insert(scheduledPosts).values({ draftId: draft.id, platform: "x", text: "hello", publishAt: new Date(FUTURE) }).returning();
    expect((await patch(queued.id, { outcome: "good" })).status).toBe(409);
    const row = await outRow();
    expect((await patch(row.id, { outcome: "meh" })).status).toBe(400);
    expect((await patch(row.id, { outcome: "good", text: "x" })).status).toBe(400);
    expect((await patch(UNKNOWN_ID, { outcome: "good" })).status).toBe(404);
  });
});

describe("GET /api/scheduled-posts?toRate=1 (2026-09-26)", () => {
  it("lists the posts out for more than a day with no vote", async () => {
    const draft = await insertDraft();
    const dayAgo = new Date(Date.now() - 30 * 3_600_000);
    const [row] = await state.db!.insert(scheduledPosts).values({
      draftId: draft.id, platform: "x", text: "hello", status: "posted_manually", postedBy: "manual", publishAt: dayAgo, publishedAt: dayAgo,
    }).returning();
    const body = await (await GET(listReq("?toRate=1"))).json();
    expect(body.posts.map((p: { id: string }) => p.id)).toEqual([row.id]);
  });
});
