#!/bin/sh
set -eu

ROOT_DIR=$(CDPATH='' cd -- "$(dirname "$0")/.." && pwd)
# shellcheck source=scripts/backup-app-state.sh disable=SC1091
. "$ROOT_DIR/scripts/backup-app-state.sh"

fail() {
  echo "backup-app-state-test: $*" >&2
  exit 1
}

assert_eq() {
  actual=$1
  expected=$2
  label=$3
  [ "$actual" = "$expected" ] \
    || fail "$label: expected '$expected', got '$actual'"
}

state_for_id() {
  case "$1" in
    app-running) printf '%s' "$STATE_RUNNING" ;;
    app-restarting) printf '%s' "$STATE_RESTARTING" ;;
    app-paused) printf '%s' "$STATE_PAUSED" ;;
    app-stopped) printf '%s' "$STATE_STOPPED" ;;
    app-created) printf '%s' "$STATE_CREATED" ;;
    *) return 1 ;;
  esac
}

compose() {
  case "$*" in
    "ps -aq app")
      printf '%s\n' "$APP_IDS"
      ;;
    "stop app")
      COMPOSE_STOP_CALLS=$((COMPOSE_STOP_CALLS + 1))
      STATE_RUNNING=exited
      if [ "$LEAVE_RESTARTING_AFTER_STOP" != true ]; then
        STATE_RESTARTING=exited
      fi
      STATE_PAUSED=exited
      ;;
    *)
      fail "unexpected compose invocation: $*"
      ;;
  esac
}

docker_cmd() {
  command_name=$1
  shift
  case "$command_name" in
    inspect)
      [ "$1" = "--format" ] || fail "inspect missing --format"
      shift 2
      state_for_id "$1"
      ;;
    start)
      for container_id in "$@"; do
        if [ -n "$STARTED_IDS" ]; then
          STARTED_IDS="$STARTED_IDS $container_id"
        else
          STARTED_IDS=$container_id
        fi
        case "$container_id" in
          app-running) STATE_RUNNING=running ;;
          app-restarting) STATE_RESTARTING=restarting ;;
          app-paused) STATE_PAUSED=running ;;
          *) fail "inactive container was restarted: $container_id" ;;
        esac
      done
      ;;
    *)
      fail "unexpected docker invocation: $command_name $*"
      ;;
  esac
}

reset_state() {
  APP_IDS="app-running app-restarting app-paused app-stopped app-created"
  STATE_RUNNING=running
  STATE_RESTARTING=restarting
  STATE_PAUSED=paused
  STATE_STOPPED=exited
  STATE_CREATED=created
  LEAVE_RESTARTING_AFTER_STOP=false
  COMPOSE_STOP_CALLS=0
  STARTED_IDS=""
  APP_RESTART_NEEDED=false
  APP_WAS_ACTIVE=false
  APP_CONTAINER_IDS_TO_RESTART=""
}

reset_state
echo "Verifying running/restarting/paused containers are stopped and selectively restarted..."
backup_stop_app_for_consistent_backup
assert_eq "$COMPOSE_STOP_CALLS" "1" "compose stop call count"
assert_eq "$APP_CONTAINER_IDS_TO_RESTART" \
  "app-running app-restarting app-paused" \
  "recorded restart targets"
assert_eq "$APP_WAS_ACTIVE" "true" "active-state marker"
assert_eq "$STATE_RUNNING" "exited" "running container after stop"
assert_eq "$STATE_RESTARTING" "exited" "restarting container after stop"
assert_eq "$STATE_PAUSED" "exited" "paused container after stop"
assert_eq "$STATE_STOPPED" "exited" "intentionally stopped container after stop"
assert_eq "$STATE_CREATED" "created" "created container after stop"

restart_app_if_needed
assert_eq "$STARTED_IDS" \
  "app-running app-restarting app-paused" \
  "selective restart targets"
assert_eq "$STATE_RUNNING" "running" "running container after restart"
assert_eq "$STATE_RESTARTING" "restarting" "crash-loop container after restart"
assert_eq "$STATE_PAUSED" "running" "paused container after restart"
assert_eq "$STATE_STOPPED" "exited" "stopped container remained stopped"
assert_eq "$STATE_CREATED" "created" "created container remained stopped"
assert_eq "$APP_RESTART_NEEDED" "false" "restart completion marker"

reset_state
APP_IDS="app-stopped app-created"
echo "Verifying every existing container is stopped even when none was active..."
backup_stop_app_for_consistent_backup
assert_eq "$COMPOSE_STOP_CALLS" "1" "inactive service stop call count"
assert_eq "$APP_CONTAINER_IDS_TO_RESTART" "" "inactive restart target list"
assert_eq "$APP_WAS_ACTIVE" "false" "inactive-state marker"
restart_app_if_needed
assert_eq "$STARTED_IDS" "" "inactive containers were not restarted"

reset_state
APP_IDS="app-restarting"
LEAVE_RESTARTING_AFTER_STOP=true
echo "Verifying a container left restarting after compose stop is rejected..."
if (backup_stop_app_for_consistent_backup) >/dev/null 2>&1; then
  fail "restarting container passed the post-stop assertion"
fi

echo "Backup app-state regression checks passed."
