#!/bin/sh
set -eu

umask 077

ROOT_DIR=$(CDPATH='' cd -- "$(dirname "$0")/.." && pwd)
cd "$ROOT_DIR"
# shellcheck source=scripts/restore-common.sh disable=SC1091
. "$ROOT_DIR/scripts/restore-common.sh"

ARCHIVE_PATH=""
for arg in "$@"; do
  case "$arg" in
    --*)
      echo "Usage: $0 <archive.tar.gz>" >&2
      exit 2
      ;;
    *)
      if [ -n "$ARCHIVE_PATH" ]; then
        echo "Usage: $0 <archive.tar.gz>" >&2
        exit 2
      fi
      ARCHIVE_PATH=$arg
      ;;
  esac
done

fail() {
  echo "restore-checksum-gate: $*" >&2
  exit 1
}

[ -n "$ARCHIVE_PATH" ] || fail "archive path is required"
[ -f "$ARCHIVE_PATH" ] || fail "archive not found: $ARCHIVE_PATH"

command -v tar >/dev/null 2>&1 || fail "tar is required"
command -v mktemp >/dev/null 2>&1 || fail "mktemp is required"
command -v sha256sum >/dev/null 2>&1 || fail "sha256sum is required"

WORK_DIR=$(mktemp -d "${TMPDIR:-/tmp}/openlayerly-checksum-gate.XXXXXX")
cleanup() {
  rm -rf "$WORK_DIR"
}
trap cleanup 0 HUP INT TERM

tar -xzf "$ARCHIVE_PATH" -C "$WORK_DIR"
[ -f "$WORK_DIR/checksums.sha256" ] || fail "archive is missing checksums.sha256"

write_checksum_path_list() {
  checksum_manifest=$1
  output_path=$2

  unsorted_output="${output_path}.unsorted"
  if ! awk '
    substr($0, 1, 1) == "\\" {
      print "restore-checksum-gate: escaped checksum paths are unsupported" > "/dev/stderr"
      exit 1
    }
    length($0) < 67 || substr($0, 65, 1) != " " ||
      (substr($0, 66, 1) != " " && substr($0, 66, 1) != "*") {
      print "restore-checksum-gate: malformed checksum manifest line" > "/dev/stderr"
      exit 1
    }
    {
      print substr($0, 67)
    }
  ' "$checksum_manifest" > "$unsorted_output"; then
    rm -f "$unsorted_output"
    return 1
  fi
  LC_ALL=C sort "$unsorted_output" > "$output_path"
  rm -f "$unsorted_output"

  if ! awk '
    index($0, "\\") || $0 ~ /[[:cntrl:]]/ {
      exit 1
    }
  ' "$output_path"; then
    fail "checksum paths contain unsupported backslash/control characters"
  fi
}

validate_payload_path_list() {
  path_list=$1
  if ! awk '
    index($0, "\\") || $0 ~ /[[:cntrl:]]/ {
      exit 1
    }
  ' "$path_list"; then
    fail "payload paths contain unsupported backslash/control characters"
  fi
}

assert_bijection_mismatch() {
  PAYLOAD_FILE_LIST=$(mktemp "${TMPDIR:-/tmp}/openlayerly-checksum-gate-payload.XXXXXX")
  CHECKSUM_FILE_LIST=$(mktemp "${TMPDIR:-/tmp}/openlayerly-checksum-gate-checksum.XXXXXX")
  (
    cd "$WORK_DIR" || exit 1
    find . -type f ! -path './checksums.sha256' -print \
      | LC_ALL=C sort \
      | sed 's|^\./||' \
      > "$PAYLOAD_FILE_LIST"
    validate_payload_path_list "$PAYLOAD_FILE_LIST"
    write_checksum_path_list checksums.sha256 "$CHECKSUM_FILE_LIST"
    if diff -q "$PAYLOAD_FILE_LIST" "$CHECKSUM_FILE_LIST" >/dev/null; then
      echo "restore-checksum-gate: bijection unexpectedly matched" >&2
      exit 1
    fi
  )
  rm -f "$PAYLOAD_FILE_LIST" "$CHECKSUM_FILE_LIST"
}

echo "Verifying checksum manifest bijection on intact archive..."
PAYLOAD_FILE_LIST=$(mktemp "${TMPDIR:-/tmp}/openlayerly-checksum-gate-payload.XXXXXX")
CHECKSUM_FILE_LIST=$(mktemp "${TMPDIR:-/tmp}/openlayerly-checksum-gate-checksum.XXXXXX")
(
  cd "$WORK_DIR" || exit 1
  find . -type f ! -path './checksums.sha256' -print \
    | LC_ALL=C sort \
    | sed 's|^\./||' \
    > "$PAYLOAD_FILE_LIST"
  validate_payload_path_list "$PAYLOAD_FILE_LIST"
  write_checksum_path_list checksums.sha256 "$CHECKSUM_FILE_LIST"
  diff -q "$PAYLOAD_FILE_LIST" "$CHECKSUM_FILE_LIST" >/dev/null
) || fail "intact archive failed bijection check"
rm -f "$PAYLOAD_FILE_LIST" "$CHECKSUM_FILE_LIST"

echo "Tampering with db.sql payload..."
printf X >>"$WORK_DIR/db.sql"

echo "Verifying sha256sum rejects tampered payload..."
if (
  cd "$WORK_DIR" || exit 1
  sha256sum -c checksums.sha256
) >/dev/null 2>&1; then
  fail "sha256sum -c unexpectedly passed after tampering db.sql"
fi

echo "Adding an undeclared payload file..."
printf secret >"$WORK_DIR/uploads/extra-tamper.txt"
assert_bijection_mismatch || fail "bijection did not detect extra payload file"

echo "Verifying nested checksums.sha256 filenames are not excluded by basename rules..."
NESTED_CHECKSUM_PATH="uploads/nested/checksums.sha256"
mkdir -p "$WORK_DIR/uploads/nested"
printf 'nested-checksum-payload' >"$WORK_DIR/$NESTED_CHECKSUM_PATH"
PAYLOAD_FILE_LIST=$(mktemp "${TMPDIR:-/tmp}/openlayerly-checksum-gate-payload.XXXXXX")
CHECKSUM_FILE_LIST=$(mktemp "${TMPDIR:-/tmp}/openlayerly-checksum-gate-checksum.XXXXXX")
(
  cd "$WORK_DIR" || exit 1
  find . -type f ! -path './checksums.sha256' -print \
    | LC_ALL=C sort \
    | sed 's|^\./||' \
    > "$PAYLOAD_FILE_LIST"
  if ! grep -Fxq "$NESTED_CHECKSUM_PATH" "$PAYLOAD_FILE_LIST"; then
    echo "restore-checksum-gate: nested checksums.sha256 path was excluded" >&2
    exit 1
  fi
) || fail "nested checksums.sha256 exclusion regression detected"
rm -f "$PAYLOAD_FILE_LIST" "$CHECKSUM_FILE_LIST"

# Exercise the *production* payload-rejection helper (reject_unsafe_payload_tree, shared
# with restore.sh) so this test fails if that rejection logic is ever removed/weakened.
echo "Verifying the intact payload tree is accepted by the production validator..."
reject_unsafe_payload_tree "$WORK_DIR" \
  || fail "intact payload tree was wrongly rejected by reject_unsafe_payload_tree"
validate_archive_storage_contract "$WORK_DIR" 2 \
  || fail "intact archive storage contract was wrongly rejected"
validate_archive_storage_contract "$WORK_DIR" 4 \
  || fail "intact v4 archive storage contract was wrongly rejected"

echo "Verifying malformed storage payload contracts are rejected before restore..."
CONTRACT_DIR=$(mktemp -d "${TMPDIR:-/tmp}/openlayerly-checksum-gate-contract.XXXXXX")
cp "$WORK_DIR/manifest.env" "$CONTRACT_DIR/manifest.env"
if (validate_archive_storage_contract "$CONTRACT_DIR" 2) >/dev/null 2>&1; then
  fail "archive with no storage payload form was accepted"
fi
if (validate_archive_storage_contract "$CONTRACT_DIR" 4) >/dev/null 2>&1; then
  fail "v4 archive with no storage payload form was accepted"
fi
mkdir -p "$CONTRACT_DIR/uploads"
touch "$CONTRACT_DIR/UPLOADS_SKIPPED_S3"
if (validate_archive_storage_contract "$CONTRACT_DIR" 2) >/dev/null 2>&1; then
  fail "archive with both storage payload forms was accepted"
fi
if (validate_archive_storage_contract "$CONTRACT_DIR" 4) >/dev/null 2>&1; then
  fail "v4 archive with both storage payload forms was accepted"
fi
rm -rf "$CONTRACT_DIR/uploads"
if (validate_archive_storage_contract "$CONTRACT_DIR" 2) >/dev/null 2>&1; then
  fail "archive whose manifest disagrees with its S3 marker was accepted"
fi
if (validate_archive_storage_contract "$CONTRACT_DIR" 4) >/dev/null 2>&1; then
  fail "v4 archive whose manifest disagrees with its S3 marker was accepted"
fi
sed 's/^STORAGE_DRIVER=.*/STORAGE_DRIVER=s3/; s/^UPLOADS_INCLUDED=.*/UPLOADS_INCLUDED=false/' \
  "$WORK_DIR/manifest.env" > "$CONTRACT_DIR/manifest.env"
validate_archive_storage_contract "$CONTRACT_DIR" 4 \
  || fail "valid v4 S3 skip-marker storage contract was rejected"
rm -f "$CONTRACT_DIR/UPLOADS_SKIPPED_S3"
mkdir -p "$CONTRACT_DIR/uploads"
sed 's/^STORAGE_DRIVER=.*/STORAGE_DRIVER=local/; s/^UPLOADS_INCLUDED=.*/UPLOADS_INCLUDED=true/' \
  "$WORK_DIR/manifest.env" > "$CONTRACT_DIR/manifest.env"
validate_archive_storage_contract "$CONTRACT_DIR" 4 \
  || fail "valid v4 local uploads storage contract was rejected"
rm -rf "$CONTRACT_DIR"

echo "Verifying a symlink-bearing archive is rejected before DB replacement..."
MAL_DIR=$(mktemp -d "${TMPDIR:-/tmp}/openlayerly-checksum-gate-mal.XXXXXX")
mkdir -p "$MAL_DIR/build/uploads"
printf 'select 1;' >"$MAL_DIR/build/db.sql"
ln -s /etc/passwd "$MAL_DIR/build/uploads/evil-symlink.txt"
tar -czf "$MAL_DIR/symlink.tar.gz" -C "$MAL_DIR/build" .
SYMLINK_EXTRACT=$(mktemp -d "${TMPDIR:-/tmp}/openlayerly-checksum-gate-sym.XXXXXX")
tar -xzf "$MAL_DIR/symlink.tar.gz" -C "$SYMLINK_EXTRACT"
if (reject_unsafe_payload_tree "$SYMLINK_EXTRACT") >/dev/null 2>&1; then
  fail "symlink-bearing archive was not rejected by reject_unsafe_payload_tree"
fi

echo "Verifying a special-file (FIFO) archive is rejected before DB replacement..."
rm -rf "$MAL_DIR/build/uploads"
mkdir -p "$MAL_DIR/build/uploads"
rm -f "$MAL_DIR/build/uploads/evil-symlink.txt"
mkfifo "$MAL_DIR/build/uploads/evil-fifo"
tar -czf "$MAL_DIR/fifo.tar.gz" -C "$MAL_DIR/build" .
FIFO_EXTRACT=$(mktemp -d "${TMPDIR:-/tmp}/openlayerly-checksum-gate-fifo.XXXXXX")
tar -xzf "$MAL_DIR/fifo.tar.gz" -C "$FIFO_EXTRACT"
if (reject_unsafe_payload_tree "$FIFO_EXTRACT") >/dev/null 2>&1; then
  fail "special-file (FIFO) archive was not rejected by reject_unsafe_payload_tree"
fi
rm -rf "$MAL_DIR" "$SYMLINK_EXTRACT" "$FIFO_EXTRACT"

echo "Restore checksum gate checks passed for: $ARCHIVE_PATH"
