ALTER TABLE "membership_tiers" ADD COLUMN "price_amount_minor" bigint;--> statement-breakpoint
ALTER TABLE "membership_tiers" ADD COLUMN "currency" text;--> statement-breakpoint
ALTER TABLE "payment_requests" ADD COLUMN "flow" text DEFAULT 'manual' NOT NULL;--> statement-breakpoint
ALTER TABLE "payment_requests" ADD COLUMN "provider" text;--> statement-breakpoint
ALTER TABLE "payment_requests" ADD COLUMN "provider_ref" text;--> statement-breakpoint
ALTER TABLE "payment_requests" ADD COLUMN "provider_event_id" text;--> statement-breakpoint
ALTER TABLE "payment_requests" ADD COLUMN "amount_minor" bigint;--> statement-breakpoint
ALTER TABLE "payment_requests" ADD COLUMN "currency" text;--> statement-breakpoint
CREATE UNIQUE INDEX "payment_requests_provider_event_id_unique" ON "payment_requests" USING btree ("provider_event_id");--> statement-breakpoint
CREATE INDEX "payment_requests_provider_ref_idx" ON "payment_requests" USING btree ("provider_ref");