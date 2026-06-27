#!/bin/sh
set -eu

umask 077

ROOT_DIR=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
cd "$ROOT_DIR"

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

assert_bijection_mismatch() {
  PAYLOAD_FILE_LIST=$(mktemp "${TMPDIR:-/tmp}/openlayerly-checksum-gate-payload.XXXXXX")
  CHECKSUM_FILE_LIST=$(mktemp "${TMPDIR:-/tmp}/openlayerly-checksum-gate-checksum.XXXXXX")
  (
    cd "$WORK_DIR" || exit 1
    find . -type f ! -path './checksums.sha256' -print \
      | LC_ALL=C sort \
      | sed 's|^\./||' \
      > "$PAYLOAD_FILE_LIST"
    awk '{print $2}' checksums.sha256 | LC_ALL=C sort > "$CHECKSUM_FILE_LIST"
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
  find . -type f ! -name 'checksums.sha256' -print \
    | LC_ALL=C sort \
    | sed 's|^\./||' \
    > "$PAYLOAD_FILE_LIST"
  awk '{print $2}' checksums.sha256 | LC_ALL=C sort > "$CHECKSUM_FILE_LIST"
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

echo "Restore checksum gate checks passed for: $ARCHIVE_PATH"