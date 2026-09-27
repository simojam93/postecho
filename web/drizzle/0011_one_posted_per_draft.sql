-- A post marked as posted twice (the email's link, then the app's button, 2026-09-24):
-- the first stays posted; any later ones are set aside, not deleted, with the note
-- lib/schedule.ts's ALREADY_POSTED_NOTE — Plan doesn't list those. Then the index.
UPDATE "scheduled_posts" SET "status" = 'canceled', "error" = 'already posted: the same post was marked as posted'
WHERE "id" IN (
  SELECT "id" FROM (
    SELECT "id", row_number() OVER (PARTITION BY "draft_id", "platform" ORDER BY "published_at" NULLS LAST, "created_at", "id") AS "rn"
    FROM "scheduled_posts" WHERE "status" IN ('posted_manually', 'published')
  ) AS "ranked" WHERE "rn" > 1
);--> statement-breakpoint
CREATE UNIQUE INDEX "scheduled_posts_one_posted_per_draft_platform" ON "scheduled_posts" USING btree ("draft_id","platform") WHERE status in ('posted_manually', 'published');