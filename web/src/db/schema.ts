import {
  pgTable, text, timestamp, boolean, jsonb, uuid, pgEnum, index, uniqueIndex,
} from "drizzle-orm/pg-core";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

// "bluesky"/"hackernews" (M1.5 final scout design, 2026-09-21) are the kind
// of an idea scouted from those free open APIs — see lib/scout-run.ts. Enum
// values are only ever appended, never reordered/removed, since Postgres
// enums are positional (see drizzle/0004's ALTER TYPE ... ADD VALUE).
// "arxiv"/"github"/"devto"/"mastodon"/"reddit"/"producthunt" (seven-adapters
// wiring, 2026-09-22) are the six additional discovery sources' scouted-idea
// kind — see lib/sources/all.ts. YouTube needs no new value here: its
// adapter's scouted ideas reuse the existing "youtube" kind (see
// lib/scout-run.ts's kind-equals-adapter-name convention).
// "lobsters"/"lemmy" (two more keyless sources, 2026-09-22) are those
// adapters' scouted-idea kind — see lib/sources/lobsters.ts and lemmy.ts.
// Appended after "producthunt", per the append-only rule above.
export const ideaKind = pgEnum("idea_kind", [
  "x_post", "youtube", "article", "note", "bluesky", "hackernews",
  "arxiv", "github", "devto", "mastodon", "reddit", "producthunt",
  "lobsters", "lemmy",
  // A post idea PostEcho found in a pasted video's transcript (2026-09-27:
  // "it should take all the script of the video and create some post ideas").
  "video_idea",
  // Posts from a repo (2026-10-10): "repo" is the source, a folder on the owner's computer
  // (url file://<path>) or a public GitHub repository; "repo_post" is a post written from it by a
  // repo_posts job (materialize.ts's materializeRepoPosts). Appended, same rule as above.
  "repo", "repo_post",
]);
export const ideaSource = pgEnum("idea_source", ["manual", "scout"]);
// "kept" (M1.5 search-results UX round, 2026-09-21) is the ♥ positive taste
// signal — distinct from "used" (Use — positive + went to Create): see
// lib/taste.ts (kept examples = "used" OR "kept") and components/idea-card.tsx.
// Appended, not inserted alongside "used" — see the ideaKind comment above on
// why enum values are append-only.
export const ideaStatus = pgEnum("idea_status", ["new", "used", "archived", "dismissed", "kept"]);
export const draftStatus = pgEnum("draft_status", ["candidate", "kept", "used", "discarded"]);
export const platform = pgEnum("platform", ["x", "linkedin"]);
// A scheduled post's life (M3 publishing, 2026-09-22): queued → emailed (X:
// the "Post on X" email went out) → posted_manually (the owner pressed the
// intent / Mark as posted), or queued → published (LinkedIn, via the API),
// or → failed / canceled. Note the single-l "canceled" — it's the value M1
// created and enum values can't be renamed in place, so every read/write
// site (lib/schedule.ts, the scheduled-posts API, the Plan tab) spells it
// this way.
export const scheduleStatus = pgEnum("schedule_status", [
  "queued", "published", "emailed", "posted_manually", "failed", "canceled",
]);
export const postedBy = pgEnum("posted_by", ["api", "manual"]);
// Plan's "How did it do?" (owner, 2026-09-26: "il tocco in plan serve sia se il post è andato
// bene che se è andato male"): the owner's 👍/👎 on a post that is out — lib/schedule.ts's
// rateSchedule; lib/taste.ts learns from it.
export const postOutcome = pgEnum("post_outcome", ["good", "bad"]);
export const jobKind = pgEnum("job_kind", [
  "generate_from_video", "revise_draft", "image_prompt", "analyze_style", "scout",
  // "generate_from_idea" (M2 agent+generation, 2026-09-22): generates draft
  // candidates from a Find Ideas card (a scouted/trend or manually-pasted
  // idea/seed), the same way generate_from_video does from a video
  // transcript — see the drafts API's POST /api/drafts/from-idea (task A4)
  // and materialize.ts's per-kind switch (task A3). Appended, not inserted
  // alongside the others: enum values are append-only, never reordered or
  // removed (see the ideaKind comment above for why).
  "generate_from_idea",
  // "humanize_text" (M3.6, 2026-09-23): the AI slop tab's Humanize. Unused
  // since 2026-09-27, when the tab went (its loop now lives in jev-judge and
  // Write's Humanize runs it as a revise_draft): no route queues it and no
  // agent serves it. It stays because enum values are never removed.
  "humanize_text",
  // "video_ideas" (2026-09-27): a pasted video's whole transcript -> a dozen
  // post ideas, best first (materialize.ts writes them as video_idea rows).
  // Appended, same rule as above.
  "video_ideas",
  // "learn_style" (2026-09-27): what the owner's choices show (jev-judge's
  // learnFromChoices, lib/style-learning.ts) -> Claude's proposed change to
  // the style guide, which waits in Settings › Voice until they apply it
  // (materialize.ts's materializeStyleProposal). Appended, same rule as above.
  "learn_style",
  // Posts from a repo (2026-10-10): "repo_posts" has Claude Code read a folder or a public GitHub
  // repo on the owner's computer and write posts from it; "pick_folder" opens the computer's folder
  // picker and sends back the path. Appended, same rule as above.
  "repo_posts", "pick_folder",
]);
export const jobStatus = pgEnum("job_status", ["queued", "claimed", "done", "failed"]);

export const ideas = pgTable("ideas", {
  id: uuid("id").defaultRandom().primaryKey(),
  url: text("url"),
  kind: ideaKind("kind").notNull(),
  title: text("title"),
  content: text("content"),
  author: text("author"),
  meta: jsonb("meta").$type<Record<string, unknown>>().default({}).notNull(),
  source: ideaSource("source").default("manual").notNull(),
  status: ideaStatus("status").default("new").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  uniqueIndex("ideas_url_unique").on(t.url).where(sql`url IS NOT NULL`),
]);

export const drafts = pgTable("drafts", {
  id: uuid("id").defaultRandom().primaryKey(),
  ideaId: uuid("idea_id").references(() => ideas.id),
  xText: text("x_text"),
  linkedinText: text("linkedin_text"),
  status: draftStatus("status").default("candidate").notNull(),
  favorite: boolean("favorite").default(false).notNull(),
  parentId: uuid("parent_id").references((): AnyPgColumn => drafts.id),
  imagePrompt: text("image_prompt"),
  // An X article (posts from a repo, 2026-10-10): a title and a long body, set instead of
  // xText/linkedinText. Null on every other draft.
  articleTitle: text("article_title"),
  articleText: text("article_text"),
  // `jobId` (M2 agent+generation, 2026-09-22): the generate_from_video /
  // generate_from_idea job whose result produced this draft. Lets the result
  // handler (materialize.ts, task A3) check "have drafts for this jobId
  // already been inserted" before inserting again, so a retried/duplicate
  // result POST can't double-insert drafts. Nullable: drafts created another
  // way (e.g. a revise_draft result, keyed by parentId instead) have no
  // generating job in this sense, and pre-M2 rows have none at all.
  jobId: uuid("job_id"),
  // `meta` (M2 agent+generation, 2026-09-22): free-form per-draft data that
  // doesn't warrant its own column — slop-check results (`meta.slop`, task
  // A5), materialization flags (e.g. `meta.overLimit`). Same
  // jsonb-default-{}-notNull shape as ideas.meta above and for the same
  // reason: every read site can treat it as always-an-object, never null.
  meta: jsonb("meta").$type<Record<string, unknown>>().default({}).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().$onUpdate(() => new Date()).notNull(),
}, (t) => [
  // The drafts API (task A4) filters/joins drafts by ideaId
  // (`GET /api/drafts?ideaId=`) — an index keeps that from degrading to a
  // sequential scan as drafts accumulate.
  index("drafts_idea_id_idx").on(t.ideaId),
]);

// The publishing queue (M3, plan P1 — 2026-09-22): one row per (draft,
// platform, slot). The table exists since M1 with spec §5's column names, so
// two TS names deliberately differ from their DB column rather than renaming
// the column (which would have made migration 0009 destructive for a table
// that only ever grows additively):
//   publishAt  ↔ scheduled_at       — the slot, UTC (Europe/Rome is display-only)
//   externalId ↔ qstash_message_id  — the QStash message id (P2)
// Migration 0009 adds published_url, emailed_at, created_at, updated_at, the
// slot index and the one-queued-per-(draft, platform) partial unique index
// behind POST /api/scheduled-posts's 409 (see lib/schedule.ts's createSchedule).
export const scheduledPosts = pgTable("scheduled_posts", {
  id: uuid("id").defaultRandom().primaryKey(),
  draftId: uuid("draft_id").references(() => drafts.id).notNull(),
  platform: platform("platform").notNull(),
  // The platform's text frozen at scheduling time — what the email/publisher
  // sends even if the draft is edited afterwards.
  text: text("text").notNull(),
  publishAt: timestamp("scheduled_at", { withTimezone: true }).notNull(),
  status: scheduleStatus("status").default("queued").notNull(),
  // "api" for a LinkedIn publish, "manual" for X (posted_manually); null while queued.
  postedBy: postedBy("posted_by"),
  externalId: text("qstash_message_id"),
  // The platform's own id for the published post (LinkedIn's URN, P4); the
  // human-facing link lives in publishedUrl.
  platformPostId: text("platform_post_id"),
  publishedUrl: text("published_url"),
  error: text("error"),
  emailedAt: timestamp("emailed_at", { withTimezone: true }),
  publishedAt: timestamp("published_at", { withTimezone: true }),
  // The owner's vote on how the post did (postOutcome) and when they cast it; both null
  // until they vote, and again when they take the vote back.
  outcome: postOutcome("outcome"),
  ratedAt: timestamp("rated_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().$onUpdate(() => new Date()).notNull(),
}, (t) => [
  // The Plan calendar and suggestSlots both read by slot range.
  index("scheduled_posts_publish_at_idx").on(t.publishAt),
  // At most one QUEUED schedule per (draft, platform): createSchedule inserts
  // with ON CONFLICT ... WHERE status = 'queued' DO NOTHING against this
  // index, so two concurrent Schedule clicks can't both queue the same post.
  // Other statuses are free — a draft posted by hand can be scheduled again.
  uniqueIndex("scheduled_posts_one_queued_per_draft_platform")
    .on(t.draftId, t.platform)
    .where(sql`status = 'queued'`),
  // At most one POSTED row per (draft, platform) — owner, 2026-09-24: "never
  // allow double posted if it's the same post" (the email's Mark as posted,
  // then the app's, had made two). lib/schedule.ts's markPostedManually and
  // lib/publishers/run.ts's markPostedById return the post already there.
  uniqueIndex("scheduled_posts_one_posted_per_draft_platform")
    .on(t.draftId, t.platform)
    .where(sql`status in ('posted_manually', 'published')`),
]);

export const jobs = pgTable("jobs", {
  id: uuid("id").defaultRandom().primaryKey(),
  kind: jobKind("kind").notNull(),
  payload: jsonb("payload").$type<Record<string, unknown>>().default({}).notNull(),
  status: jobStatus("status").default("queued").notNull(),
  result: jsonb("result").$type<Record<string, unknown>>(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  claimedAt: timestamp("claimed_at", { withTimezone: true }),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
}, (t) => [
  index("jobs_status_kind_created_at_idx").on(t.status, t.kind, t.createdAt),
  // jobs_scout_open_query_unique (the per-query open-scout-job dedupe index)
  // is retired along with scout jobs themselves — M1.5's final design runs
  // the scout inline in the request instead of enqueueing a job (see
  // lib/scout-run.ts). The `scout` job-kind enum value is kept (harmless,
  // and Postgres enum values can't be dropped without recreating the type).
]);

export const accounts = pgTable("accounts", {
  id: uuid("id").defaultRandom().primaryKey(),
  platform: platform("platform").notNull().unique(),
  encryptedAccessToken: text("encrypted_access_token").notNull(),
  encryptedRefreshToken: text("encrypted_refresh_token"),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  scopes: text("scopes"),
  handle: text("handle"),
});

export const kv = pgTable("kv", {
  key: text("key").primaryKey(),
  value: jsonb("value").$type<unknown>().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().$onUpdate(() => new Date()).notNull(),
});
