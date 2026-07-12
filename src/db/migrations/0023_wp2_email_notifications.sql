CREATE TABLE notification_preferences (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  new_post_email_enabled boolean NOT NULL DEFAULT false,
  version integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT notification_preferences_version_nonnegative CHECK (version >= 0)
);

CREATE UNIQUE INDEX notification_preferences_user_unique
  ON notification_preferences(user_id);

CREATE INDEX notification_preferences_new_post_opt_in_idx
  ON notification_preferences(user_id)
  WHERE new_post_email_enabled = true;

CREATE TABLE notification_campaigns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  post_id uuid NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'pending',
  source text NOT NULL,
  published_at timestamptz NOT NULL,
  cursor_user_id uuid,
  expansion_completed_at timestamptz,
  completed_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT notification_campaigns_status_check
    CHECK (status IN ('pending','expanding','expanded','sending','completed','dead')),
  CONSTRAINT notification_campaigns_source_check
    CHECK (source IN ('manual_publish','scheduled_publish'))
);

CREATE UNIQUE INDEX notification_campaigns_post_unique
  ON notification_campaigns(post_id);

CREATE INDEX notification_campaigns_status_cursor_idx
  ON notification_campaigns(status, cursor_user_id, id);

CREATE INDEX notification_campaigns_finalize_idx
  ON notification_campaigns(status, updated_at, id)
  WHERE status IN ('expanded','sending');

CREATE TABLE notification_deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id uuid NOT NULL REFERENCES notification_campaigns(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  task_id uuid NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'queued',
  attempt_count integer NOT NULL DEFAULT 0,
  last_attempt_at timestamptz,
  next_attempt_after timestamptz,
  last_outcome text,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT notification_deliveries_status_check
    CHECK (status IN ('queued','sending','accepted','suppressed','skipped','deferred','failed','dead')),
  CONSTRAINT notification_deliveries_attempt_count_nonnegative CHECK (attempt_count >= 0)
);

ALTER TABLE notification_deliveries
  ADD CONSTRAINT notification_deliveries_task_id_fkey
  FOREIGN KEY (task_id) REFERENCES tasks(id)
  ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED;

CREATE UNIQUE INDEX notification_deliveries_campaign_user_unique
  ON notification_deliveries(campaign_id, user_id);

CREATE INDEX notification_deliveries_campaign_status_idx
  ON notification_deliveries(campaign_id, status, user_id);

CREATE INDEX notification_deliveries_campaign_nonterminal_idx
  ON notification_deliveries(campaign_id, status, id)
  WHERE status IN ('queued','sending','deferred','failed');

CREATE INDEX notification_deliveries_user_idx
  ON notification_deliveries(user_id, created_at DESC);

CREATE TABLE notification_delivery_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  delivery_id uuid NOT NULL REFERENCES notification_deliveries(id) ON DELETE CASCADE,
  campaign_id uuid NOT NULL REFERENCES notification_campaigns(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  task_id uuid REFERENCES tasks(id) ON DELETE SET NULL,
  attempt_number integer NOT NULL,
  attempt_utc_day date NOT NULL,
  attempt_minute timestamptz NOT NULL,
  smtp_attempted boolean NOT NULL DEFAULT false,
  outcome text NOT NULL,
  recipient_locale text,
  recipient_digest_key_id text,
  recipient_digest text,
  message_snapshot jsonb,
  error_kind text,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  CONSTRAINT notification_delivery_attempts_number_positive CHECK (attempt_number > 0),
  CONSTRAINT notification_delivery_attempts_outcome_check
    CHECK (outcome IN (
      'started',
      'accepted',
      'permanent_failure',
      'transient_failure',
      'needs_operator_defer',
      'budget_defer',
      'pacing_defer',
      'suppressed_skip',
      'stale_skip',
      'post_not_published_skip',
      'access_lost_skip',
      'preference_disabled_skip',
      'user_missing_skip'
    ))
);

CREATE UNIQUE INDEX notification_delivery_attempts_delivery_number_unique
  ON notification_delivery_attempts(delivery_id, attempt_number);

CREATE INDEX notification_delivery_attempts_budget_idx
  ON notification_delivery_attempts(attempt_utc_day, created_at, id)
  WHERE smtp_attempted = true;

CREATE INDEX notification_delivery_attempts_minute_idx
  ON notification_delivery_attempts(attempt_minute, created_at, id)
  WHERE smtp_attempted = true;

CREATE INDEX notification_delivery_attempts_campaign_idx
  ON notification_delivery_attempts(campaign_id, created_at DESC, id DESC);

CREATE INDEX notification_delivery_attempts_delivery_idx
  ON notification_delivery_attempts(delivery_id, created_at DESC, id DESC);

CREATE TABLE notification_quota_windows (
  window_kind text NOT NULL,
  window_start timestamptz NOT NULL,
  attempted_count integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (window_kind, window_start),
  CONSTRAINT notification_quota_windows_kind_check CHECK (window_kind IN ('utc_day','utc_minute')),
  CONSTRAINT notification_quota_windows_count_nonnegative CHECK (attempted_count >= 0)
);

CREATE TABLE notification_suppressions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email_digest_key_id text NOT NULL,
  email_digest text NOT NULL,
  reason text NOT NULL DEFAULT 'smtp_permanent_5xx',
  first_delivery_id uuid REFERENCES notification_deliveries(id) ON DELETE SET NULL,
  last_delivery_id uuid REFERENCES notification_deliveries(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT notification_suppressions_reason_check
    CHECK (reason IN ('smtp_permanent_5xx'))
);

CREATE UNIQUE INDEX notification_suppressions_email_digest_unique
  ON notification_suppressions(email_digest_key_id, email_digest);

ALTER TABLE tasks
  ADD COLUMN priority integer,
  ADD COLUMN queue_class text;

UPDATE tasks
SET
  queue_class = CASE
    WHEN kind = 'auth.login_code_email' THEN 'transactional'
    WHEN kind = 'email' THEN 'transactional'
    WHEN kind = 'subscription.renewal_reminder' THEN 'transactional'
    WHEN kind IN ('publish_post','payment_provider_event.dispatch','subscription.reconcile') THEN 'default'
    WHEN kind IN ('file.cleanup_orphan','storage.delete_object','payment_proof.cleanup') THEN 'maintenance'
    ELSE 'default'
  END,
  priority = CASE
    WHEN kind = 'auth.login_code_email' THEN 0
    WHEN kind = 'email' THEN 10
    WHEN kind = 'subscription.renewal_reminder' THEN 10
    WHEN kind = 'publish_post' THEN 20
    WHEN kind = 'payment_provider_event.dispatch' THEN 20
    WHEN kind = 'subscription.reconcile' THEN 30
    WHEN kind IN ('file.cleanup_orphan','storage.delete_object','payment_proof.cleanup') THEN 120
    ELSE 100
  END;

ALTER TABLE tasks
  ALTER COLUMN priority SET DEFAULT 100,
  ALTER COLUMN priority SET NOT NULL,
  ALTER COLUMN queue_class SET DEFAULT 'default',
  ALTER COLUMN queue_class SET NOT NULL;

ALTER TABLE tasks
  ADD CONSTRAINT tasks_queue_class_check
  CHECK (queue_class IN ('transactional','notification','maintenance','default'));

CREATE INDEX tasks_claimable_class_due_idx
  ON tasks(queue_class, run_after, priority, id)
  WHERE status IN ('pending','failed') AND attempts < max_attempts;

CREATE INDEX tasks_stale_class_due_idx
  ON tasks(queue_class, lease_until, priority, id)
  WHERE status = 'processing' AND attempts < max_attempts;
