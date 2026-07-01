DROP INDEX "payment_requests_status_created_idx";--> statement-breakpoint
CREATE INDEX "files_created_id_active_idx" ON "files" USING btree ("created_at" DESC NULLS LAST,"id" DESC NULLS LAST) WHERE "files"."quarantined_at" is null;--> statement-breakpoint
CREATE INDEX "files_quarantined_id_idx" ON "files" USING btree ("quarantined_at" DESC NULLS LAST,"id" DESC NULLS LAST) WHERE "files"."quarantined_at" is not null;--> statement-breakpoint
CREATE INDEX "memberships_created_id_idx" ON "memberships" USING btree ("created_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "payment_requests_created_id_idx" ON "payment_requests" USING btree ("created_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "payment_requests_status_created_id_idx" ON "payment_requests" USING btree ("status","created_at" DESC NULLS LAST,"id" DESC NULLS LAST);