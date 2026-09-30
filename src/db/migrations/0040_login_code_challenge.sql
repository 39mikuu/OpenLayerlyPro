ALTER TABLE "login_codes" ADD COLUMN "challenge_hash" text;
--> statement-breakpoint
ALTER TABLE "login_codes" ADD COLUMN "replacement_challenge_hash" text;
