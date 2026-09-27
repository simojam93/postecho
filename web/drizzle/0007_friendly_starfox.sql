ALTER TYPE "public"."job_kind" ADD VALUE 'generate_from_idea';--> statement-breakpoint
ALTER TABLE "drafts" ADD COLUMN "job_id" uuid;--> statement-breakpoint
ALTER TABLE "drafts" ADD COLUMN "meta" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
CREATE INDEX "drafts_idea_id_idx" ON "drafts" USING btree ("idea_id");