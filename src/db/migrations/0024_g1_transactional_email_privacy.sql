-- Phase 5 / G1: remove raw recipient emails from durable transactional email tasks.
--
-- 0023 is already committed and journaled on this branch, so this unreleased
-- data migration is kept as a new 0024 instead of rewriting committed history.

CREATE OR REPLACE FUNCTION olp_g1_email_payload_to_text(payload jsonb, key text)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT NULLIF(payload ->> key, '')
$$;

CREATE OR REPLACE FUNCTION olp_g1_email_payload_param_to_text(payload jsonb, key text)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT NULLIF(payload #>> ARRAY['params', key], '')
$$;

CREATE OR REPLACE FUNCTION olp_g1_email_try_timestamptz(value text)
RETURNS timestamptz
LANGUAGE plpgsql
IMMUTABLE
AS $$
BEGIN
  RETURN NULLIF(value, '')::timestamptz;
EXCEPTION
  WHEN others THEN
    RETURN NULL;
END
$$;

CREATE OR REPLACE FUNCTION olp_g1_email_redacted_payload(payload jsonb)
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT jsonb_build_object(
    'version',
    COALESCE(
      CASE
        WHEN jsonb_typeof(payload -> 'version') = 'number' THEN (payload ->> 'version')::integer
        ELSE NULL
      END,
      1
    ),
    'template',
    COALESCE(payload ->> 'template', 'unknown'),
    'recipientRedacted',
    true
  )
$$;

WITH safe AS (
  SELECT
    t.id,
    jsonb_build_object(
      'version',
      2,
      'template',
      'membership_activated',
      'paymentRequestId',
      pr.id,
      'membershipId',
      m.id
    ) AS payload_json
  FROM tasks t
  JOIN payment_requests pr
    ON pr.id::text = substring(t.dedupe_key FROM '^email:membership_activated:([0-9a-f-]{36})$')
  JOIN memberships m
    ON m.id = pr.granted_membership_id
  JOIN users u
    ON u.id = pr.user_id
  JOIN membership_tiers mt
    ON mt.id = m.tier_id
  WHERE t.kind = 'email'
    AND t.status IN ('pending', 'failed', 'processing')
    AND t.payload_json ->> 'template' = 'membership_activated'
    AND t.payload_json ? 'to'
    AND pr.status = 'approved'
    AND pr.granted_membership_id IS NOT NULL
    AND m.user_id = pr.user_id
    AND lower(trim(u.email)) = lower(trim(t.payload_json ->> 'to'))
    AND mt.name = olp_g1_email_payload_param_to_text(t.payload_json, 'tierName')
    AND m.ends_at = olp_g1_email_try_timestamptz(
      olp_g1_email_payload_param_to_text(t.payload_json, 'endsAt')
    )
)
UPDATE tasks t
SET payload_json = safe.payload_json,
    updated_at = now()
FROM safe
WHERE t.id = safe.id;

WITH safe AS (
  SELECT
    t.id,
    jsonb_build_object(
      'version',
      2,
      'template',
      'membership_revoked',
      'paymentRequestId',
      pr.id,
      'membershipId',
      m.id
    ) AS payload_json
  FROM tasks t
  JOIN payment_requests pr
    ON pr.id::text = substring(t.dedupe_key FROM '^email:membership_revoked:([0-9a-f-]{36})$')
  JOIN memberships m
    ON m.id = pr.granted_membership_id
  JOIN users u
    ON u.id = pr.user_id
  JOIN membership_tiers mt
    ON mt.id = m.tier_id
  WHERE t.kind = 'email'
    AND t.status IN ('pending', 'failed', 'processing')
    AND t.payload_json ->> 'template' = 'membership_revoked'
    AND t.payload_json ? 'to'
    AND pr.status = 'reversed'
    AND pr.granted_membership_id IS NOT NULL
    AND m.user_id = pr.user_id
    AND lower(trim(u.email)) = lower(trim(t.payload_json ->> 'to'))
    AND mt.name = olp_g1_email_payload_param_to_text(t.payload_json, 'tierName')
)
UPDATE tasks t
SET payload_json = safe.payload_json,
    updated_at = now()
FROM safe
WHERE t.id = safe.id;

WITH safe AS (
  SELECT
    t.id,
    jsonb_build_object(
      'version',
      2,
      'template',
      'payment_rejected',
      'paymentRequestId',
      pr.id,
      'reviewedAt',
      substring(t.dedupe_key FROM '^email:payment_rejected:[0-9a-f-]{36}:(.+)$')
    ) AS payload_json
  FROM tasks t
  JOIN payment_requests pr
    ON pr.id::text = substring(t.dedupe_key FROM '^email:payment_rejected:([0-9a-f-]{36}):')
  JOIN users u
    ON u.id = pr.user_id
  JOIN membership_tiers mt
    ON mt.id = pr.tier_id
  WHERE t.kind = 'email'
    AND t.status IN ('pending', 'failed', 'processing')
    AND t.payload_json ->> 'template' = 'payment_rejected'
    AND t.payload_json ? 'to'
    AND pr.status = 'rejected'
    AND pr.reviewed_at IS NOT NULL
    AND pr.reviewed_at = olp_g1_email_try_timestamptz(
      substring(t.dedupe_key FROM '^email:payment_rejected:[0-9a-f-]{36}:(.+)$')
    )
    AND lower(trim(u.email)) = lower(trim(t.payload_json ->> 'to'))
    AND mt.name = olp_g1_email_payload_param_to_text(t.payload_json, 'tierName')
    AND COALESCE(pr.review_note, '') =
      COALESCE(olp_g1_email_payload_param_to_text(t.payload_json, 'reviewNote'), '')
)
UPDATE tasks t
SET payload_json = safe.payload_json,
    updated_at = now()
FROM safe
WHERE t.id = safe.id;

WITH safe AS (
  SELECT
    t.id,
    jsonb_build_object(
      'version',
      2,
      'template',
      'renewal_reminder',
      'subscriptionId',
      s.id,
      'periodEndsAt',
      olp_g1_email_payload_to_text(t.payload_json, 'periodEndsAt')
    ) AS payload_json
  FROM tasks t
  JOIN subscriptions s
    ON s.id::text = olp_g1_email_payload_to_text(t.payload_json, 'subscriptionId')
  JOIN users u
    ON u.id = s.user_id
  JOIN membership_tiers mt
    ON mt.id = s.tier_id
  WHERE t.kind = 'email'
    AND t.status IN ('pending', 'failed', 'processing')
    AND t.payload_json ->> 'template' = 'renewal_reminder'
    AND t.payload_json ? 'to'
    AND lower(trim(u.email)) = lower(trim(t.payload_json ->> 'to'))
    AND s.current_period_ends_at = olp_g1_email_try_timestamptz(
      olp_g1_email_payload_to_text(t.payload_json, 'periodEndsAt')
    )
    AND mt.name = olp_g1_email_payload_param_to_text(t.payload_json, 'tierName')
)
UPDATE tasks t
SET payload_json = safe.payload_json,
    updated_at = now()
FROM safe
WHERE t.id = safe.id;

UPDATE tasks
SET payload_json = olp_g1_email_redacted_payload(payload_json),
    updated_at = now()
WHERE kind = 'email'
  AND payload_json ? 'to'
  AND status IN ('succeeded', 'dead');

UPDATE tasks
SET status = 'dead',
    locked_at = NULL,
    locked_by = NULL,
    lease_until = NULL,
    last_error = 'Email recipient could not be migrated to a safe domain reference',
    payload_json = olp_g1_email_redacted_payload(payload_json),
    updated_at = now()
WHERE kind = 'email'
  AND payload_json ? 'to'
  AND status IN ('pending', 'failed', 'processing');

DO $$
DECLARE
  remaining integer;
BEGIN
  SELECT count(*)
    INTO remaining
  FROM tasks
  WHERE kind = 'email'
    AND payload_json ? 'to';

  IF remaining <> 0 THEN
    RAISE EXCEPTION 'G1 migration left % email task payload(s) with raw recipient', remaining;
  END IF;
END $$;

DROP FUNCTION olp_g1_email_payload_to_text(jsonb, text);
DROP FUNCTION olp_g1_email_payload_param_to_text(jsonb, text);
DROP FUNCTION olp_g1_email_try_timestamptz(text);
DROP FUNCTION olp_g1_email_redacted_payload(jsonb);
