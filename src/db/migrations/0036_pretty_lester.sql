CREATE TABLE "storage_upload_journal" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"storage_driver" text NOT NULL,
	"bucket" text,
	"object_key" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"reconcile_after" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "storage_upload_journal_location_check" CHECK ((
        ("storage_upload_journal"."storage_driver" = 'local' and "storage_upload_journal"."bucket" is null)
        or ("storage_upload_journal"."storage_driver" = 's3' and "storage_upload_journal"."bucket" is not null)
      )),
	CONSTRAINT "storage_upload_journal_status_check" CHECK ("storage_upload_journal"."status" in ('pending', 'deleting'))
);
--> statement-breakpoint
CREATE INDEX "storage_upload_journal_reconcile_idx" ON "storage_upload_journal" USING btree ("status","reconcile_after","id");