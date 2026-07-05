#!/bin/sh
set -eu

ROOT_DIR=$(CDPATH='' cd -- "$(dirname "$0")/.." && pwd)
TEST_ROOT=$(mktemp -d "${TMPDIR:-/tmp}/openlayerly-entrypoint-secrets.XXXXXX")
cleanup() {
  rm -rf "$TEST_ROOT"
}
trap cleanup EXIT INT TERM

fail() {
  echo "entrypoint-secrets-test: $*" >&2
  exit 1
}

CHOWN_LOG="$TEST_ROOT/chown.log"
chown() {
  printf '%s\n' "$*" >> "$CHOWN_LOG"
}

# shellcheck source=docker/entrypoint-secrets.sh disable=SC1091
. "$ROOT_DIR/docker/entrypoint-secrets.sh"

reset_fixture() {
  rm -rf "$TEST_ROOT/root"
  mkdir -p "$TEST_ROOT/root/secrets" "$TEST_ROOT/root/uploads"
  : > "$CHOWN_LOG"
  export UPLOAD_DIR="$TEST_ROOT/root/uploads"
  CONFIG_ENCRYPTION_KEY_FILE="$TEST_ROOT/root/secrets/config-encryption-key"
  SESSION_SECRET_FILE="$TEST_ROOT/root/secrets/session-secret"
  SECRETS_DIR="$(dirname "$CONFIG_ENCRYPTION_KEY_FILE")"
  SESSION_SECRETS_DIR="$(dirname "$SESSION_SECRET_FILE")"
  export SESSION_SECRETS_DIR
  unset CONFIG_ENCRYPTION_KEY
  unset SESSION_SECRET
}

reset_fixture
printf '%s' "target" > "$TEST_ROOT/root/target"
ln -s "$TEST_ROOT/root/target" "$CONFIG_ENCRYPTION_KEY_FILE"
printf '%s' "session-secret-material-0123456789" > "$SESSION_SECRET_FILE"
export CONFIG_ENCRYPTION_KEY=external-key-material
entrypoint_apply_root_ownership
if grep -F "$CONFIG_ENCRYPTION_KEY_FILE" "$CHOWN_LOG" >/dev/null; then
  fail "env mode chowned CONFIG_ENCRYPTION_KEY_FILE"
fi
if grep -F "$TEST_ROOT/root/target" "$CHOWN_LOG" >/dev/null; then
  fail "env mode followed CONFIG_ENCRYPTION_KEY_FILE symlink target"
fi
grep -F "nextjs:nodejs $SECRETS_DIR" "$CHOWN_LOG" >/dev/null \
  || fail "env mode did not chown shared secrets dir for file-backed session secret"
grep -F "nextjs:nodejs $SESSION_SECRET_FILE" "$CHOWN_LOG" >/dev/null \
  || fail "env mode did not chown file-backed session secret"

reset_fixture
printf '%s' "config-key-material" > "$CONFIG_ENCRYPTION_KEY_FILE"
export SESSION_SECRET=external-session-secret
entrypoint_apply_root_ownership
grep -F "nextjs:nodejs $CONFIG_ENCRYPTION_KEY_FILE" "$CHOWN_LOG" >/dev/null \
  || fail "file mode did not chown regular config key file"

reset_fixture
printf '%s' "target" > "$TEST_ROOT/root/target"
ln -s "$TEST_ROOT/root/target" "$CONFIG_ENCRYPTION_KEY_FILE"
SESSION_SECRET=external-session-secret
if entrypoint_apply_root_ownership 2>"$TEST_ROOT/symlink.err"; then
  fail "file mode accepted symlinked config key path"
fi
grep -F "CONFIG_ENCRYPTION_KEY_FILE must not be a symlink" "$TEST_ROOT/symlink.err" >/dev/null \
  || fail "file mode did not fail loudly on symlinked config key path"

reset_fixture
printf '%s' "target" > "$TEST_ROOT/root/target"
ln -s "$TEST_ROOT/root/target" "$SESSION_SECRET_FILE"
export CONFIG_ENCRYPTION_KEY=external-key-material
if entrypoint_apply_root_ownership 2>"$TEST_ROOT/session-symlink.err"; then
  fail "file-backed session mode accepted symlinked session secret path"
fi
grep -F "SESSION_SECRET_FILE must not be a symlink" "$TEST_ROOT/session-symlink.err" >/dev/null \
  || fail "file-backed session mode did not fail loudly on symlinked path"

echo "Entrypoint secrets ownership tests passed"
