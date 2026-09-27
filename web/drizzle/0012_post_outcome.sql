CREATE TYPE "public"."post_outcome" AS ENUM('good', 'bad');--> statement-breakpoint
ALTER TABLE "scheduled_posts" ADD COLUMN "outcome" "post_outcome";--> statement-breakpoint
ALTER TABLE "scheduled_posts" ADD COLUMN "rated_at" timestamp with time zone;