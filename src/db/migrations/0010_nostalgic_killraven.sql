ALTER TABLE "posts" ADD COLUMN "scheduled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "posts" ADD COLUMN "schedule_token" uuid;--> statement-breakpoint
ALTER TABLE "posts" ADD COLUMN "content_updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
UPDATE "posts" SET "content_updated_at" = "updated_at";--> statement-breakpoint
CREATE INDEX "posts_status_scheduled_idx" ON "posts" USING btree ("status","scheduled_at");--> statement-breakpoint
ALTER TABLE "posts" ADD CONSTRAINT "posts_schedule_pair_check" CHECK (("posts"."scheduled_at" is null) = ("posts"."schedule_token" is null));--> statement-breakpoint
ALTER TABLE "posts" ADD CONSTRAINT "posts_schedule_draft_only_check" CHECK ("posts"."status" = 'draft' or ("posts"."scheduled_at" is null and "posts"."schedule_token" is null));--> statement-breakpoint
ALTER TABLE "posts" ADD CONSTRAINT "posts_published_at_check" CHECK ("posts"."status" <> 'published' or "posts"."published_at" is not null);