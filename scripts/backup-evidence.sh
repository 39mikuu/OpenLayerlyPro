#!/bin/sh
# Publish non-secret evidence for the most recent successfully assembled backup.
# This file is sourced; callers provide fail() and the manifest variables below.

backup_atomic_link_file() {
  backup_link_source=$1
  backup_link_target=$2

  # linkSync addresses the exact target path. Unlike plain `ln source target`, it
  # cannot follow a directory (or a symlink to one) and leave a hard link inside.
  node -e '
    const fs = require("fs");
    fs.linkSync(process.argv[1], process.argv[2]);
  ' "$backup_link_source" "$backup_link_target"
}

backup_paths_share_inode() {
  backup_inode_source=$1
  backup_inode_target=$2

  node -e '
    const fs = require("fs");
    const source = fs.statSync(process.argv[1], { bigint: true });
    const target = fs.lstatSync(process.argv[2], { bigint: true });
    if (!target.isFile() || source.dev !== target.dev || source.ino !== target.ino) {
      process.exit(1);
    }
  ' "$backup_inode_source" "$backup_inode_target"
}

backup_atomic_link_file_reconciled() {
  backup_reconcile_source=$1
  backup_reconcile_target=$2

  if backup_atomic_link_file "$backup_reconcile_source" "$backup_reconcile_target"; then
    return 0
  fi

  # A process-group signal can terminate the Node helper after linkSync(2)
  # succeeds but before it exits 0. Reconcile the unique temp inode before
  # deciding that this run does not own the target.
  backup_paths_share_inode "$backup_reconcile_source" "$backup_reconcile_target"
}

backup_defer_publication_signals() {
  BACKUP_PUBLICATION_DEFERRED_SIGNAL=0
  trap 'BACKUP_PUBLICATION_DEFERRED_SIGNAL=129' HUP
  trap 'BACKUP_PUBLICATION_DEFERRED_SIGNAL=130' INT
  trap 'BACKUP_PUBLICATION_DEFERRED_SIGNAL=143' TERM
}

backup_restore_publication_signals() {
  trap 'exit 129' HUP
  trap 'exit 130' INT
  trap 'exit 143' TERM
  if [ "$BACKUP_PUBLICATION_DEFERRED_SIGNAL" -ne 0 ]; then
    exit "$BACKUP_PUBLICATION_DEFERRED_SIGNAL"
  fi
}

acquire_backup_publication_lock() {
  backup_lock_output_dir=$1
  BACKUP_PUBLICATION_LOCK_PATH="$backup_lock_output_dir/.openlayerly-backup-publication.lock"
  BACKUP_PUBLICATION_LOCK_OWNER_PATH="$backup_lock_output_dir/.openlayerly-backup-publication.owner.$BACKUP_PUBLICATION_LOCK_OWNER_ID"
  backup_defer_publication_signals
  case $- in
    *C*) backup_lock_noclobber_was_set=true ;;
    *)
      backup_lock_noclobber_was_set=false
      set -C
      ;;
  esac
  case $- in
    *e*)
      backup_lock_errexit_was_set=true
      set +e
      ;;
    *) backup_lock_errexit_was_set=false ;;
  esac
  printf '%s\n' "$BACKUP_PUBLICATION_LOCK_OWNER_ID" > "$BACKUP_PUBLICATION_LOCK_OWNER_PATH"
  backup_lock_create_status=$?
  if [ "$backup_lock_errexit_was_set" = true ]; then
    set -e
  fi
  if [ "$backup_lock_create_status" -ne 0 ]; then
    [ "$backup_lock_noclobber_was_set" = true ] || set +C
    # The path may name a stale or live owner created by another run (including
    # after PID reuse). Do not leave it armed for this run's EXIT cleanup.
    BACKUP_PUBLICATION_LOCK_OWNER_PATH=""
    backup_restore_publication_signals
    fail "unable to create unique backup publication lock owner"
  fi
  [ "$backup_lock_noclobber_was_set" = true ] || set +C
  if ! chmod 600 "$BACKUP_PUBLICATION_LOCK_OWNER_PATH"; then
    backup_restore_publication_signals
    fail "unable to secure backup publication lock owner"
  fi
  if ! backup_atomic_link_file_reconciled \
    "$BACKUP_PUBLICATION_LOCK_OWNER_PATH" \
    "$BACKUP_PUBLICATION_LOCK_PATH"; then
    rm -f "$BACKUP_PUBLICATION_LOCK_OWNER_PATH" || true
    BACKUP_PUBLICATION_LOCK_OWNER_PATH=""
    backup_restore_publication_signals
    fail "another backup publication is active or its stale lock requires operator review"
  fi
  BACKUP_PUBLICATION_LOCK_HELD=true
  backup_restore_publication_signals
}

backup_publication_lock_still_owned() {
  [ -n "$BACKUP_PUBLICATION_LOCK_OWNER_PATH" ] || return 2

  # Three-state reconciliation for a failed unlink helper:
  #   0: the fixed lock is still our owner inode;
  #   1: the fixed lock is absent or belongs to a successor;
  #   2: ownership could not be inspected safely.
  # Inspection errors must not be folded into "successor" because doing so
  # would discard the owner evidence while an inaccessible lock may remain.
  node -e '
    const fs = require("fs");
    let owner;
    try {
      owner = fs.statSync(process.argv[1], { bigint: true });
    } catch {
      process.exit(2);
    }
    let lock;
    try {
      lock = fs.lstatSync(process.argv[2], { bigint: true });
    } catch (error) {
      if (error?.code === "ENOENT") process.exit(1);
      process.exit(2);
    }
    if (!lock.isFile() || owner.dev !== lock.dev || owner.ino !== lock.ino) {
      process.exit(1);
    }
  ' "$BACKUP_PUBLICATION_LOCK_OWNER_PATH" "$BACKUP_PUBLICATION_LOCK_PATH"
}

backup_unlink_owned_publication_lock() {
  node -e '
    const fs = require("fs");
    const owner = fs.statSync(process.argv[1], { bigint: true });
    let lock;
    try {
      lock = fs.lstatSync(process.argv[2], { bigint: true });
    } catch (error) {
      if (error?.code === "ENOENT") process.exit(0);
      throw error;
    }
    if (!lock.isFile() || owner.dev !== lock.dev || owner.ino !== lock.ino) {
      process.exit(0);
    }
    fs.unlinkSync(process.argv[2]);
  ' "$BACKUP_PUBLICATION_LOCK_OWNER_PATH" "$BACKUP_PUBLICATION_LOCK_PATH"
}

release_backup_publication_lock() {
  if [ "$BACKUP_PUBLICATION_LOCK_HELD" != true ]; then
    return 0
  fi
  if ! backup_unlink_owned_publication_lock; then
    if backup_publication_lock_still_owned; then
      return 1
    else
      backup_lock_inspection_status=$?
      [ "$backup_lock_inspection_status" -eq 1 ] || return 1
    fi
  fi
  BACKUP_PUBLICATION_LOCK_HELD=false
  if [ -n "$BACKUP_PUBLICATION_LOCK_OWNER_PATH" ]; then
    if ! rm -f "$BACKUP_PUBLICATION_LOCK_OWNER_PATH"; then
      [ ! -e "$BACKUP_PUBLICATION_LOCK_OWNER_PATH" ] || return 1
    fi
    BACKUP_PUBLICATION_LOCK_OWNER_PATH=""
  fi
}

remove_owned_backup_publication_artifacts() {
  if [ "$BACKUP_ARCHIVE_PUBLISHED" = true ]; then
    rm -f "$ARCHIVE_PATH" || return 1
    BACKUP_ARCHIVE_PUBLISHED=false
  fi
  if [ "$BACKUP_EVIDENCE_ARCHIVE_PUBLISHED" = true ]; then
    rm -f "$BACKUP_EVIDENCE_ARCHIVE_PATH" || return 1
    BACKUP_EVIDENCE_ARCHIVE_PUBLISHED=false
  fi
}

cleanup_incomplete_backup_publication() {
  rollback_backup_evidence_commit || return 1
  remove_owned_backup_publication_artifacts || return 1
}

publish_backup_archive() {
  backup_publish_source=$1
  backup_publish_target=$2

  # The temporary archive is created in the output directory, so a hard link is
  # an atomic, no-clobber publication. The publication lock protects the latest
  # pointer's rollback window across concurrent backup processes.
  backup_defer_publication_signals
  if ! backup_atomic_link_file_reconciled "$backup_publish_source" "$backup_publish_target"; then
    backup_restore_publication_signals
    fail "archive path already exists; refusing to overwrite recovery evidence"
  fi
  BACKUP_ARCHIVE_PUBLISHED=true
  # shellcheck disable=SC2034 # Consumed by backup.sh's EXIT cleanup.
  ARCHIVE_PENDING_EVIDENCE=true
  backup_restore_publication_signals
  if [ ! -f "$backup_publish_target" ] \
    || [ -L "$backup_publish_target" ] \
    || [ "$(stat -c %a "$backup_publish_target")" != 600 ]; then
    fail "published archive is not a regular 0600 file"
  fi
  rm -f "$backup_publish_source" || fail "unable to remove published archive temporary file"
}

backup_atomic_replace_file() {
  backup_replace_source=$1
  backup_replace_target=$2

  # fs.renameSync maps directly to rename(2): unlike `mv file directory`, it
  # cannot silently place the source inside a directory target. It also replaces
  # a symlink itself instead of following it.
  node -e '
    const fs = require("fs");
    fs.renameSync(process.argv[1], process.argv[2]);
  ' "$backup_replace_source" "$backup_replace_target"
}

backup_validate_latest_evidence_target() {
  backup_latest_target=$1

  if [ -L "$backup_latest_target" ] || { [ -e "$backup_latest_target" ] && [ ! -f "$backup_latest_target" ]; }; then
    fail "latest backup evidence target must be a regular file or absent"
  fi
}

rollback_backup_evidence_commit() {
  if [ "$BACKUP_EVIDENCE_LATEST_COMMITTING" != true ]; then
    return 0
  fi

  if [ -n "$BACKUP_EVIDENCE_PREVIOUS_LATEST_TMP" ]; then
    backup_atomic_replace_file \
      "$BACKUP_EVIDENCE_PREVIOUS_LATEST_TMP" \
      "$BACKUP_EVIDENCE_LATEST_PATH" \
      || return 1
    BACKUP_EVIDENCE_PREVIOUS_LATEST_TMP=""
  else
    rm -f "$BACKUP_EVIDENCE_LATEST_PATH" || return 1
  fi
  BACKUP_EVIDENCE_LATEST_COMMITTING=false
}

finalize_backup_evidence_commit() {
  if [ -n "$BACKUP_EVIDENCE_PREVIOUS_LATEST_TMP" ]; then
    rm -f "$BACKUP_EVIDENCE_PREVIOUS_LATEST_TMP" || return 1
    BACKUP_EVIDENCE_PREVIOUS_LATEST_TMP=""
  fi
  BACKUP_EVIDENCE_LATEST_COMMITTING=false
}

publish_backup_evidence() {
  backup_evidence_archive_path=$1
  backup_evidence_output_dir=$2
  backup_evidence_archive_basename=${backup_evidence_archive_path##*/}

  case "$backup_evidence_archive_basename" in
    ""|*/*|*\\*|*' '*) fail "archive basename is unsafe for recovery evidence" ;;
  esac

  tar -tzf "$backup_evidence_archive_path" >/dev/null \
    || fail "published archive failed gzip/tar readability verification"

  backup_evidence_sha256_output=$(sha256sum "$backup_evidence_archive_path") \
    || fail "unable to fingerprint published archive"
  backup_evidence_archive_sha256=$(printf '%s\n' "$backup_evidence_sha256_output" | awk '{print $1}')
  [ "${#backup_evidence_archive_sha256}" -eq 64 ] \
    || fail "published archive fingerprint has an invalid length"
  case "$backup_evidence_archive_sha256" in
    *[!0-9a-f]*) fail "published archive fingerprint is malformed" ;;
  esac
  backup_evidence_archive_bytes=$(stat -c %s "$backup_evidence_archive_path") \
    || fail "unable to read published archive size"

  if [ "$STOP_APP" = true ]; then
    backup_evidence_consistency=stopped
  else
    backup_evidence_consistency=hot
  fi

  if [ "$STORAGE_DRIVER" = s3 ]; then
    backup_evidence_object_recovery_status=required
  else
    # backup.sh only sees the container environment fallback. Historical S3 rows
    # may still exist after a DB-backed driver change, so "not-required" would
    # overstate what this capture proved.
    backup_evidence_object_recovery_status=unknown
  fi

  # The current backup format does not archive or fingerprint the dedicated
  # Magic Link current/previous keyring. The Compose entrypoint provisions the
  # current key even when intake is gated off. Every recovery set must therefore
  # carry the matching Magic Link material separately, and this aggregate warning
  # cannot be false even when archived session/notification sources are file-backed.
  backup_evidence_magic_link_secret_recovery_status=required
  backup_evidence_external_secret_required=true

  BACKUP_EVIDENCE_ARCHIVE_PATH="$backup_evidence_archive_path.evidence.env"
  BACKUP_EVIDENCE_LATEST_PATH="$backup_evidence_output_dir/last-successful-backup.env"
  backup_validate_latest_evidence_target "$BACKUP_EVIDENCE_LATEST_PATH"
  BACKUP_EVIDENCE_TMP=$(mktemp "$backup_evidence_output_dir/.backup-evidence.XXXXXX") \
    || fail "unable to create backup evidence temporary file"
  chmod 600 "$BACKUP_EVIDENCE_TMP" || fail "unable to secure backup evidence temporary file"

  {
    echo "EVIDENCE_VERSION=1"
    echo "ARCHIVE_BASENAME=$backup_evidence_archive_basename"
    echo "ARCHIVE_SHA256=$backup_evidence_archive_sha256"
    echo "ARCHIVE_BYTES=$backup_evidence_archive_bytes"
    echo "CREATED_AT_UTC=$CREATED_AT_UTC"
    echo "CAPTURE_CONSISTENCY=$backup_evidence_consistency"
    echo "RUNTIME_APP_VERSION=$RUNTIME_APP_VERSION"
    echo "RUNTIME_SOURCE_COMMIT=$RUNTIME_SOURCE_COMMIT"
    echo "RUNTIME_IMAGE_ID=$RUNTIME_IMAGE_ID"
    echo "BACKUP_TOOL_COMMIT=$BACKUP_TOOL_COMMIT"
    echo "BACKUP_TOOL_SCRIPT_SHA256=$BACKUP_TOOL_SCRIPT_SHA256"
    echo "LATEST_MIGRATION_HASH=$LATEST_MIGRATION_HASH"
    echo "STORAGE_DRIVER_FALLBACK=$STORAGE_DRIVER"
    echo "UPLOADS_INCLUDED=$UPLOADS_INCLUDED"
    echo "OBJECT_STORAGE_RECOVERY_STATUS=$backup_evidence_object_recovery_status"
    echo "MAGIC_LINK_SECRET_RECOVERY_STATUS=$backup_evidence_magic_link_secret_recovery_status"
    echo "EXTERNAL_SECRET_RECOVERY_REQUIRED=$backup_evidence_external_secret_required"
    echo "ARCHIVE_SELF_CHECK=passed"
    echo "RESTORE_DRILL_VERIFIED=false"
    echo "RECOVERABILITY_STATUS=unverified"
  } > "$BACKUP_EVIDENCE_TMP"

  backup_defer_publication_signals
  if ! backup_atomic_link_file_reconciled "$BACKUP_EVIDENCE_TMP" "$BACKUP_EVIDENCE_ARCHIVE_PATH"; then
    backup_restore_publication_signals
    fail "unable to publish per-archive backup evidence"
  fi
  BACKUP_EVIDENCE_ARCHIVE_PUBLISHED=true
  backup_restore_publication_signals
  if [ ! -f "$BACKUP_EVIDENCE_ARCHIVE_PATH" ] \
    || [ -L "$BACKUP_EVIDENCE_ARCHIVE_PATH" ] \
    || [ "$(stat -c %a "$BACKUP_EVIDENCE_ARCHIVE_PATH")" != 600 ]; then
    fail "published per-archive backup evidence is not a regular 0600 file"
  fi
  rm -f "$BACKUP_EVIDENCE_TMP" \
    || fail "unable to remove per-archive evidence temporary file"
  BACKUP_EVIDENCE_TMP=""

  if [ -e "$BACKUP_EVIDENCE_LATEST_PATH" ]; then
    BACKUP_EVIDENCE_PREVIOUS_LATEST_TMP=$(mktemp "$backup_evidence_output_dir/.previous-last-successful-backup.XXXXXX") \
      || fail "unable to preserve previous latest backup evidence"
    cp "$BACKUP_EVIDENCE_LATEST_PATH" "$BACKUP_EVIDENCE_PREVIOUS_LATEST_TMP" \
      || fail "unable to preserve previous latest backup evidence"
    chmod 600 "$BACKUP_EVIDENCE_PREVIOUS_LATEST_TMP" \
      || fail "unable to secure previous latest backup evidence"
  fi

  BACKUP_EVIDENCE_TMP=$(mktemp "$backup_evidence_output_dir/.last-successful-backup.XXXXXX") \
    || fail "unable to create latest backup evidence temporary file"
  cp "$BACKUP_EVIDENCE_ARCHIVE_PATH" "$BACKUP_EVIDENCE_TMP" \
    || fail "unable to stage latest backup evidence"
  chmod 600 "$BACKUP_EVIDENCE_TMP" || fail "unable to secure latest backup evidence"
  BACKUP_EVIDENCE_LATEST_COMMITTING=true
  backup_atomic_replace_file "$BACKUP_EVIDENCE_TMP" "$BACKUP_EVIDENCE_LATEST_PATH" \
    || fail "unable to publish latest backup evidence"
  BACKUP_EVIDENCE_TMP=""
  if [ ! -f "$BACKUP_EVIDENCE_LATEST_PATH" ] \
    || [ -L "$BACKUP_EVIDENCE_LATEST_PATH" ] \
    || [ "$(stat -c %a "$BACKUP_EVIDENCE_LATEST_PATH")" != 600 ]; then
    fail "published latest backup evidence is not a regular 0600 file"
  fi
}
