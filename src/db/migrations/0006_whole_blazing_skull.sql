CREATE INDEX "login_codes_email_created_idx" ON "login_codes" USING btree ("email","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "login_codes_email_active_idx" ON "login_codes" USING btree ("email","expires_at","used_at");--> statement-breakpoint
CREATE INDEX "memberships_user_active_idx" ON "memberships" USING btree ("user_id","starts_at","ends_at");--> statement-breakpoint
CREATE INDEX "memberships_tier_id_idx" ON "memberships" USING btree ("tier_id");--> statement-breakpoint
CREATE INDEX "payment_requests_user_created_idx" ON "payment_requests" USING btree ("user_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "payment_requests_status_created_idx" ON "payment_requests" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "payment_requests_pending_user_tier_idx" ON "payment_requests" USING btree ("user_id","tier_id","status");--> statement-breakpoint
CREATE INDEX "post_files_post_sort_idx" ON "post_files" USING btree ("post_id","sort_order");--> statement-breakpoint
CREATE INDEX "post_files_file_id_idx" ON "post_files" USING btree ("file_id");--> statement-breakpoint
CREATE INDEX "posts_status_published_idx" ON "posts" USING btree ("status","published_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "sessions_token_hash_idx" ON "sessions" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "sessions_expires_at_idx" ON "sessions" USING btree ("expires_at");