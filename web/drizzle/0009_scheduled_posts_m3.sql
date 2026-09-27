ALTER TABLE "scheduled_posts" ADD COLUMN "published_url" text;--> statement-breakpoint
ALTER TABLE "scheduled_posts" ADD COLUMN "emailed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "scheduled_posts" ADD COLUMN "created_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "scheduled_posts" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
CREATE INDEX "scheduled_posts_publish_at_idx" ON "scheduled_posts" USING btree ("scheduled_at");--> statement-breakpoint
CREATE UNIQUE INDEX "scheduled_posts_one_queued_per_draft_platform" ON "scheduled_posts" USING btree ("draft_id","platform") WHERE status = 'queued';