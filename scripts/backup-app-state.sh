#!/bin/sh
# Shared app-container state helpers for backup.sh and its bounded shell regression.
# This file is sourced; callers provide compose(), docker_cmd(), and fail().

backup_app_container_state() {
  backup_state_container_id=$1
  backup_state_value=$(
    docker_cmd inspect --format '{{.State.Status}}' "$backup_state_container_id" 2>/dev/null \
      | tr -d '\r'
  ) || return 1
  [ -n "$backup_state_value" ] || return 1
  printf '%s' "$backup_state_value"
}

backup_app_state_is_active() {
  case "$1" in
    running|restarting|paused) return 0 ;;
    *) return 1 ;;
  esac
}

backup_collect_active_app_container_ids() {
  backup_state_container_ids=$1
  backup_state_active_ids=""

  for backup_state_container_id in $backup_state_container_ids; do
    backup_state_value=$(backup_app_container_state "$backup_state_container_id") \
      || fail "unable to inspect app container state: $backup_state_container_id"
    if backup_app_state_is_active "$backup_state_value"; then
      if [ -n "$backup_state_active_ids" ]; then
        backup_state_active_ids="$backup_state_active_ids $backup_state_container_id"
      else
        backup_state_active_ids=$backup_state_container_id
      fi
    fi
  done

  printf '%s' "$backup_state_active_ids"
}

backup_assert_app_service_stopped() {
  backup_state_container_ids=$(compose ps -aq app) \
    || fail "unable to enumerate app service containers after stop"

  for backup_state_container_id in $backup_state_container_ids; do
    backup_state_value=$(backup_app_container_state "$backup_state_container_id") \
      || fail "unable to inspect app container after stop: $backup_state_container_id"
    if backup_app_state_is_active "$backup_state_value"; then
      fail "app container $backup_state_container_id is still $backup_state_value; refusing consistent backup"
    fi
  done
}

backup_stop_app_for_consistent_backup() {
  backup_state_container_ids=$(compose ps -aq app) \
    || fail "unable to enumerate app service containers before stop"
  APP_CONTAINER_IDS_TO_RESTART=$(
    backup_collect_active_app_container_ids "$backup_state_container_ids"
  ) || fail "unable to record active app containers before stop"

  if [ -n "$APP_CONTAINER_IDS_TO_RESTART" ]; then
    # shellcheck disable=SC2034 # Read by the sourcing backup.sh after this helper returns.
    APP_WAS_ACTIVE=true
    APP_RESTART_NEEDED=true
  fi

  if [ -n "$backup_state_container_ids" ]; then
    echo "Stopping application for a self-consistent backup..."
    compose stop app >/dev/null \
      || fail "unable to stop app service for consistent backup"
  fi

  backup_assert_app_service_stopped
}

backup_restart_targets_are_active() {
  for backup_state_container_id in $APP_CONTAINER_IDS_TO_RESTART; do
    backup_state_value=$(backup_app_container_state "$backup_state_container_id") \
      || return 1
    backup_app_state_is_active "$backup_state_value" || return 1
  done
  return 0
}

restart_app_if_needed() {
  if [ "$APP_RESTART_NEEDED" != true ]; then
    return 0
  fi

  if [ -z "$APP_CONTAINER_IDS_TO_RESTART" ]; then
    echo "backup: restart requested without recorded app containers" >&2
    return 1
  fi

  echo "Restarting application after consistent backup window..."
  # shellcheck disable=SC2086 # Container IDs are whitespace-free Docker identifiers.
  if ! docker_cmd start $APP_CONTAINER_IDS_TO_RESTART >/dev/null; then
    echo "backup: unable to restart previously active app containers" >&2
    return 1
  fi

  backup_restart_attempt=0
  until backup_restart_targets_are_active; do
    backup_restart_attempt=$((backup_restart_attempt + 1))
    if [ "$backup_restart_attempt" -ge 10 ]; then
      echo "backup: previously active app containers did not return to running/restarting state" >&2
      return 1
    fi
    sleep 1
  done

  APP_RESTART_NEEDED=false
  return 0
}
