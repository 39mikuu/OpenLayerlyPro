CREATE TABLE "magic_link_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"token_hash" text NOT NULL,
	"key_id" text NOT NULL,
	"redirect_path" text,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ip" text,
	"user_agent" text
);
--> statement-breakpoint
CREATE UNIQUE INDEX "magic_link_tokens_token_hash_key_idx" ON "magic_link_tokens" USING btree ("token_hash","key_id");--> statement-breakpoint
CREATE INDEX "magic_link_tokens_email_created_idx" ON "magic_link_tokens" USING btree ("email","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "magic_link_tokens_email_active_idx" ON "magic_link_tokens" USING btree ("email","expires_at","consumed_at");