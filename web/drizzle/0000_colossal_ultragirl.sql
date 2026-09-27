CREATE TYPE "public"."draft_status" AS ENUM('candidate', 'kept', 'used', 'discarded');--> statement-breakpoint
CREATE TYPE "public"."idea_kind" AS ENUM('x_post', 'youtube', 'article', 'note');--> statement-breakpoint
CREATE TYPE "public"."idea_source" AS ENUM('manual', 'scout');--> statement-breakpoint
CREATE TYPE "public"."idea_status" AS ENUM('new', 'used', 'archived', 'dismissed');--> statement-breakpoint
CREATE TYPE "public"."job_kind" AS ENUM('generate_from_video', 'revise_draft', 'image_prompt', 'analyze_style', 'scout');--> statement-breakpoint
CREATE TYPE "public"."job_status" AS ENUM('queued', 'claimed', 'done', 'failed');--> statement-breakpoint
CREATE TYPE "public"."platform" AS ENUM('x', 'linkedin');--> statement-breakpoint
CREATE TYPE "public"."posted_by" AS ENUM('api', 'manual');--> statement-breakpoint
CREATE TYPE "public"."schedule_status" AS ENUM('queued', 'published', 'emailed', 'posted_manually', 'failed', 'canceled');--> statement-breakpoint
CREATE TABLE "accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"platform" "platform" NOT NULL,
	"encrypted_access_token" text NOT NULL,
	"encrypted_refresh_token" text,
	"expires_at" timestamp with time zone,
	"scopes" text,
	"handle" text,
	CONSTRAINT "accounts_platform_unique" UNIQUE("platform")
);
--> statement-breakpoint
CREATE TABLE "drafts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"idea_id" uuid,
	"x_text" text,
	"linkedin_text" text,
	"status" "draft_status" DEFAULT 'candidate' NOT NULL,
	"favorite" boolean DEFAULT false NOT NULL,
	"parent_id" uuid,
	"image_prompt" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ideas" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"url" text,
	"kind" "idea_kind" NOT NULL,
	"title" text,
	"content" text,
	"author" text,
	"meta" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"source" "idea_source" DEFAULT 'manual' NOT NULL,
	"status" "idea_status" DEFAULT 'new' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" "job_kind" NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" "job_status" DEFAULT 'queued' NOT NULL,
	"result" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"claimed_at" timestamp with time zone,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "kv" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "scheduled_posts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"draft_id" uuid NOT NULL,
	"platform" "platform" NOT NULL,
	"text" text NOT NULL,
	"scheduled_at" timestamp with time zone NOT NULL,
	"status" "schedule_status" DEFAULT 'queued' NOT NULL,
	"posted_by" "posted_by",
	"qstash_message_id" text,
	"platform_post_id" text,
	"error" text,
	"published_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "drafts" ADD CONSTRAINT "drafts_idea_id_ideas_id_fk" FOREIGN KEY ("idea_id") REFERENCES "public"."ideas"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scheduled_posts" ADD CONSTRAINT "scheduled_posts_draft_id_drafts_id_fk" FOREIGN KEY ("draft_id") REFERENCES "public"."drafts"("id") ON DELETE no action ON UPDATE no action;