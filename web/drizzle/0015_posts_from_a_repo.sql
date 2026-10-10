ALTER TYPE "public"."idea_kind" ADD VALUE 'repo';--> statement-breakpoint
ALTER TYPE "public"."idea_kind" ADD VALUE 'repo_post';--> statement-breakpoint
ALTER TYPE "public"."job_kind" ADD VALUE 'repo_posts';--> statement-breakpoint
ALTER TYPE "public"."job_kind" ADD VALUE 'pick_folder';--> statement-breakpoint
ALTER TABLE "drafts" ADD COLUMN "article_title" text;--> statement-breakpoint
ALTER TABLE "drafts" ADD COLUMN "article_text" text;