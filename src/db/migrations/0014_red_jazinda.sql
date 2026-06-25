DO $$
DECLARE
  conflicts text;
BEGIN
  SELECT string_agg(
    format('user_id=%s tier_id=%s count=%s', user_id, tier_id, pending_count),
    E'\n' ORDER BY user_id, tier_id
  )
  INTO conflicts
  FROM (
    SELECT user_id, tier_id, count(*) AS pending_count
    FROM payment_requests
    WHERE status IN ('pending_review', 'pending_payment')
    GROUP BY user_id, tier_id
    HAVING count(*) > 1
  ) duplicate_pending;

  IF conflicts IS NOT NULL THEN
    RAISE EXCEPTION 'duplicate pending payment requests detected:%', E'\n' || conflicts
      USING HINT = 'Run scripts/dedupe-pending-payments.mjs, explicitly choose the request to keep, then rerun migrations.';
  END IF;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX "payment_requests_pending_user_tier_unique" ON "payment_requests" USING btree ("user_id","tier_id") WHERE "payment_requests"."status" in ('pending_review', 'pending_payment');
