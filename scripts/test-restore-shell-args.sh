#!/bin/sh
# shellcheck disable=SC2016 # Positional parameters intentionally expand in the child shell.
set -eu

ROOT_DIR=$(CDPATH='' cd -- "$(dirname "$0")/.." && pwd)
TEST_ROOT=$(mktemp -d "${TMPDIR:-/tmp}/openlayerly-restore-shell-args.XXXXXX")
cleanup() {
  rm -rf "$TEST_ROOT"
}
trap cleanup EXIT INT TERM

fail() {
  echo "restore-shell-args-test: $*" >&2
  exit 1
}

# Execute the container shell argv locally. This preserves the sh -c boundary:
# the command text is one argument, the fixed argv[0] sentinel is next, and all
# dynamic values follow as positional parameters.
compose() {
  action=$1
  shift
  case "$action" in
    run)
      while [ "$#" -gt 0 ] && [ "$1" != "app" ]; do
        shift
      done
      [ "$#" -gt 0 ] || fail "mock compose run did not receive app service"
      shift
      command sh "$@"
      return
      ;;
    exec)
      while [ "$#" -gt 0 ] && [ "$1" != "postgres" ]; do
        shift
      done
      [ "$#" -gt 0 ] || fail "mock compose exec did not receive postgres service"
      shift
      ;;
    *)
      fail "unexpected mock compose action: $action"
      ;;
  esac
  [ "$1" = "sh" ] || fail "mock compose expected sh entrypoint"
  shift
  command sh "$@"
}

# shellcheck source=scripts/restore-common.sh disable=SC1091
. "$ROOT_DIR/scripts/restore-common.sh"

cd "$TEST_ROOT"
INJECTION_MARKER="$TEST_ROOT/INJECTED"
SINGLE_QUOTE="'"
DOUBLE_QUOTE='"'
DOLLAR='$'
SPECIAL_COMPONENT="space ${SINGLE_QUOTE}single${SINGLE_QUOTE} ${DOUBLE_QUOTE}double${DOUBLE_QUOTE} ${DOLLAR}dollar ; ${DOLLAR}(touch INJECTED) [*]"
SPECIAL_DIR="$TEST_ROOT/$SPECIAL_COMPONENT"
SPECIAL_FILE="$SPECIAL_DIR/key $SPECIAL_COMPONENT"
SPECIAL_OBJECT="nested/proof ${SPECIAL_COMPONENT}.txt"

mkdir -p "$SPECIAL_DIR"
canonical=$(canonicalize_container_path "$SPECIAL_DIR" "special path")
[ "$canonical" = "$SPECIAL_DIR" ] || fail "canonical path changed shell-sensitive characters"
[ ! -e "$INJECTION_MARKER" ] || fail "canonicalization executed injected shell text"

preflight_volume_write_read_delete "$SPECIAL_DIR" "special path"
[ ! -e "$INJECTION_MARKER" ] || fail "preflight executed injected shell text"
[ -z "$(find "$SPECIAL_DIR" -name '.restore-preflight.*' -print -quit)" ] \
  || fail "preflight did not remove its sentinel"

printf '%s' "key-material" > "$SPECIAL_FILE"
verify_container_nonempty_file "$SPECIAL_FILE"
[ ! -e "$INJECTION_MARKER" ] || fail "file verification executed injected shell text"

mkdir -p "$SPECIAL_DIR/nested"
printf '%s' "proof" > "$SPECIAL_DIR/$SPECIAL_OBJECT"
remove_container_object "$SPECIAL_DIR" "$SPECIAL_OBJECT"
[ ! -e "$SPECIAL_DIR/$SPECIAL_OBJECT" ] || fail "object removal did not remove the exact path"
[ ! -e "$INJECTION_MARKER" ] || fail "object removal executed injected shell text"

TEXT_FILE="$SPECIAL_DIR/first ${SPECIAL_COMPONENT}.txt"
printf '%s' "text" > "$TEXT_FILE"
remove_first_container_text_file "$SPECIAL_DIR"
[ ! -e "$TEXT_FILE" ] || fail "text-file removal did not remove the selected path"
[ ! -e "$INJECTION_MARKER" ] || fail "text-file removal executed injected shell text"

printf '%s' "visible" > "$SPECIAL_DIR/visible"
printf '%s' "hidden" > "$SPECIAL_DIR/.hidden"
mkdir -p "$SPECIAL_DIR/subdir"
printf '%s' "nested" > "$SPECIAL_DIR/subdir/nested"
clear_container_directory "$SPECIAL_DIR"
[ -d "$SPECIAL_DIR" ] || fail "directory clear removed the target directory"
[ -z "$(find "$SPECIAL_DIR" -mindepth 1 -print -quit)" ] \
  || fail "directory clear left entries behind"
[ ! -e "$INJECTION_MARKER" ] || fail "directory clear executed injected shell text"

round_trip=$(run_app_shell 'printf "%s" "$1"' "$SPECIAL_COMPONENT")
[ "$round_trip" = "$SPECIAL_COMPONENT" ] || fail "app positional argument did not round-trip"
round_trip=$(run_postgres_shell 'printf "%s" "$1"' "$SPECIAL_COMPONENT")
[ "$round_trip" = "$SPECIAL_COMPONENT" ] || fail "postgres positional argument did not round-trip"
[ ! -e "$INJECTION_MARKER" ] || fail "shell wrapper executed injected shell text"

if grep -nE 'compose (run|exec).*sh -c "' \
  "$ROOT_DIR/scripts/restore.sh" "$ROOT_DIR/scripts/restore-common.sh" \
  | grep -v 'sh -c "\$script" restore-'; then
  fail "restore scripts still contain double-quoted sh -c command text"
fi
if grep -nE 'run_(app|postgres)_shell "' \
  "$ROOT_DIR/scripts/restore.sh" "$ROOT_DIR/scripts/restore-common.sh"; then
  fail "restore scripts still construct child-shell command text with double quotes"
fi

echo "Restore shell argument tests passed"
