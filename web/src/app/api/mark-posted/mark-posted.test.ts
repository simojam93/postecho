import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb } from "@/test/db";
import { drafts, scheduledPosts } from "@/db/schema";

const state: { db: Awaited<ReturnType<typeof createTestDb>> | null } = { db: null };
vi.mock("@/db", () => ({ get db() { return state.db; } }));
const deleteMessage = vi.fn(async () => {});
vi.mock("@/lib/qstash", async (orig) => ({
  ...(await orig()),
  getQstash: () => ({ enabled: true, scheduleMessage: async () => "msg", deleteMessage }),
}));
vi.stubEnv("SESSION_SECRET", "test-secret-test-secret-test-secret!");
vi.stubEnv("PUBLIC_BASE_URL", "https://app.test");

const { GET, POST } = await import("@/app/api/mark-posted/route");
const { markPostedSig, markPostedUrl } = await import("@/lib/publishers");

const UNKNOWN_ID = "00000000-0000-0000-0000-000000000000";

beforeEach(async () => {
  state.db = await createTestDb();
  deleteMessage.mockClear();
});

async function insertRow(values: Partial<typeof scheduledPosts.$inferInsert> = {}) {
  const [draft] = await state.db!.insert(drafts).values({ xText: "X take", status: "used" }).returning();
  const [row] = await state.db!.insert(scheduledPosts).values({
    draftId: draft.id, platform: "x", text: "X take", publishAt: new Date("2030-01-15T16:00:00Z"), status: "emailed", ...values,
  }).returning();
  return row;
}

const rowById = async (id: string) => (await state.db!.select().from(scheduledPosts).where(eq(scheduledPosts.id, id)))[0];
const get = (url: string) => GET(new Request(url));
const post = (body: unknown) => POST(new Request("https://app.test/api/mark-posted", {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
}));

describe("GET /api/mark-posted (link from the email: no side effects)", () => {
  it("404s a missing, malformed or forged signature — the row is untouched", async () => {
    const row = await insertRow();
    expect((await get(`https://app.test/api/mark-posted?id=${row.id}`)).status).toBe(404);
    expect((await get(`https://app.test/api/mark-posted?id=${row.id}&sig=nope`)).status).toBe(404);
    const other = markPostedSig(UNKNOWN_ID)!;
    expect((await get(`https://app.test/api/mark-posted?id=${row.id}&sig=${other}`)).status).toBe(404);
    expect((await get(`https://app.test/api/mark-posted?id=not-a-uuid&sig=${other}`)).status).toBe(404);
    expect((await rowById(row.id)).status).toBe("emailed");
  });

  it("302s a well-signed link to the confirmation page WITHOUT changing the row (mail scanners prefetch links)", async () => {
    const row = await insertRow({ status: "queued", externalId: "msg_1" });
    const sig = markPostedSig(row.id)!;
    const res = await get(markPostedUrl(row.id));
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(`https://app.test/mark-posted?id=${row.id}&sig=${sig}`);
    expect((await rowById(row.id)).status).toBe("queued");
    expect(deleteMessage).not.toHaveBeenCalled();
  });

  it("redirects relative to the host the link was opened on", async () => {
    const row = await insertRow();
    const sig = markPostedSig(row.id)!;
    const res = await get(`http://localhost:3210/api/mark-posted?id=${row.id}&sig=${sig}`);
    expect(res.headers.get("location")).toBe(`http://localhost:3210/mark-posted?id=${row.id}&sig=${sig}`);
  });
});

describe("POST /api/mark-posted (the confirm button)", () => {
  it("404s a bad body, a forged signature or an unknown id — nothing changes", async () => {
    const row = await insertRow();
    expect((await post({})).status).toBe(404);
    expect((await post({ id: row.id, sig: "nope" })).status).toBe(404);
    expect((await post({ id: row.id, sig: markPostedSig(UNKNOWN_ID) })).status).toBe(404);
    expect((await post({ id: UNKNOWN_ID, sig: markPostedSig(UNKNOWN_ID) })).status).toBe(404);
    expect((await rowById(row.id)).status).toBe("emailed");
  });

  it("marks the row posted_manually, cancels its timer and answers ok", async () => {
    const row = await insertRow({ status: "queued", externalId: "msg_1" });
    const before = Date.now();
    const res = await post({ id: row.id, sig: markPostedSig(row.id) });
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);
    const updated = await rowById(row.id);
    expect(updated).toMatchObject({ status: "posted_manually", postedBy: "manual" });
    expect(updated.publishedAt!.getTime()).toBeGreaterThanOrEqual(before - 1000);
    expect(deleteMessage).toHaveBeenCalledWith("msg_1");
  });

  it("is idempotent: confirmed twice, still ok, no second cancel", async () => {
    const row = await insertRow({ externalId: "msg_1" });
    expect((await post({ id: row.id, sig: markPostedSig(row.id) })).status).toBe(200);
    expect((await post({ id: row.id, sig: markPostedSig(row.id) })).status).toBe(200);
    expect(deleteMessage).toHaveBeenCalledTimes(1);
    expect((await rowById(row.id)).status).toBe("posted_manually");
  });
});
