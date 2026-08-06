CREATE TABLE "magic_link_delivery_dispositions" (
	"candidate_id" uuid PRIMARY KEY NOT NULL,
	"request_id" uuid NOT NULL,
	"minted_token_id" uuid NOT NULL,
	"delivery_task_id" uuid NOT NULL,
	"final_state" text NOT NULL,
	"reservation_id" uuid,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "magic_link_delivery_dispositions_state_check" CHECK ("magic_link_delivery_dispositions"."final_state" in ('cancelled', 'superseded', 'abandoned'))
);
--> statement-breakpoint
CREATE TABLE "magic_link_mint_ledger" (
	"request_id" uuid PRIMARY KEY NOT NULL,
	"minted_token_id" uuid NOT NULL,
	"delivery_task_id" uuid NOT NULL,
	"minted_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "magic_link_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"locale" text,
	"redirect_path" text,
	"ip" text,
	"user_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	"minted_at" timestamp with time zone,
	"minted_token_id" uuid
);
--> statement-breakpoint
CREATE TABLE "magic_link_stuck_fence_alerts" (
	"candidate_id" uuid NOT NULL,
	"reservation_id" uuid NOT NULL,
	"last_notified_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "magic_link_stuck_fence_alerts_candidate_id_reservation_id_pk" PRIMARY KEY("candidate_id","reservation_id")
);
--> statement-breakpoint
ALTER TABLE "tasks" DROP CONSTRAINT "tasks_queue_class_check";--> statement-breakpoint
-- Keep this compatibility migration explicit. Existing tokens predate the
-- delivery protocol and are already usable, so their delivered_at anchor is
-- their original creation time rather than the migration timestamp.
ALTER TABLE "magic_link_tokens" ADD COLUMN "delivery_state" text;--> statement-breakpoint
ALTER TABLE "magic_link_tokens" ADD COLUMN "delivered_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "magic_link_tokens" ADD COLUMN "superseded_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "magic_link_tokens" ADD COLUMN "delivery_reservation_id" uuid;--> statement-breakpoint
ALTER TABLE "magic_link_tokens" ADD COLUMN "delivery_reservation_until" timestamp with time zone;--> statement-breakpoint
UPDATE "magic_link_tokens"
SET "delivery_state" = 'active',
    "delivered_at" = "created_at";--> statement-breakpoint
ALTER TABLE "magic_link_tokens" ALTER COLUMN "delivery_state" SET DEFAULT 'active';--> statement-breakpoint
ALTER TABLE "magic_link_tokens" ALTER COLUMN "delivery_state" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "magic_link_tokens" ALTER COLUMN "delivered_at" SET DEFAULT now();--> statement-breakpoint
CREATE UNIQUE INDEX "magic_link_mint_ledger_token_unique" ON "magic_link_mint_ledger" USING btree ("minted_token_id");--> statement-breakpoint
CREATE UNIQUE INDEX "magic_link_mint_ledger_task_unique" ON "magic_link_mint_ledger" USING btree ("delivery_task_id");--> statement-breakpoint
CREATE INDEX "magic_link_requests_mint_budget_idx" ON "magic_link_requests" USING btree ("email","ip","minted_at" DESC NULLS LAST) WHERE "magic_link_requests"."minted_at" is not null;--> statement-breakpoint
CREATE INDEX "magic_link_requests_cleanup_idx" ON "magic_link_requests" USING btree (greatest("created_at", coalesce("minted_at", "created_at")),"id") WHERE "magic_link_requests"."resolved_at" is not null;--> statement-breakpoint
CREATE INDEX "magic_link_tokens_pending_cleanup_idx" ON "magic_link_tokens" USING btree ("created_at","id") WHERE "magic_link_tokens"."delivery_state" = 'pending' and "magic_link_tokens"."delivery_reservation_id" is null;--> statement-breakpoint
CREATE INDEX "magic_link_tokens_stuck_reservation_idx" ON "magic_link_tokens" USING btree ("created_at","id") WHERE "magic_link_tokens"."delivery_state" = 'pending' and "magic_link_tokens"."delivery_reservation_id" is not null;--> statement-breakpoint
ALTER TABLE "magic_link_tokens" ADD CONSTRAINT "magic_link_tokens_delivery_state_check" CHECK ("magic_link_tokens"."delivery_state" in ('pending', 'active', 'superseded', 'cancelled'));--> statement-breakpoint
ALTER TABLE "magic_link_tokens" ADD CONSTRAINT "magic_link_tokens_delivery_timestamp_check" CHECK ((
        ("magic_link_tokens"."delivery_state" = 'pending' and "magic_link_tokens"."delivered_at" is null)
        or ("magic_link_tokens"."delivery_state" = 'active' and "magic_link_tokens"."delivered_at" is not null)
        or "magic_link_tokens"."delivery_state" in ('superseded', 'cancelled')
      ));--> statement-breakpoint
ALTER TABLE "magic_link_tokens" ADD CONSTRAINT "magic_link_tokens_reservation_pair_check" CHECK (("magic_link_tokens"."delivery_reservation_id" is null) = ("magic_link_tokens"."delivery_reservation_until" is null));--> statement-breakpoint
ALTER TABLE "magic_link_tokens" ADD CONSTRAINT "magic_link_tokens_reservation_state_check" CHECK ("magic_link_tokens"."delivery_reservation_id" is null or "magic_link_tokens"."delivery_state" = 'pending');--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_magic_link_protocol_check" CHECK (
        coalesce(
          case
            when "tasks"."kind" = 'auth.magic_link_request' then
              "tasks"."queue_class" = 'auth_intake'
              and not coalesce("tasks"."payload_json" ? 'deliveryProtocol', false)
              and not coalesce("tasks"."payload_json" ? 'email', false)
              and jsonb_typeof("tasks"."payload_json"->'version') = 'number'
              and "tasks"."payload_json"->>'version' = '1'
              and jsonb_typeof("tasks"."payload_json"->'requestId') = 'string'
            when "tasks"."kind" = 'auth.magic_link_email'
              and coalesce("tasks"."payload_json" ? 'deliveryProtocol', false) then
              "tasks"."queue_class" = 'auth_delivery_v2'
              and jsonb_typeof("tasks"."payload_json"->'version') = 'number'
              and "tasks"."payload_json"->>'version' = '1'
              and jsonb_typeof("tasks"."payload_json"->'deliveryProtocol') = 'number'
              and "tasks"."payload_json"->>'deliveryProtocol' = '2'
              and jsonb_typeof("tasks"."payload_json"->'tokenId') = 'string'
              and jsonb_typeof("tasks"."payload_json"->'encryptedToken') = 'string'
              and not coalesce("tasks"."payload_json" ? 'email', false)
              and (
                not coalesce("tasks"."payload_json" ? 'locale', false)
                or (
                  jsonb_typeof("tasks"."payload_json"->'locale') = 'string'
                  and "tasks"."payload_json"->>'locale' in ('zh', 'en', 'ja')
                )
              )
            when "tasks"."kind" = 'auth.magic_link_email' then
              "tasks"."queue_class" = 'transactional'
              and not coalesce("tasks"."payload_json" ? 'deliveryProtocol', false)
            else
              "tasks"."queue_class" not in ('auth_delivery_v2', 'auth_intake')
              and not coalesce("tasks"."payload_json" ? 'deliveryProtocol', false)
          end,
          false
        )
      );--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_queue_class_check" CHECK ("tasks"."queue_class" in ('transactional', 'auth_delivery_v2', 'auth_intake', 'notification', 'maintenance', 'default'));
--> statement-breakpoint
-- Compatibility guard for any old verifier/consumer binary that is still
-- present during phase A. Pending rows already use an expired placeholder, but
-- this trigger also rejects a direct legacy UPDATE that tries to consume a
-- non-active row. It is defense in depth, never a replacement for the
-- two-phase rollout gate.
CREATE OR REPLACE FUNCTION magic_link_tokens_reject_non_active_consumption()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW."consumed_at" IS NOT NULL
     AND OLD."consumed_at" IS NULL
     AND (OLD."delivery_state" <> 'active' OR OLD."delivered_at" IS NULL) THEN
    RAISE EXCEPTION 'magic_link_token_not_delivered'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER magic_link_tokens_reject_non_active_consumption_trigger
BEFORE UPDATE OF "consumed_at" ON "magic_link_tokens"
FOR EACH ROW
EXECUTE FUNCTION magic_link_tokens_reject_non_active_consumption();
