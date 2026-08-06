CREATE TABLE "magic_link_dead_intake_alerts" (
	"task_id" uuid PRIMARY KEY NOT NULL,
	"last_notified_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
