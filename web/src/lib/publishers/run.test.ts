import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb } from "@/test/db";
import { drafts, scheduledPosts } from "@/db/schema";
import { MailError, type MailMessage } from "@/lib/email";
import { loadSharePageRow, markPostedById, publishDue, publishOutcomeResponse, SAME_SLOT_WINDOW_MS } from "@/lib/publishers/run";
import { setSetting } from "@/lib/settings";

vi.stubEnv("SESSION_SECRET", "test-secret-test-secret-test-secret!");
vi.stubEnv("PUBLIC_BASE_URL", "https://app.test");

type Db = Awaited<ReturnType<typeof createTestDb>>;
const UNKNOWN_ID = "00000000-0000-0000-0000-000000000000";
// 16:00Z on a January day: 17:00 in Rome (CET).
const SLOT = new Date("2030-01-15T16:00:00.000Z");

let db: Db;
let sent: MailMessage[];
const sendMail = vi.fn(async (message: MailMessage) => {
  sent.push(message);
  return { sent: true as const, id: `em_${sent.length}` };
});

beforeEach(async () => {
  db = await createTestDb();
  sent = [];
  sendMail.mockClear();
  await setSetting(db, "notificationEmail", "owner@example.com");
});

async function seedDraft() {
  const [draft] = await db.insert(drafts).values({ xText: "X take", linkedinText: "LinkedIn take", status: "used" }).returning();
  return draft;
}

/** A row on its own fresh draft unless `draftId` is given — the partial unique index allows one QUEUED row per (draft, platform). */
async function insertRow(values: Partial<typeof scheduledPosts.$inferInsert> = {}) {
  const draftId = values.draftId ?? (await seedDraft()).id;
  const [row] = await db.insert(scheduledPosts).values({
    platform: "x", text: "X take", publishAt: SLOT, ...values, draftId,
  }).returning();
  return row;
}

const rowById = async (id: string) => (await db.select().from(scheduledPosts).where(eq(scheduledPosts.id, id)))[0];

describe("publishDue", () => {
  it("is not_found for an unknown id", async () => {
    expect(await publishDue(db, UNKNOWN_ID, {}, { sendMail })).toEqual({ kind: "not_found" });
    expect(sendMail).not.toHaveBeenCalled();
  });

  it("emails one queued X row: subject, buttons, mark links; the row becomes emailed", async () => {
    const row = await insertRow({});
    const now = new Date("2030-01-15T15:55:00Z");

    const outcome = await publishDue(db, row.id, { mode: "due" }, { sendMail, now });
    expect(outcome.kind).toBe("emailed");
    if (outcome.kind !== "emailed") return;
    expect(outcome.post).toMatchObject({ id: row.id, status: "emailed", emailedAt: now, error: null });
    expect(outcome.posts.map((p) => p.id)).toEqual([row.id]);
    expect(outcome.mail).toEqual({ sent: true, id: "em_1" });

    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe("owner@example.com");
    expect(sent[0].subject).toBe('Post at 17:00 · X · "X take"');
    // The button opens the row's signed share page, never the composer straight from the email.
    expect(sent[0].text).toMatch(new RegExp(`Post on X:\\nhttps://app\\.test/post/${row.id}\\?sig=[0-9a-f]{64}`));
    expect(sent[0].html).toMatch(new RegExp(`href="https://app\\.test/post/${row.id}\\?sig=[0-9a-f]{64}"`));
    expect(sent[0].text).not.toContain("x.com/intent");
    expect(sent[0].html).not.toContain("x.com/intent");
    expect(sent[0].text).toMatch(new RegExp(`https://app\\.test/api/mark-posted\\?id=${row.id}&sig=[0-9a-f]{64}`));
    expect(sent[0].html).toContain("Post on X");
    expect(await rowById(row.id)).toMatchObject({ status: "emailed", emailedAt: now });
  });

  it("sends ONE email for X and LinkedIn due in the same slot (X first), leaving a row two minutes away alone", async () => {
    const li = await insertRow({ platform: "linkedin", text: "LinkedIn take", publishAt: new Date(SLOT.getTime() + 30_000) });
    const x = await insertRow({});
    // The window is ±60s around the TARGET row (li, at +30s): +120s is 90s from it — out.
    const later = await insertRow({ publishAt: new Date(SLOT.getTime() + 2 * SAME_SLOT_WINDOW_MS) });
    // A canceled row in the slot never rides along.
    const canceled = await insertRow({ status: "canceled" });

    const outcome = await publishDue(db, li.id, {}, { sendMail });
    expect(outcome.kind).toBe("emailed");
    if (outcome.kind !== "emailed") return;
    expect(outcome.post.id).toBe(li.id);
    expect(outcome.posts.map((p) => p.id)).toEqual([x.id, li.id]);

    expect(sent).toHaveLength(1);
    expect(sent[0].subject).toBe('Post at 17:00 · X + LinkedIn · "X take"');
    expect(sent[0].text.indexOf("── X ──")).toBeLessThan(sent[0].text.indexOf("── LinkedIn ──"));
    expect(sent[0].text).toMatch(new RegExp(`Post on LinkedIn:\\nhttps://app\\.test/post/${li.id}\\?sig=[0-9a-f]{64}`));
    expect(sent[0].text).not.toContain("linkedin.com/feed");
    expect((await rowById(x.id)).status).toBe("emailed");
    expect((await rowById(li.id)).status).toBe("emailed");
    expect((await rowById(later.id)).status).toBe("queued");
    expect((await rowById(canceled.id)).status).toBe("canceled");
  });

  it("skips a row that isn't actionable in its mode — due: anything but queued; resend: canceled/posted", async () => {
    const emailed = await insertRow({ status: "emailed" });
    expect(await publishDue(db, emailed.id, { mode: "due" }, { sendMail })).toMatchObject({ kind: "skipped", post: { id: emailed.id, status: "emailed" } });
    const canceled = await insertRow({ status: "canceled" });
    expect((await publishDue(db, canceled.id, { mode: "resend" }, { sendMail })).kind).toBe("skipped");
    const posted = await insertRow({ status: "posted_manually" });
    expect((await publishDue(db, posted.id, { mode: "resend" }, { sendMail })).kind).toBe("skipped");
    expect(sendMail).not.toHaveBeenCalled();
  });

  it("resend: an emailed or failed row goes out again and is stamped anew", async () => {
    const first = new Date("2030-01-15T15:50:00Z");
    const emailed = await insertRow({ status: "emailed", emailedAt: first });
    const failed = await insertRow({ platform: "linkedin", text: "LinkedIn take", status: "failed", error: "boom", publishAt: new Date("2030-01-16T08:00:00Z") });

    const again = new Date("2030-01-15T15:58:00Z");
    const one = await publishDue(db, emailed.id, { mode: "resend" }, { sendMail, now: again });
    expect(one).toMatchObject({ kind: "emailed", post: { id: emailed.id, status: "emailed", emailedAt: again } });
    const two = await publishDue(db, failed.id, { mode: "resend" }, { sendMail, now: again });
    expect(two).toMatchObject({ kind: "emailed", post: { id: failed.id, status: "emailed", error: null } });
    expect(sent).toHaveLength(2);
  });

  it("a send failure marks the whole batch failed with the provider's message — and reports it, no throw", async () => {
    const x = await insertRow({});
    const li = await insertRow({ platform: "linkedin", text: "LinkedIn take" });
    const later = await insertRow({ publishAt: new Date(SLOT.getTime() + 300_000) });
    sendMail.mockRejectedValueOnce(new MailError("resend: You can only send testing emails to your own email address"));

    const outcome = await publishDue(db, x.id, {}, { sendMail });
    expect(outcome).toMatchObject({ kind: "failed", error: expect.stringContaining("own email address"), post: { id: x.id, status: "failed" } });
    expect(await rowById(li.id)).toMatchObject({ status: "failed", error: expect.stringContaining("resend:") });
    expect((await rowById(later.id)).status).toBe("queued");
  });

  it("fails the row when notificationEmail is not set", async () => {
    await setSetting(db, "notificationEmail", "   ");
    const row = await insertRow({});
    const outcome = await publishDue(db, row.id, {}, { sendMail });
    expect(outcome).toMatchObject({ kind: "failed", error: expect.stringContaining("notificationEmail"), post: { status: "failed" } });
    expect(sendMail).not.toHaveBeenCalled();
  });

  it("counts a logged-not-sent email (no RESEND_API_KEY) as emailed, reporting sent: false", async () => {
    const row = await insertRow({});
    const logOnly = vi.fn(async () => ({ sent: false as const, reason: "RESEND_API_KEY not set" }));
    const outcome = await publishDue(db, row.id, {}, { sendMail: logOnly });
    expect(outcome).toMatchObject({ kind: "emailed", mail: { sent: false }, post: { status: "emailed" } });
  });

  it("fails only the row whose link can't be built (X over 280) and still emails its sibling", async () => {
    const tooLong = await insertRow({ text: "x".repeat(281) });
    const li = await insertRow({ platform: "linkedin", text: "LinkedIn take" });

    const outcome = await publishDue(db, tooLong.id, {}, { sendMail });
    expect(outcome).toMatchObject({ kind: "failed", error: expect.stringContaining("limit is 280"), post: { id: tooLong.id, status: "failed" } });
    expect(sent).toHaveLength(1);
    expect(sent[0].subject).toBe('Post at 17:00 · LinkedIn · "LinkedIn take"');
    expect((await rowById(li.id)).status).toBe("emailed");

    // The other way round: the target is fine, the broken sibling fails alone.
    const ok = await insertRow({ publishAt: new Date("2030-02-01T10:00:00Z") });
    const broken = await insertRow({ platform: "linkedin", text: "fine", publishAt: new Date("2030-02-01T10:00:00Z") });
    await db.update(scheduledPosts).set({ text: "y".repeat(300), platform: "x" }).where(eq(scheduledPosts.id, broken.id));
    const outcome2 = await publishDue(db, ok.id, {}, { sendMail });
    expect(outcome2.kind).toBe("emailed");
    expect((await rowById(broken.id)).status).toBe("failed");
  });
});

describe("loadSharePageRow (the public share page's one row)", () => {
  it("returns exactly the four columns the page renders — nothing that would leak through a shared link", async () => {
    const row = await insertRow({ status: "emailed", externalId: "msg_1", error: "old", text: "X take\n\nsecond line" });
    const page = await loadSharePageRow(db, row.id);
    expect(page).toEqual({ text: "X take\n\nsecond line", platform: "x", publishAt: SLOT, status: "emailed" });
    expect(Object.keys(page!).sort()).toEqual(["platform", "publishAt", "status", "text"]);
  });

  it("is null for an unknown id", async () => {
    expect(await loadSharePageRow(db, UNKNOWN_ID)).toBeNull();
  });
});

describe("publishOutcomeResponse", () => {
  it("maps outcomes to 404 / 200 shapes", async () => {
    const notFound = publishOutcomeResponse({ kind: "not_found" });
    expect(notFound.status).toBe(404);
    const row = await insertRow({});
    const skipped = publishOutcomeResponse({ kind: "skipped", post: row });
    expect(skipped.status).toBe(200);
    expect(await skipped.json()).toMatchObject({ skipped: true, post: { id: row.id } });
    const emailed = publishOutcomeResponse({ kind: "emailed", post: row, posts: [row], mail: { sent: false, reason: "r" } });
    expect(await emailed.json()).toMatchObject({ emailed: [row.id], sent: false });
    const failed = publishOutcomeResponse({ kind: "failed", post: row, error: "boom" });
    expect(failed.status).toBe(200);
    expect(await failed.json()).toMatchObject({ error: "boom" });
  });
});

describe("markPostedById", () => {
  const deleteMessage = vi.fn(async () => {});
  const qstash = { enabled: true as const, scheduleMessage: vi.fn(async () => "msg"), deleteMessage };
  beforeEach(() => deleteMessage.mockClear());

  it("converts a queued row to posted_manually, stamps publishedAt and cancels its timer", async () => {
    const row = await insertRow({ externalId: "msg_1", error: "old" });
    const now = new Date("2030-01-15T16:02:00Z");
    const posted = await markPostedById(db, row.id, { qstash, now });
    expect(posted).toMatchObject({ id: row.id, status: "posted_manually", postedBy: "manual", publishedAt: now, error: null });
    expect(deleteMessage).toHaveBeenCalledWith("msg_1");
  });

  it("converts an emailed row (the usual case) without a timer to cancel, and a failed one", async () => {
    const emailed = await insertRow({ status: "emailed" });
    expect((await markPostedById(db, emailed.id, { qstash }))?.status).toBe("posted_manually");
    const failed = await insertRow({ status: "failed" });
    expect((await markPostedById(db, failed.id, { qstash }))?.status).toBe("posted_manually");
    expect(deleteMessage).not.toHaveBeenCalled();
  });

  it("is idempotent and null for an unknown id", async () => {
    const row = await insertRow({ externalId: "msg_1" });
    const first = await markPostedById(db, row.id, { qstash, now: new Date("2030-01-15T16:02:00Z") });
    const second = await markPostedById(db, row.id, { qstash, now: new Date("2030-01-15T16:09:00Z") });
    expect(second).toEqual(first);
    expect(deleteMessage).toHaveBeenCalledTimes(1);
    expect(await markPostedById(db, UNKNOWN_ID, { qstash })).toBeNull();
  });
});

describe("publishDue — a timer from before Plan's Edit moved the post (2026-09-24)", () => {
  it("skips a delivery whose message isn't the row's current timer, and acts on the current one", async () => {
    const row = await insertRow({ externalId: "msg_current" });
    const now = new Date("2030-01-15T15:55:00Z");
    expect(await publishDue(db, row.id, { mode: "due", messageId: "msg_stale" }, { sendMail, now })).toMatchObject({ kind: "skipped" });
    expect(sendMail).not.toHaveBeenCalled();
    expect((await rowById(row.id)).status).toBe("queued");

    expect(await publishDue(db, row.id, { mode: "due", messageId: "msg_current" }, { sendMail, now })).toMatchObject({ kind: "emailed" });
    expect(sendMail).toHaveBeenCalledTimes(1);
  });

  it("a delivery without an id, or a row without a timer id, is acted on as before", async () => {
    const row = await insertRow({ externalId: null });
    const now = new Date("2030-01-15T15:55:00Z");
    expect(await publishDue(db, row.id, { mode: "due", messageId: "msg_any" }, { sendMail, now })).toMatchObject({ kind: "emailed" });
  });
});
