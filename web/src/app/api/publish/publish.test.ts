import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb } from "@/test/db";
import { drafts, scheduledPosts } from "@/db/schema";
import { setSetting } from "@/lib/settings";

const state: { db: Awaited<ReturnType<typeof createTestDb>> | null } = { db: null };
vi.mock("@/db", () => ({ get db() { return state.db; } }));
vi.mock("@/lib/session", async (orig) => ({
  ...(await orig()),
  requireSession: vi.fn(async () => null),
}));
vi.mock("@/lib/qstash", async (orig) => ({
  ...(await orig()),
  verifyQstashSignature: vi.fn(async () => false),
}));
vi.mock("@/lib/email", async (orig) => ({
  ...(await orig()),
  sendMail: vi.fn(async () => ({ sent: true, id: "em_1" })),
}));
vi.stubEnv("SESSION_SECRET", "test-secret-test-secret-test-secret!");
vi.stubEnv("PUBLIC_BASE_URL", "https://app.test");

const { POST } = await import("@/app/api/publish/[id]/route");
const { requireSession } = await import("@/lib/session");
const { verifyQstashSignature } = await import("@/lib/qstash");
const { sendMail } = await import("@/lib/email");
const { MailError } = await import("@/lib/email");

type Mock = ReturnType<typeof vi.fn>;
const sessionMock = requireSession as unknown as Mock;
const verifyMock = verifyQstashSignature as unknown as Mock;
const sendMock = sendMail as unknown as Mock;

const UNKNOWN_ID = "00000000-0000-0000-0000-000000000000";
const SLOT = new Date("2030-01-15T16:00:00.000Z");

beforeEach(async () => {
  state.db = await createTestDb();
  await setSetting(state.db, "notificationEmail", "owner@example.com");
  sessionMock.mockReset();
  sessionMock.mockResolvedValue(null);
  verifyMock.mockReset();
  verifyMock.mockResolvedValue(false);
  sendMock.mockReset();
  sendMock.mockResolvedValue({ sent: true, id: "em_1" });
});

const params = (id: string) => ({ params: Promise.resolve({ id }) });

/** What QStash sends: the JSON body we published, plus its signature header. */
function signedReq(id: string, signature = "sig") {
  return new Request(`https://app.test/api/publish/${id}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Upstash-Signature": signature },
    body: JSON.stringify({ id }),
  });
}
const sessionReq = (id: string) => new Request(`http://test/api/publish/${id}`, { method: "POST" });

async function insertQueued(platform: "x" | "linkedin" = "x", publishAt = SLOT) {
  const [draft] = await state.db!.insert(drafts).values({ xText: "X take", linkedinText: "LinkedIn take", status: "used" }).returning();
  const [row] = await state.db!.insert(scheduledPosts).values({
    draftId: draft.id, platform, text: platform === "x" ? "X take" : "LinkedIn take", publishAt,
  }).returning();
  return row;
}

const rowById = async (id: string) => (await state.db!.select().from(scheduledPosts).where(eq(scheduledPosts.id, id)))[0];

describe("POST /api/publish/:id — auth", () => {
  it("401s a delivery whose signature doesn't verify, without consulting the session", async () => {
    const row = await insertQueued();
    const res = await POST(signedReq(row.id), params(row.id));
    expect(res.status).toBe(401);
    expect(verifyMock).toHaveBeenCalledTimes(1);
    expect(sessionMock).not.toHaveBeenCalled();
    expect((await rowById(row.id)).status).toBe("queued");
  });

  it("401s a bare call when the session is denied", async () => {
    sessionMock.mockResolvedValueOnce(Response.json({ error: "unauthorized" }, { status: 401 }));
    const row = await insertQueued();
    expect((await POST(sessionReq(row.id), params(row.id))).status).toBe(401);
    expect(verifyMock).not.toHaveBeenCalled();
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("verifies the signature against the raw body and the url the message was published to", async () => {
    const row = await insertQueued();
    verifyMock.mockResolvedValueOnce(true);
    const res = await POST(signedReq(row.id, "the-jwt"), params(row.id));
    expect(res.status).toBe(200);
    expect(verifyMock).toHaveBeenCalledWith({
      signature: "the-jwt", body: JSON.stringify({ id: row.id }), url: `https://app.test/api/publish/${row.id}`,
    });
  });

  it("404s a malformed id on both paths, and an unknown id", async () => {
    expect((await POST(sessionReq("nope"), params("nope"))).status).toBe(404);
    // A signature can't verify for a malformed id (there is no url it could have been published to) → 401, not 404.
    expect((await POST(signedReq("nope"), params("nope"))).status).toBe(401);
    expect(verifyMock).not.toHaveBeenCalled();
    expect((await POST(sessionReq(UNKNOWN_ID), params(UNKNOWN_ID))).status).toBe(404);
    verifyMock.mockResolvedValueOnce(true);
    expect((await POST(signedReq(UNKNOWN_ID), params(UNKNOWN_ID))).status).toBe(404);
  });
});

describe("POST /api/publish/:id — publishing", () => {
  it("timer path: emails the queued row and marks it emailed", async () => {
    const row = await insertQueued();
    verifyMock.mockResolvedValueOnce(true);
    const res = await POST(signedReq(row.id), params(row.id));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ post: { id: row.id, status: "emailed" }, emailed: [row.id], sent: true });
    expect(sendMock).toHaveBeenCalledTimes(1);
    const message = sendMock.mock.calls[0][0] as { to: string; subject: string };
    expect(message.to).toBe("owner@example.com");
    expect(message.subject).toBe('Post at 17:00 · X · "X take"');
  });

  it("is idempotent on the timer path: a second delivery is a 200 no-op, and no second email", async () => {
    const row = await insertQueued();
    verifyMock.mockResolvedValue(true);
    await POST(signedReq(row.id), params(row.id));
    const again = await POST(signedReq(row.id), params(row.id));
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({ skipped: true, post: { id: row.id, status: "emailed" } });
    expect(sendMock).toHaveBeenCalledTimes(1);
  });

  it("session path is a resend: an emailed row goes out again", async () => {
    const row = await insertQueued();
    verifyMock.mockResolvedValueOnce(true);
    await POST(signedReq(row.id), params(row.id));
    const res = await POST(sessionReq(row.id), params(row.id));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ post: { id: row.id, status: "emailed" }, emailed: [row.id] });
    expect(sendMock).toHaveBeenCalledTimes(2);
  });

  it("one email for X and LinkedIn in the same slot", async () => {
    const x = await insertQueued("x");
    const li = await insertQueued("linkedin", new Date(SLOT.getTime() + 20_000));
    const res = await POST(sessionReq(x.id), params(x.id));
    const body = await res.json();
    expect(body.emailed).toEqual([x.id, li.id]);
    expect(sendMock).toHaveBeenCalledTimes(1);
    expect((sendMock.mock.calls[0][0] as { subject: string }).subject).toBe('Post at 17:00 · X + LinkedIn · "X take"');
    expect((await rowById(li.id)).status).toBe("emailed");
  });

  it("records a failure on the row and still answers 200 so QStash doesn't retry", async () => {
    const row = await insertQueued();
    verifyMock.mockResolvedValueOnce(true);
    sendMock.mockRejectedValueOnce(new MailError("resend: You can only send testing emails to your own email address"));
    const res = await POST(signedReq(row.id), params(row.id));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ post: { id: row.id, status: "failed" }, error: expect.stringContaining("own email address") });
    expect(await rowById(row.id)).toMatchObject({ status: "failed", error: expect.stringContaining("resend:") });
  });
});
