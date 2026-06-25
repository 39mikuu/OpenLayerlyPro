ALTER TABLE "files" ADD COLUMN "quarantined_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "files" ADD COLUMN "quarantine_reason" text;--> statement-breakpoint
ALTER TABLE "files" ADD COLUMN "remediation_version" integer DEFAULT 0 NOT NULL;