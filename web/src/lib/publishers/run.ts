import { and, asc, eq, gte, inArray, lte, ne } from "drizzle-orm";
import { scheduledPosts } from "@/db/schema";
import { sendMail as defaultSendMail, type MailMessage, type SendMailResult } from "@/lib/email";
import { forgetMessage, getQstash, type Qstash } from "@/lib/qstash";
import { isUniqueViolation, postedAlready, setAsidePending, type ScheduleDb, type ScheduledPost, type ScheduleStatus } from "@/lib/schedule";
import { getSetting } from "@/lib/settings";
import { renderDueEmail, type DueEmailItem } from "./email";
import { markPostedUrl, postPageUrl, publisherFor, type Platform } from "./index";

/**
 * The publish step (M3 plan, tasks P2/P3): what happens when a scheduled
 * post's timer fires — or the owner presses Run/Resend. Both platforms are
 * human-in-the-loop, so "publishing" means ONE email to the owner with the
 * post text and a "Post on X" / "Post on LinkedIn" button per row (each
 * opening the row's signed share page, app/post/[id]), plus a signed "Mark
 * as posted" link each. Shared by POST /api/publish/[id] (the
 * QStash webhook, also reachable with a session) and POST
 * /api/scheduled-posts/[id]/run. Runs without a transaction (neon-http has
 * none — see db/index.ts), so the order is: send, then record — a crash in
 * between can at worst repeat an email, never lose one that was recorded
 * as sent.
 */

/** Rows due this close to the target (either side) share its email — X and LinkedIn scheduled for the same slot. */
export const SAME_SLOT_WINDOW_MS = 60_000;
const ERROR_MAX_CHARS = 500;
const PLATFORM_ORDER: Record<Platform, number> = { x: 0, linkedin: 1 };

/**
 * `due`: the timer fired — only a `queued` row is acted on, anything else
 * is a no-op (a late or duplicate delivery must not email twice).
 * `resend`: the owner asked (Run, Plan's Resend/Retry) — an `emailed` or
 * `failed` row goes out again.
 */
export type PublishMode = "due" | "resend";
const ACTIONABLE: Record<PublishMode, ScheduleStatus[]> = {
  due: ["queued"],
  resend: ["queued", "emailed", "failed"],
};

export type PublishDeps = {
  /** lib/email.ts's sendMail by default — a fake in tests. */
  sendMail?: (message: MailMessage) => Promise<SendMailResult>;
  now?: Date;
};

export type PublishOutcome =
  | { kind: "not_found" }
  /** The row wasn't actionable in this mode — its current state, unchanged. */
  | { kind: "skipped"; post: ScheduledPost }
  /** The email went out (or was logged, `mail.sent` false without RESEND_API_KEY); `posts` are all rows it covered. */
  | { kind: "emailed"; post: ScheduledPost; posts: ScheduledPost[]; mail: SendMailResult }
  /** Recorded on the row as `failed` + `error`. */
  | { kind: "failed"; post: ScheduledPost; error: string };

function messageOf(e: unknown): string {
  return (e instanceof Error ? e.message : String(e)).slice(0, ERROR_MAX_CHARS);
}

function byPlatformThenTime(a: ScheduledPost, b: ScheduledPost): number {
  return PLATFORM_ORDER[a.platform] - PLATFORM_ORDER[b.platform]
    || a.publishAt.getTime() - b.publishAt.getTime()
    || a.id.localeCompare(b.id);
}

async function loadPost(db: ScheduleDb, id: string): Promise<ScheduledPost | null> {
  const [post] = await db.select().from(scheduledPosts).where(eq(scheduledPosts.id, id)).limit(1);
  return post ?? null;
}

async function setFailed(db: ScheduleDb, ids: string[], error: string): Promise<void> {
  if (ids.length === 0) return;
  await db.update(scheduledPosts).set({ status: "failed", error }).where(inArray(scheduledPosts.id, ids));
}

async function failed(db: ScheduleDb, target: ScheduledPost, error: string): Promise<PublishOutcome> {
  return { kind: "failed", post: (await loadPost(db, target.id)) ?? { ...target, status: "failed", error }, error };
}

/**
 * Publishes scheduled post `id`: builds the due email for it and for every
 * other still-queued row within SAME_SLOT_WINDOW_MS of its slot, sends it
 * to Settings `notificationEmail`, and marks those rows `emailed` (+
 * `emailedAt`). A row that can't go out (X text over 280 — X itself would
 * refuse it; no SESSION_SECRET to sign its links with) is marked `failed`
 * on its own and the rest still go out; a send failure marks the whole
 * batch `failed` with the provider's message. Every outcome but
 * `not_found` is a recorded state, never a throw: the webhook answers 200
 * to all of them so QStash doesn't retry a failure into a loop — only a
 * genuine infrastructure exception (the db is down) propagates for a 500.
 */
export async function publishDue(
  db: ScheduleDb,
  id: string,
  { mode = "due", messageId = null }: { mode?: PublishMode; messageId?: string | null } = {},
  { sendMail = defaultSendMail, now = new Date() }: PublishDeps = {},
): Promise<PublishOutcome> {
  const target = await loadPost(db, id);
  if (!target) return { kind: "not_found" };
  if (!ACTIONABLE[mode].includes(target.status)) return { kind: "skipped", post: target };
  // A timer from before Plan's Edit moved the post (lib/schedule.ts's
  // updateSchedule): the row's timer is another message now, so this one is
  // stale — never an early email. (A delivery without an id is acted on.)
  if (mode === "due" && messageId && target.externalId && messageId !== target.externalId) return { kind: "skipped", post: target };

  const to = (await getSetting(db, "notificationEmail")).trim();
  if (!to) {
    const error = "notificationEmail is not set — add it in Settings";
    await setFailed(db, [target.id], error);
    return failed(db, target, error);
  }

  const slot = target.publishAt.getTime();
  const siblings = await db
    .select()
    .from(scheduledPosts)
    .where(and(
      eq(scheduledPosts.status, "queued"),
      ne(scheduledPosts.id, target.id),
      gte(scheduledPosts.publishAt, new Date(slot - SAME_SLOT_WINDOW_MS)),
      lte(scheduledPosts.publishAt, new Date(slot + SAME_SLOT_WINDOW_MS)),
    ))
    .orderBy(asc(scheduledPosts.publishAt), asc(scheduledPosts.id));
  const batch = [target, ...siblings].sort(byPlatformThenTime);

  const items: DueEmailItem[] = [];
  const good: ScheduledPost[] = [];
  const broken = new Map<string, string>();
  for (const post of batch) {
    try {
      // The composer URL is no longer in the email (the share page builds it),
      // but building it is still the check that X would take the text at all.
      publisherFor(post.platform).composerUrl(post.text);
      items.push({
        platform: post.platform,
        text: post.text,
        pageUrl: postPageUrl(post.id),
        markPostedUrl: markPostedUrl(post.id),
      });
      good.push(post);
    } catch (e) {
      broken.set(post.id, messageOf(e));
    }
  }
  for (const [postId, error] of broken) await setFailed(db, [postId], error);

  const targetError = broken.get(target.id);
  if (good.length === 0) return failed(db, target, targetError ?? "nothing to send");

  const rendered = renderDueEmail({ items, dueAt: target.publishAt });
  let mail: SendMailResult;
  try {
    mail = await sendMail({ to, ...rendered });
  } catch (e) {
    const error = messageOf(e);
    await setFailed(db, good.map((post) => post.id), error);
    return failed(db, target, targetError ?? error);
  }

  const emailed = await db
    .update(scheduledPosts)
    .set({ status: "emailed", emailedAt: now, error: null })
    .where(inArray(scheduledPosts.id, good.map((post) => post.id)))
    .returning();

  if (targetError !== undefined) return failed(db, target, targetError);
  const post = emailed.find((row) => row.id === target.id) ?? (await loadPost(db, target.id)) ?? target;
  return { kind: "emailed", post, posts: emailed.sort(byPlatformThenTime), mail };
}

/** The HTTP answer for an outcome — shared by the webhook and the run route so the two never drift. */
export function publishOutcomeResponse(outcome: PublishOutcome): Response {
  switch (outcome.kind) {
    case "not_found":
      return Response.json({ error: "not found" }, { status: 404 });
    case "skipped":
      return Response.json({ post: outcome.post, skipped: true });
    case "emailed":
      return Response.json({ post: outcome.post, emailed: outcome.posts.map((post) => post.id), sent: outcome.mail.sent });
    case "failed":
      return Response.json({ post: outcome.post, error: outcome.error });
  }
}

/** What the share page shows for a row: these four columns and nothing else. */
export type SharePageRow = Pick<ScheduledPost, "text" | "platform" | "publishAt" | "status">;

/**
 * The row behind the public share page (app/post/[id]), once its signed
 * link checked out. Only the columns the page renders come back — the
 * frozen text, the platform, the slot and the status — never the draft,
 * the timer id or an error message: the page is reachable with no session,
 * so whatever it is handed is what a leaked link would show. Null for an
 * unknown id (the page answers 404, same as for a bad signature).
 */
export async function loadSharePageRow(db: ScheduleDb, id: string): Promise<SharePageRow | null> {
  const [row] = await db
    .select({
      text: scheduledPosts.text,
      platform: scheduledPosts.platform,
      publishAt: scheduledPosts.publishAt,
      status: scheduledPosts.status,
    })
    .from(scheduledPosts)
    .where(eq(scheduledPosts.id, id))
    .limit(1);
  return row ?? null;
}

/**
 * The email's "Mark as posted" link, once its signature checked out (GET
 * /api/mark-posted): the row becomes `posted_manually` with `publishedAt`
 * now, and a still-pending QStash message for it is canceled (best
 * effort). A row already posted (by hand or, later, via an API) is left as
 * it is — tapping the link twice is fine. Never the same post twice
 * (2026-09-24): when the same post is already out from another row (the
 * app's Mark as posted came first, or a copy of the draft), this row is set
 * aside and that post is returned. Null for an unknown id.
 */
export async function markPostedById(
  db: ScheduleDb,
  id: string,
  { qstash = getQstash(), now = new Date() }: { qstash?: Qstash; now?: Date } = {},
): Promise<ScheduledPost | null> {
  const existing = await loadPost(db, id);
  if (!existing) return null;
  if (existing.status === "posted_manually" || existing.status === "published") return existing;

  const same = { draftId: existing.draftId, platform: existing.platform };
  const alreadyOut = async (): Promise<ScheduledPost | null> => {
    const out = await postedAlready(db, { ...same, text: existing.text, exceptId: id, now });
    if (out) await setAsidePending(db, qstash, same);
    return out;
  };
  const before = await alreadyOut();
  if (before) return before;

  let updated: ScheduledPost | undefined;
  try {
    [updated] = await db
      .update(scheduledPosts)
      .set({ status: "posted_manually", postedBy: "manual", publishedAt: now, error: null })
      .where(eq(scheduledPosts.id, id))
      .returning();
  } catch (e) {
    // Marked from the app at the same instant: the one-posted index let that one through.
    if (isUniqueViolation(e)) {
      const raced = await alreadyOut();
      if (raced) return raced;
    }
    throw e;
  }
  if (!updated) return null;
  await forgetMessage(qstash, updated.externalId);
  // Any other schedule of this post would email it again: set aside.
  await setAsidePending(db, qstash, { ...same, exceptId: id });
  return updated;
}
