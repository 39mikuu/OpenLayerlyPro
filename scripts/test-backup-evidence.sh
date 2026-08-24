#!/bin/sh
set -eu

ROOT_DIR=$(CDPATH='' cd -- "$(dirname "$0")/.." && pwd)

fail() {
  echo "backup-evidence-test: $*" >&2
  exit 1
}

# shellcheck source=scripts/backup-evidence.sh disable=SC1091
. "$ROOT_DIR/scripts/backup-evidence.sh"

TEST_DIR=$(mktemp -d "${TMPDIR:-/tmp}/openlayerly-backup-evidence.XXXXXX")
trap 'rm -rf "$TEST_DIR"' EXIT

mkdir -p "$TEST_DIR/payload"
printf '%s\n' 'test database dump' > "$TEST_DIR/payload/db.sql"
ARCHIVE_PATH="$TEST_DIR/openlayerly-backup-20260824-120000.tar.gz"
tar -czf "$ARCHIVE_PATH" -C "$TEST_DIR/payload" .

STOP_APP=true
CREATED_AT_UTC=2026-08-24T12:00:00Z
RUNTIME_APP_VERSION=1.2.3
RUNTIME_SOURCE_COMMIT=0123456789abcdef0123456789abcdef01234567
RUNTIME_IMAGE_ID=sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
BACKUP_TOOL_COMMIT=89abcdef0123456789abcdef0123456789abcdef
BACKUP_TOOL_SCRIPT_SHA256=abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789
LATEST_MIGRATION_HASH=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
STORAGE_DRIVER=local
UPLOADS_INCLUDED=true
BACKUP_EVIDENCE_ARCHIVE_PATH=""
BACKUP_EVIDENCE_TMP=""
BACKUP_EVIDENCE_LATEST_PATH=""
BACKUP_EVIDENCE_LATEST_COMMITTING=false
BACKUP_EVIDENCE_PREVIOUS_LATEST_TMP=""
BACKUP_ARCHIVE_PUBLISHED=false
BACKUP_EVIDENCE_ARCHIVE_PUBLISHED=false
BACKUP_PUBLICATION_LOCK_PATH=""
BACKUP_PUBLICATION_LOCK_OWNER_ID=test-owner
BACKUP_PUBLICATION_LOCK_OWNER_PATH=""
BACKUP_PUBLICATION_LOCK_HELD=false
BACKUP_PUBLICATION_DEFERRED_SIGNAL=0

echo "Verifying a pre-existing same-ID owner remains fail closed..."
PRESEEDED_OWNER_PATH="$TEST_DIR/.openlayerly-backup-publication.owner.test-preseeded-owner"
printf '%s\n' pre-existing-owner > "$PRESEEDED_OWNER_PATH"
chmod 600 "$PRESEEDED_OWNER_PATH"
set +e
(
  fail() { exit 42; }
  BACKUP_PUBLICATION_LOCK_OWNER_ID=test-preseeded-owner
  BACKUP_PUBLICATION_LOCK_OWNER_PATH=""
  BACKUP_PUBLICATION_LOCK_HELD=false
  acquire_backup_publication_lock "$TEST_DIR"
) >/dev/null 2>&1
PRESEEDED_OWNER_STATUS=$?
set -e
[ "$PRESEEDED_OWNER_STATUS" -eq 42 ] \
  || fail "pre-existing owner did not reach the controlled fail path"
[ "$(cat "$PRESEEDED_OWNER_PATH")" = pre-existing-owner ] \
  || fail "failed acquisition removed a pre-existing owner"
rm -f "$PRESEEDED_OWNER_PATH"

echo "Verifying publication locking rejects deterministic concurrent entry..."
acquire_backup_publication_lock "$TEST_DIR"
set +e
(
  fail() { exit 42; }
  BACKUP_PUBLICATION_LOCK_OWNER_ID=test-competitor
  # shellcheck disable=SC2030 # These values intentionally belong only to the competitor subshell.
  BACKUP_PUBLICATION_LOCK_OWNER_PATH=""
  # shellcheck disable=SC2030 # These values intentionally belong only to the competitor subshell.
  BACKUP_PUBLICATION_LOCK_HELD=false
  acquire_backup_publication_lock "$TEST_DIR"
) >/dev/null 2>&1
CONCURRENT_LOCK_STATUS=$?
set -e
[ "$CONCURRENT_LOCK_STATUS" -eq 42 ] \
  || fail "concurrent publication did not reach the controlled fail path"
[ -f "$BACKUP_PUBLICATION_LOCK_PATH" ] || fail "concurrent attempt removed the owner's lock"
release_backup_publication_lock || fail "unable to release publication lock"
[ ! -e "$BACKUP_PUBLICATION_LOCK_PATH" ] || fail "publication lock remains after release"

echo "Verifying release cannot unlink a successor lock after child failure..."
BACKUP_PUBLICATION_LOCK_OWNER_ID=test-release-owner
acquire_backup_publication_lock "$TEST_DIR"
# shellcheck disable=SC2031 # The earlier competitor assignments were subshell-local by design.
RELEASE_OWNER_PATH="$BACKUP_PUBLICATION_LOCK_OWNER_PATH"
backup_unlink_owned_publication_lock() {
  rm -f "$BACKUP_PUBLICATION_LOCK_PATH"
  printf '%s\n' successor > "$BACKUP_PUBLICATION_LOCK_PATH"
  chmod 600 "$BACKUP_PUBLICATION_LOCK_PATH"
  return 143
}
release_backup_publication_lock || fail "successor reconciliation reported failure"
# shellcheck disable=SC2031 # The earlier competitor assignment was subshell-local by design.
[ "$BACKUP_PUBLICATION_LOCK_HELD" = false ] || fail "released lock remained marked owned"
[ "$(cat "$BACKUP_PUBLICATION_LOCK_PATH")" = successor ] \
  || fail "old owner removed the successor lock"
[ ! -e "$RELEASE_OWNER_PATH" ] || fail "released owner file remains"
rm -f "$BACKUP_PUBLICATION_LOCK_PATH"
# Restore the production helper after the injected release failure.
# shellcheck source=scripts/backup-evidence.sh disable=SC1091
. "$ROOT_DIR/scripts/backup-evidence.sh"

echo "Verifying release preserves fail-closed evidence after inspection failure..."
BACKUP_PUBLICATION_LOCK_OWNER_ID=test-inspection-failure
acquire_backup_publication_lock "$TEST_DIR"
INSPECTION_FAILURE_OWNER_PATH="$BACKUP_PUBLICATION_LOCK_OWNER_PATH"
backup_unlink_owned_publication_lock() {
  return 1
}
backup_publication_lock_still_owned() {
  return 2
}
if release_backup_publication_lock; then
  fail "lock release ignored an ownership inspection failure"
fi
[ "$BACKUP_PUBLICATION_LOCK_HELD" = true ] \
  || fail "inspection failure cleared the held-lock state"
[ -f "$BACKUP_PUBLICATION_LOCK_PATH" ] \
  || fail "inspection failure removed the fixed lock"
[ -f "$INSPECTION_FAILURE_OWNER_PATH" ] \
  || fail "inspection failure removed the owner evidence"
rm -f "$BACKUP_PUBLICATION_LOCK_PATH" "$INSPECTION_FAILURE_OWNER_PATH"
BACKUP_PUBLICATION_LOCK_HELD=false
BACKUP_PUBLICATION_LOCK_OWNER_PATH=""
# Restore both production helpers after the injected inspection failure.
# shellcheck source=scripts/backup-evidence.sh disable=SC1091
. "$ROOT_DIR/scripts/backup-evidence.sh"

echo "Verifying exact-target links reject directories and directory symlinks..."
LINK_SOURCE="$TEST_DIR/link-source"
LINK_DIRECTORY="$TEST_DIR/link-directory"
LINK_SYMLINK="$TEST_DIR/link-symlink"
printf '%s\n' 'sensitive archive' > "$LINK_SOURCE"
chmod 600 "$LINK_SOURCE"
mkdir "$LINK_DIRECTORY"
if backup_atomic_link_file "$LINK_SOURCE" "$LINK_DIRECTORY" >/dev/null 2>&1; then
  fail "exact-target link accepted a directory"
fi
[ ! -e "$LINK_DIRECTORY/${LINK_SOURCE##*/}" ] \
  || fail "directory target retained an unexpected hard link"
ln -s "$LINK_DIRECTORY" "$LINK_SYMLINK"
if backup_atomic_link_file "$LINK_SOURCE" "$LINK_SYMLINK" >/dev/null 2>&1; then
  fail "exact-target link accepted a directory symlink"
fi
[ ! -e "$LINK_DIRECTORY/${LINK_SOURCE##*/}" ] \
  || fail "directory symlink target retained an unexpected hard link"

echo "Verifying a post-link nonzero status is reconciled as owned..."
POST_EFFECT_SOURCE="$TEST_DIR/post-effect-source"
POST_EFFECT_TARGET="$TEST_DIR/post-effect-target"
printf '%s\n' 'post-effect archive' > "$POST_EFFECT_SOURCE"
chmod 600 "$POST_EFFECT_SOURCE"
(
  backup_atomic_link_file() {
    node -e 'require("fs").linkSync(process.argv[1], process.argv[2])' "$1" "$2"
    return 143
  }
  BACKUP_ARCHIVE_PUBLISHED=false
  ARCHIVE_PENDING_EVIDENCE=false
  publish_backup_archive "$POST_EFFECT_SOURCE" "$POST_EFFECT_TARGET"
  [ "$BACKUP_ARCHIVE_PUBLISHED" = true ]
  [ "$ARCHIVE_PENDING_EVIDENCE" = true ]
) || fail "post-link nonzero status was not reconciled"
[ ! -e "$POST_EFFECT_SOURCE" ] || fail "reconciled post-effect source was not removed"
[ "$(cat "$POST_EFFECT_TARGET")" = "post-effect archive" ] \
  || fail "post-effect target content is incorrect"
DISTINCT_INODE="$TEST_DIR/distinct-inode"
printf '%s\n' 'post-effect archive' > "$DISTINCT_INODE"
if backup_paths_share_inode "$POST_EFFECT_TARGET" "$DISTINCT_INODE"; then
  fail "equal content on distinct inodes was treated as owned"
fi

echo "Verifying archive publication is atomic and refuses overwrite..."
PUBLISH_SOURCE="$TEST_DIR/archive.tmp"
PUBLISH_TARGET="$TEST_DIR/archive.tar.gz"
printf '%s\n' 'first archive' > "$PUBLISH_SOURCE"
chmod 600 "$PUBLISH_SOURCE"
ARCHIVE_PENDING_EVIDENCE=false
publish_backup_archive "$PUBLISH_SOURCE" "$PUBLISH_TARGET"
[ "$ARCHIVE_PENDING_EVIDENCE" = true ] || fail "published archive was not marked pending"
[ ! -e "$PUBLISH_SOURCE" ] || fail "published archive temporary file remains"
[ "$(cat "$PUBLISH_TARGET")" = "first archive" ] || fail "published archive content changed"
printf '%s\n' 'replacement archive' > "$PUBLISH_SOURCE"
if (publish_backup_archive "$PUBLISH_SOURCE" "$PUBLISH_TARGET") >/dev/null 2>&1; then
  fail "existing archive was overwritten"
fi
[ "$(cat "$PUBLISH_TARGET")" = "first archive" ] || fail "existing archive content changed"
BACKUP_ARCHIVE_PUBLISHED=false

echo "Verifying cleanup ownership preserves a pre-existing sidecar..."
SEEDED_SIDECAR="$TEST_DIR/seeded.tar.gz.evidence.env"
printf '%s\n' 'pre-existing evidence' > "$SEEDED_SIDECAR"
BACKUP_EVIDENCE_ARCHIVE_PATH="$SEEDED_SIDECAR"
BACKUP_EVIDENCE_ARCHIVE_PUBLISHED=false
remove_owned_backup_publication_artifacts || fail "ownership cleanup failed"
[ "$(cat "$SEEDED_SIDECAR")" = "pre-existing evidence" ] \
  || fail "ownership cleanup removed pre-existing evidence"

echo "Verifying successful evidence publication..."
publish_backup_evidence "$ARCHIVE_PATH" "$TEST_DIR"

PER_ARCHIVE_EVIDENCE="$ARCHIVE_PATH.evidence.env"
LATEST_EVIDENCE="$TEST_DIR/last-successful-backup.env"
[ -f "$PER_ARCHIVE_EVIDENCE" ] || fail "per-archive evidence was not created"
[ -f "$LATEST_EVIDENCE" ] || fail "latest evidence was not created"
cmp "$PER_ARCHIVE_EVIDENCE" "$LATEST_EVIDENCE" >/dev/null \
  || fail "latest evidence does not match per-archive evidence"
[ "$(stat -c %a "$PER_ARCHIVE_EVIDENCE")" = 600 ] \
  || fail "per-archive evidence mode is not 600"
[ "$(stat -c %a "$LATEST_EVIDENCE")" = 600 ] \
  || fail "latest evidence mode is not 600"

EXPECTED_SHA256=$(sha256sum "$ARCHIVE_PATH" | awk '{print $1}')
grep -Fx "ARCHIVE_SHA256=$EXPECTED_SHA256" "$LATEST_EVIDENCE" >/dev/null \
  || fail "archive fingerprint is missing"
grep -Fx "CAPTURE_CONSISTENCY=stopped" "$LATEST_EVIDENCE" >/dev/null \
  || fail "consistency mode is incorrect"
grep -Fx "OBJECT_STORAGE_RECOVERY_STATUS=unknown" "$LATEST_EVIDENCE" >/dev/null \
  || fail "local fallback overstated object-storage recoverability"
grep -Fx "MAGIC_LINK_SECRET_RECOVERY_STATUS=required" "$LATEST_EVIDENCE" >/dev/null \
  || fail "Magic Link recovery requirement is missing"
grep -Fx "EXTERNAL_SECRET_RECOVERY_REQUIRED=true" "$LATEST_EVIDENCE" >/dev/null \
  || fail "aggregate secret status omitted the external Magic Link keyring"
grep -Fx "RESTORE_DRILL_VERIFIED=false" "$LATEST_EVIDENCE" >/dev/null \
  || fail "backup capture overstated restore-drill evidence"
grep -Fx "RECOVERABILITY_STATUS=unverified" "$LATEST_EVIDENCE" >/dev/null \
  || fail "backup capture overstated recoverability"
ARCHIVE_PENDING_EVIDENCE=false
finalize_backup_evidence_commit || fail "unable to finalize initial evidence test"

echo "Verifying external recovery requirements are explicit..."
EXTERNAL_ARCHIVE="$TEST_DIR/openlayerly-backup-20260824-123000.tar.gz"
tar -czf "$EXTERNAL_ARCHIVE" -C "$TEST_DIR/payload" .
STOP_APP=false
STORAGE_DRIVER=s3
UPLOADS_INCLUDED=false
publish_backup_evidence "$EXTERNAL_ARCHIVE" "$TEST_DIR"
grep -Fx "ARCHIVE_BASENAME=${EXTERNAL_ARCHIVE##*/}" "$LATEST_EVIDENCE" >/dev/null \
  || fail "latest evidence did not advance to the new archive"
grep -Fx "CAPTURE_CONSISTENCY=hot" "$LATEST_EVIDENCE" >/dev/null \
  || fail "hot consistency mode is incorrect"
grep -Fx "OBJECT_STORAGE_RECOVERY_STATUS=required" "$LATEST_EVIDENCE" >/dev/null \
  || fail "S3 recovery requirement is missing"
grep -Fx "EXTERNAL_SECRET_RECOVERY_REQUIRED=true" "$LATEST_EVIDENCE" >/dev/null \
  || fail "external secret recovery requirement is missing"

echo "Verifying an interrupted latest-pointer commit restores the previous baseline..."
rollback_backup_evidence_commit || fail "unable to roll back latest evidence"
grep -Fx "ARCHIVE_BASENAME=${ARCHIVE_PATH##*/}" "$LATEST_EVIDENCE" >/dev/null \
  || fail "rollback did not restore the previous latest evidence"
rm -f "$EXTERNAL_ARCHIVE.evidence.env"

echo "Verifying directory and symlink latest targets fail closed..."
TARGET_TEST_DIR="$TEST_DIR/target-test"
mkdir -p "$TARGET_TEST_DIR/last-successful-backup.env"
TARGET_ARCHIVE="$TEST_DIR/openlayerly-backup-20260824-124000.tar.gz"
tar -czf "$TARGET_ARCHIVE" -C "$TEST_DIR/payload" .
if (publish_backup_evidence "$TARGET_ARCHIVE" "$TARGET_TEST_DIR") >/dev/null 2>&1; then
  fail "directory latest-evidence target was accepted"
fi
rm -rf "$TARGET_TEST_DIR/last-successful-backup.env"
mkdir -p "$TARGET_TEST_DIR/evidence-directory"
ln -s evidence-directory "$TARGET_TEST_DIR/last-successful-backup.env"
if (publish_backup_evidence "$TARGET_ARCHIVE" "$TARGET_TEST_DIR") >/dev/null 2>&1; then
  fail "symlink latest-evidence target was accepted"
fi
[ -L "$TARGET_TEST_DIR/last-successful-backup.env" ] \
  || fail "symlink target was unexpectedly replaced"

echo "Verifying a hashing failure cannot publish or advance evidence..."
HASH_FAILURE_ARCHIVE="$TEST_DIR/openlayerly-backup-20260824-125000.tar.gz"
tar -czf "$HASH_FAILURE_ARCHIVE" -C "$TEST_DIR/payload" .
BASELINE_SHA256=$(sha256sum "$LATEST_EVIDENCE" | awk '{print $1}')
if (
  # shellcheck disable=SC2317 # Invoked indirectly by publish_backup_evidence in this subshell.
  sha256sum() { return 1; }
  publish_backup_evidence "$HASH_FAILURE_ARCHIVE" "$TEST_DIR"
) >/dev/null 2>&1; then
  fail "hashing failure published backup evidence"
fi
[ "$(sha256sum "$LATEST_EVIDENCE" | awk '{print $1}')" = "$BASELINE_SHA256" ] \
  || fail "hashing failure replaced last-successful evidence"
[ ! -e "$HASH_FAILURE_ARCHIVE.evidence.env" ] \
  || fail "hashing failure left per-archive evidence"

echo "Verifying rollback failure preserves every operator recovery artifact..."
FAULT_DIR="$TEST_DIR/rollback-fault"
mkdir "$FAULT_DIR"
FAULT_ARCHIVE="$FAULT_DIR/archive.tar.gz"
FAULT_SIDECAR="$FAULT_ARCHIVE.evidence.env"
FAULT_LATEST="$FAULT_DIR/last-successful-backup.env"
FAULT_PREVIOUS="$FAULT_DIR/.previous-last-successful-backup.test"
FAULT_LOCK="$FAULT_DIR/.openlayerly-backup-publication.lock"
printf '%s\n' archive > "$FAULT_ARCHIVE"
printf '%s\n' sidecar > "$FAULT_SIDECAR"
printf '%s\n' new-latest > "$FAULT_LATEST"
printf '%s\n' old-latest > "$FAULT_PREVIOUS"
: > "$FAULT_LOCK"
if (
  backup_atomic_replace_file() { return 1; }
  ARCHIVE_PATH="$FAULT_ARCHIVE"
  BACKUP_EVIDENCE_ARCHIVE_PATH="$FAULT_SIDECAR"
  BACKUP_EVIDENCE_LATEST_PATH="$FAULT_LATEST"
  BACKUP_EVIDENCE_PREVIOUS_LATEST_TMP="$FAULT_PREVIOUS"
  BACKUP_EVIDENCE_LATEST_COMMITTING=true
  BACKUP_ARCHIVE_PUBLISHED=true
  BACKUP_EVIDENCE_ARCHIVE_PUBLISHED=true
  cleanup_incomplete_backup_publication
); then
  fail "injected rollback failure reported success"
fi
[ "$(cat "$FAULT_ARCHIVE")" = archive ] || fail "rollback failure removed the archive"
[ "$(cat "$FAULT_SIDECAR")" = sidecar ] || fail "rollback failure removed the sidecar"
[ "$(cat "$FAULT_LATEST")" = new-latest ] || fail "rollback failure mutated latest"
[ "$(cat "$FAULT_PREVIOUS")" = old-latest ] || fail "rollback failure removed old baseline"
[ -f "$FAULT_LOCK" ] || fail "rollback failure removed the fail-closed lock"

BASELINE_SHA256=$(sha256sum "$LATEST_EVIDENCE" | awk '{print $1}')
CORRUPT_ARCHIVE="$TEST_DIR/openlayerly-backup-20260824-130000.tar.gz"
printf '%s\n' 'not a tar archive' > "$CORRUPT_ARCHIVE"

echo "Verifying a corrupt archive cannot replace last-successful evidence..."
if (publish_backup_evidence "$CORRUPT_ARCHIVE" "$TEST_DIR") >/dev/null 2>&1; then
  fail "corrupt archive published recovery evidence"
fi
[ "$(sha256sum "$LATEST_EVIDENCE" | awk '{print $1}')" = "$BASELINE_SHA256" ] \
  || fail "failed publication replaced last-successful evidence"
[ ! -e "$CORRUPT_ARCHIVE.evidence.env" ] \
  || fail "failed publication left per-archive evidence"

echo "Backup evidence regression checks passed."
