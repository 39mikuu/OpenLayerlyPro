CREATE TABLE "payment_provider_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" text NOT NULL,
	"provider_event_id" text NOT NULL,
	"event_type" text NOT NULL,
	"object_ref" text,
	"provider_created_at" timestamp with time zone NOT NULL,
	"payload_json" jsonb NOT NULL,
	"status" text DEFAULT 'received' NOT NULL,
	"locked_by" text,
	"lease_until" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 5 NOT NULL,
	"processed_at" timestamp with time zone,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "subscriptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"tier_id" uuid NOT NULL,
	"status" text NOT NULL,
	"provider" text,
	"provider_subscription_ref" text,
	"provider_checkout_ref" text,
	"provider_customer_ref" text,
	"provider_price_ref" text,
	"expected_amount_minor" bigint,
	"expected_currency" text,
	"quantity" integer,
	"current_period_ends_at" timestamp with time zone,
	"cancel_at_period_end" boolean DEFAULT false NOT NULL,
	"canceled_at" timestamp with time zone,
	"status_event_at" timestamp with time zone,
	"checkout_claim_token" text,
	"checkout_claimed_at" timestamp with time zone,
	"version" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "membership_tiers" ADD COLUMN "stripe_price_id" text;--> statement-breakpoint
ALTER TABLE "payment_requests" ADD COLUMN "provider_invoice_ref" text;--> statement-breakpoint
ALTER TABLE "payment_requests" ADD COLUMN "subscription_id" uuid;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_tier_id_membership_tiers_id_fk" FOREIGN KEY ("tier_id") REFERENCES "public"."membership_tiers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "payment_provider_events_provider_event_unique" ON "payment_provider_events" USING btree ("provider","provider_event_id");--> statement-breakpoint
CREATE INDEX "payment_provider_events_claim_idx" ON "payment_provider_events" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "subscriptions_user_status_idx" ON "subscriptions" USING btree ("user_id","status");--> statement-breakpoint
CREATE INDEX "subscriptions_reconcile_idx" ON "subscriptions" USING btree ("status","updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "subscriptions_provider_subscription_ref_unique" ON "subscriptions" USING btree ("provider","provider_subscription_ref") WHERE "subscriptions"."provider_subscription_ref" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "subscriptions_one_nonterminal_per_identity" ON "subscriptions" USING btree ("user_id","tier_id","provider") NULLS NOT DISTINCT WHERE "subscriptions"."status" not in ('canceled','expired');--> statement-breakpoint
ALTER TABLE "payment_requests" ADD CONSTRAINT "payment_requests_subscription_id_subscriptions_id_fk" FOREIGN KEY ("subscription_id") REFERENCES "public"."subscriptions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "payment_requests_provider_invoice_ref_unique" ON "payment_requests" USING btree ("provider","provider_invoice_ref") WHERE "payment_requests"."provider_invoice_ref" is not null;--> statement-breakpoint
CREATE INDEX "payment_requests_subscription_idx" ON "payment_requests" USING btree ("subscription_id");
