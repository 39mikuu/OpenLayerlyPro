ALTER TABLE "app_settings" ALTER COLUMN "value_encrypted" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "app_settings" ADD COLUMN "revision" integer DEFAULT 1 NOT NULL;