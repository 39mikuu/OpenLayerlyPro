ALTER TABLE "login_codes" ADD COLUMN "smtp_reservation_token" uuid;
--> statement-breakpoint
ALTER TABLE "login_codes" ADD COLUMN "smtp_reserved_at" timestamp with time zone;
