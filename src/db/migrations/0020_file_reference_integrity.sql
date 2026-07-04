DO $file_reference_preflight$
DECLARE
  bad_id uuid;
  bad_key text;
BEGIN
  SELECT p.id INTO bad_id
    FROM posts p
    LEFT JOIN files f ON f.id = p.cover_file_id
   WHERE p.cover_file_id IS NOT NULL
     AND (
       f.id IS NULL
       OR f.quarantined_at IS NOT NULL
       OR f.purpose NOT IN ('cover', 'content_image')
     )
   LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'file reference preflight failed: posts.cover_file_id post_id=%', bad_id
      USING ERRCODE = '23514';
  END IF;

  SELECT pm.id INTO bad_id
    FROM payment_methods pm
    LEFT JOIN files f ON f.id = pm.qr_file_id
   WHERE pm.qr_file_id IS NOT NULL
     AND (
       f.id IS NULL
       OR f.quarantined_at IS NOT NULL
       OR f.purpose <> 'payment_qr'
     )
   LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'file reference preflight failed: payment_methods.qr_file_id method_id=%', bad_id
      USING ERRCODE = '23514';
  END IF;

  SELECT pr.id INTO bad_id
    FROM payment_requests pr
    LEFT JOIN files f ON f.id = pr.proof_file_id
   WHERE pr.proof_file_id IS NOT NULL
     AND (
       f.id IS NULL
       OR f.quarantined_at IS NOT NULL
       OR f.purpose <> 'payment_proof'
       OR f.created_by IS DISTINCT FROM pr.user_id
     )
   LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'file reference preflight failed: payment_requests.proof_file_id request_id=%', bad_id
      USING ERRCODE = '23514';
  END IF;

  SELECT pf.id INTO bad_id
    FROM post_files pf
    LEFT JOIN files f ON f.id = pf.file_id
   WHERE f.id IS NULL
      OR f.quarantined_at IS NOT NULL
      OR NOT (
        (pf.kind IN ('inline', 'image') AND f.purpose = 'content_image')
        OR (pf.kind = 'attachment' AND f.purpose = 'content_attachment')
        OR (pf.kind = 'cover' AND f.purpose IN ('cover', 'content_image'))
        OR (pf.kind = 'preview' AND f.purpose IN ('content_image', 'cover', 'thumbnail'))
        OR (pf.kind = 'thumbnail' AND f.purpose IN ('thumbnail', 'content_image'))
      )
   LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'file reference preflight failed: post_files.file_id post_file_id=%', bad_id
      USING ERRCODE = '23514';
  END IF;

  FOR bad_key IN
    SELECT s.key
      FROM site_settings s
      LEFT JOIN files f
        ON jsonb_typeof(s.value_json) = 'string'
       AND (s.value_json #>> '{}') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
       AND f.id = (s.value_json #>> '{}')::uuid
     WHERE s.key IN ('artist_avatar_file_id', 'site_logo_file_id', 'site_icon_file_id')
       AND (
         jsonb_typeof(s.value_json) <> 'string'
         OR (s.value_json #>> '{}') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
         OR f.id IS NULL
         OR f.quarantined_at IS NOT NULL
         OR f.purpose <> 'artist_avatar'
       )
  LOOP
    DELETE FROM site_settings WHERE key = bad_key;
    RAISE WARNING 'file reference preflight removed invalid site_settings key=%', bad_key;
  END LOOP;
END
$file_reference_preflight$;
--> statement-breakpoint
ALTER TABLE "post_files" DROP CONSTRAINT "post_files_file_id_files_id_fk";
--> statement-breakpoint
ALTER TABLE "payment_methods" ADD CONSTRAINT "payment_methods_qr_file_id_files_id_fk" FOREIGN KEY ("qr_file_id") REFERENCES "public"."files"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_requests" ADD CONSTRAINT "payment_requests_proof_file_id_files_id_fk" FOREIGN KEY ("proof_file_id") REFERENCES "public"."files"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "post_files" ADD CONSTRAINT "post_files_file_id_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."files"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "posts" ADD CONSTRAINT "posts_cover_file_id_files_id_fk" FOREIGN KEY ("cover_file_id") REFERENCES "public"."files"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION lock_site_setting_file_reference()
RETURNS trigger
LANGUAGE plpgsql
AS $site_setting_reference$
DECLARE
  referenced_id uuid;
  referenced_purpose text;
  referenced_quarantined_at timestamptz;
BEGIN
  IF NEW.key NOT IN ('artist_avatar_file_id', 'site_logo_file_id', 'site_icon_file_id') THEN
    RETURN NEW;
  END IF;
  IF jsonb_typeof(NEW.value_json) <> 'string'
     OR (NEW.value_json #>> '{}') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' THEN
    RAISE EXCEPTION 'invalid site file setting %', NEW.key USING ERRCODE = '23514';
  END IF;

  referenced_id := (NEW.value_json #>> '{}')::uuid;
  SELECT purpose, quarantined_at
    INTO referenced_purpose, referenced_quarantined_at
    FROM files
   WHERE id = referenced_id
   FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'site file setting % references missing file %', NEW.key, referenced_id
      USING ERRCODE = '23503';
  END IF;
  IF referenced_quarantined_at IS NOT NULL OR referenced_purpose <> 'artist_avatar' THEN
    RAISE EXCEPTION 'site file setting % references invalid file %', NEW.key, referenced_id
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$site_setting_reference$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS site_settings_file_reference_lock ON site_settings;
--> statement-breakpoint
CREATE TRIGGER site_settings_file_reference_lock
BEFORE INSERT OR UPDATE OF key, value_json ON site_settings
FOR EACH ROW
EXECUTE FUNCTION lock_site_setting_file_reference();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION prevent_site_setting_referenced_file_delete()
RETURNS trigger
LANGUAGE plpgsql
AS $prevent_site_setting_delete$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM site_settings
     WHERE key IN ('artist_avatar_file_id', 'site_logo_file_id', 'site_icon_file_id')
       AND CASE
             WHEN jsonb_typeof(value_json) = 'string'
              AND (value_json #>> '{}') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
             THEN (value_json #>> '{}')::uuid = OLD.id
             ELSE FALSE
           END
  ) THEN
    RAISE EXCEPTION 'file % is referenced by site_settings', OLD.id USING ERRCODE = '23503';
  END IF;
  RETURN OLD;
END
$prevent_site_setting_delete$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS files_site_settings_reference_restrict ON files;
--> statement-breakpoint
CREATE TRIGGER files_site_settings_reference_restrict
BEFORE DELETE ON files
FOR EACH ROW
EXECUTE FUNCTION prevent_site_setting_referenced_file_delete();
