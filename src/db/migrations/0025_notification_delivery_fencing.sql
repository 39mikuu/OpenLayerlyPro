-- PR #162 round 2: fence notification delivery finalization and make quota refunds exact.

ALTER TABLE notification_delivery_attempts
  ADD COLUMN reserved_utc_day date,
  ADD COLUMN reserved_minute timestamptz,
  ADD COLUMN operator_recheck_count integer NOT NULL DEFAULT 0,
  ADD COLUMN operator_last_checked_at timestamptz,
  ADD CONSTRAINT notification_delivery_attempts_operator_recheck_count_nonnegative
    CHECK (operator_recheck_count >= 0);

ALTER TABLE notification_delivery_attempts
  DROP CONSTRAINT notification_delivery_attempts_outcome_check,
  ADD CONSTRAINT notification_delivery_attempts_outcome_check
    CHECK (outcome IN (
      'started',
      'accepted',
      'permanent_failure',
      'transient_failure',
      'needs_operator_defer',
      'lease_expired',
      'budget_defer',
      'pacing_defer',
      'suppressed_skip',
      'stale_skip',
      'post_not_published_skip',
      'access_lost_skip',
      'preference_disabled_skip',
      'user_missing_skip'
    ));

CREATE INDEX IF NOT EXISTS notification_suppressions_first_delivery_idx
  ON notification_suppressions(first_delivery_id);

CREATE INDEX IF NOT EXISTS notification_suppressions_last_delivery_idx
  ON notification_suppressions(last_delivery_id);
