CREATE TABLE "supporter_wall_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"dedication" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"version" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "supporter_wall_entries_user_id_unique" UNIQUE("user_id"),
	CONSTRAINT "supporter_wall_entries_dedication_length_check" CHECK (char_length("supporter_wall_entries"."dedication") <= 200)
);
--> statement-breakpoint
ALTER TABLE "supporter_wall_entries" ADD CONSTRAINT "supporter_wall_entries_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "supporter_wall_entries_status_created_id_idx" ON "supporter_wall_entries" USING btree ("status","created_at","id");