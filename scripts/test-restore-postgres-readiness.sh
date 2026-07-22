#!/bin/sh
# shellcheck disable=SC2016 # Assert literal container-shell variable expansion.
set -eu

ROOT_DIR=$(CDPATH='' cd -- "$(dirname "$0")/.." && pwd)

fail() {
  echo "restore-postgres-readiness-test: $*" >&2
  exit 1
}

# shellcheck source=scripts/restore-common.sh disable=SC1091
. "$ROOT_DIR/scripts/restore-common.sh"

PROBE_ATTEMPTS=0

mock_postgres_shell() {
  probe_script=$1
  PROBE_ATTEMPTS=$((PROBE_ATTEMPTS + 1))

  printf '%s' "$probe_script" | grep -F 'psql -v ON_ERROR_STOP=1' >/dev/null \
    || fail "readiness probe did not use psql"
  printf '%s' "$probe_script" | grep -F 'select 1' >/dev/null \
    || fail "readiness probe did not execute a query"
  printf '%s' "$probe_script" | grep -F '${POSTGRES_DB:-artist_member}' >/dev/null \
    || fail "readiness probe did not target the configured database"
  printf '%s' "$probe_script" | grep -F '${POSTGRES_USER:-artist}' >/dev/null \
    || fail "readiness probe did not target the configured user"
  if printf '%s' "$probe_script" | grep -F 'pg_isready' >/dev/null; then
    fail "readiness probe still relies on pg_isready"
  fi

  # Model the official image initialization window: the server accepts connections
  # immediately, but the configured POSTGRES_DB is not queryable until the third probe.
  [ "$PROBE_ATTEMPTS" -ge 3 ]
}

wait_for_postgres_database mock_postgres_shell "test PostgreSQL" 4 0

[ "$PROBE_ATTEMPTS" -eq 3 ] \
  || fail "database readiness probe used $PROBE_ATTEMPTS attempts, expected 3"

ATTEMPT_FILE=$(mktemp)
ERROR_FILE=$(mktemp)
cleanup() {
  rm -f "$ATTEMPT_FILE" "$ERROR_FILE"
}
trap cleanup EXIT HUP INT TERM

never_ready_postgres_shell() {
  printf x >>"$ATTEMPT_FILE"
  return 1
}

if (wait_for_postgres_database never_ready_postgres_shell "never-ready PostgreSQL" 2 0) \
  2>"$ERROR_FILE"; then
  fail "never-ready database probe unexpectedly succeeded"
fi

[ "$(wc -c <"$ATTEMPT_FILE" | tr -d ' ')" -eq 2 ] \
  || fail "database readiness exhaustion did not stop after exactly 2 attempts"
grep -Fx 'restore-postgres-readiness-test: never-ready PostgreSQL did not become ready' \
  "$ERROR_FILE" >/dev/null \
  || fail "database readiness exhaustion did not report the expected failure"

echo "Restore PostgreSQL readiness regression test passed"
