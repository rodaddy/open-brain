#!/usr/bin/env bash
set -euo pipefail

umask 077

DEV_ROOT="${DEV_ROOT:-$HOME/Development}"
QMD_BIN="${QMD_BIN:-/Users/rico/.local/bin/qmd}"
LOG_DIR="${LOG_DIR:-$HOME/.local/state/open-brain/log}"
LOG_FILE="${LOG_FILE:-$LOG_DIR/qmd-sync.log}"
GLOBAL_INDEX="global_docs_instructions"
HOME="${HOME:-/Users/rico}"
PATH="/opt/homebrew/bin:/Users/rico/.local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
QMD_EMBED_WATCHDOG_SECONDS="${QMD_EMBED_WATCHDOG_SECONDS:-1800}"
QMD_RUN_WATCHDOG_SECONDS="${QMD_RUN_WATCHDOG_SECONDS:-21600}"
QMD_WATCHDOG_KILL_AFTER_SECONDS="${QMD_WATCHDOG_KILL_AFTER_SECONDS:-20}"
RUN_DEADLINE=0
QMD_STEP_OUTPUT_FILE=""
QMD_WATCHDOG_SCOPE=""
QMD_WATCHDOG_SECONDS=0
export HOME PATH

initialize_logging() {
  mkdir -p "$LOG_DIR"
  touch "$LOG_FILE"
  exec >> "$LOG_FILE" 2>&1
}

timestamp() {
  /bin/date '+%Y-%m-%dT%H:%M:%S%z'
}

validate_watchdog_seconds() {
  local name="$1"
  local value="$2"

  if [[ ! "$value" =~ ^[1-9][0-9]*$ ]]; then
    printf '[%s] qmd-sync status=failed reason=invalid-watchdog-setting name=%s value=%s\n' \
      "$(timestamp)" "$name" "$value"
    return 1
  fi
}

resolve_watchdog_binary() {
  if [[ -x /opt/homebrew/bin/gtimeout ]]; then
    printf '%s\n' /opt/homebrew/bin/gtimeout
    return 0
  fi

  if [[ -x /opt/homebrew/bin/timeout ]]; then
    printf '%s\n' /opt/homebrew/bin/timeout
    return 0
  fi

  return 1
}

run_qmd_step() {
  local working_directory="$1"
  local label="$2"
  local step="$3"
  local step_watchdog_seconds="$4"
  shift 4
  local remaining_seconds watchdog_binary exit_code watchdog_pid

  remaining_seconds=$((RUN_DEADLINE - SECONDS))
  QMD_WATCHDOG_SCOPE="run"
  QMD_WATCHDOG_SECONDS="$remaining_seconds"
  QMD_STEP_OUTPUT_FILE="$LOG_DIR/.qmd-sync-${label}-${step}-$$.out"

  if (( remaining_seconds <= 0 )); then
    : > "$QMD_STEP_OUTPUT_FILE"
    return 124
  fi

  if (( step_watchdog_seconds > 0 && step_watchdog_seconds < remaining_seconds )); then
    QMD_WATCHDOG_SCOPE="$step"
    QMD_WATCHDOG_SECONDS="$step_watchdog_seconds"
  fi

  if ! watchdog_binary="$(resolve_watchdog_binary)"; then
    printf 'qmd-sync: GNU timeout is required for watchdog enforcement\n' \
      > "$QMD_STEP_OUTPUT_FILE"
    return 125
  fi

  (
    cd "$working_directory"
    QMD_TIMEOUT=0 "$watchdog_binary" \
      --kill-after="${QMD_WATCHDOG_KILL_AFTER_SECONDS}s" \
      "${QMD_WATCHDOG_SECONDS}s" \
      "$QMD_BIN" "$@"
  ) > "$QMD_STEP_OUTPUT_FILE" 2>&1 &
  watchdog_pid=$!

  if wait "$watchdog_pid"; then
    return 0
  else
    exit_code=$?
  fi

  if (( exit_code == 124 || exit_code == 137 )); then
    kill -KILL -- "-$watchdog_pid" 2>/dev/null || true
  fi

  return "$exit_code"
}

read_step_output() {
  local output_file="$1"
  local output=""

  if [[ -r "$output_file" ]]; then
    output="$(< "$output_file")"
    /opt/homebrew/bin/gunlink "$output_file"
  fi

  printf '%s\n' "$output"
}

log_qmd_step_failure() {
  local label="$1"
  local step="$2"
  local exit_code="$3"
  local details="${4:-}"

  if (( exit_code == 124 || exit_code == 137 )); then
    printf '[%s] index=%s status=failed step=%s reason=watchdog scope=%s watchdog_seconds=%d exit_code=%d%s\n' \
      "$(timestamp)" "$label" "$step" "$QMD_WATCHDOG_SCOPE" \
      "$QMD_WATCHDOG_SECONDS" "$exit_code" "$details"
    return 0
  fi

  if (( exit_code == 125 )); then
    printf '[%s] index=%s status=failed step=%s reason=watchdog-unavailable exit_code=%d%s\n' \
      "$(timestamp)" "$label" "$step" "$exit_code" "$details"
    return 0
  fi

  printf '[%s] index=%s status=failed step=%s exit_code=%d%s\n' \
    "$(timestamp)" "$label" "$step" "$exit_code" "$details"
}

strip_ansi() {
  /usr/bin/sed $'s/\033\[[0-9;]*m//g'
}

parse_update_metrics() {
  /usr/bin/awk '
    /^Indexed:/ { new_files += $2; updated_files += $4; lines++ }
    END { print new_files + 0, updated_files + 0, lines + 0 }
  '
}

parse_embed_metrics() {
  /usr/bin/awk '
    /Done!.*Embedded [0-9][0-9,]* chunks/ {
      for (i = 1; i <= NF; i++) {
        if ($i == "Embedded") {
          count = $(i + 1)
          gsub(/,/, "", count)
          chunks += count
        }
      }
    }
    END { print chunks + 0 }
  '
}

is_embed_terminal_output() {
  /usr/bin/grep -Eq \
    'Done!.*Embedded [0-9][0-9,]* chunks|All content hashes already have embeddings|No non-empty documents to embed'
}

parse_status_metrics() {
  /usr/bin/awk '
    /^[[:space:]]*Total:/ && files == "" { files = $2 }
    /^[[:space:]]*Vectors:/ && vectors == "" { vectors = $2 }
    END { print files, vectors }
  '
}

sync_index() {
  local label="$1"
  local working_directory="$2"
  shift 2
  local -a index_args=("$@")
  local started_at update_output embed_output status_output plain_output
  local files_new files_updated update_metric_lines
  local vectors_embedded files_indexed vectors_total
  local exit_code

  started_at="$(timestamp)"
  printf '[%s] index=%s status=started\n' "$started_at" "$label"

  if run_qmd_step "$working_directory" "$label" update 0 \
    update "${index_args[@]}"; then
    update_output="$(read_step_output "$QMD_STEP_OUTPUT_FILE")"
    printf '%s\n' "$update_output"
  else
    exit_code=$?
    update_output="$(read_step_output "$QMD_STEP_OUTPUT_FILE")"
    printf '%s\n' "$update_output"
    log_qmd_step_failure "$label" update "$exit_code"
    return 1
  fi

  plain_output="$(printf '%s\n' "$update_output" | strip_ansi)"
  read -r files_new files_updated update_metric_lines < <(
    printf '%s\n' "$plain_output" | parse_update_metrics
  )

  if (( update_metric_lines == 0 )); then
    printf '[%s] index=%s status=failed step=metrics reason=update-output-unparseable\n' \
      "$(timestamp)" "$label"
    return 1
  fi

  if run_qmd_step "$working_directory" "$label" embed \
    "$QMD_EMBED_WATCHDOG_SECONDS" embed "${index_args[@]}"; then
    embed_output="$(read_step_output "$QMD_STEP_OUTPUT_FILE")"
    printf '%s\n' "$embed_output"
  else
    exit_code=$?
    embed_output="$(read_step_output "$QMD_STEP_OUTPUT_FILE")"
    printf '%s\n' "$embed_output"
    log_qmd_step_failure "$label" embed "$exit_code" \
      " files_new=$files_new files_updated=$files_updated"
    return 1
  fi

  plain_output="$(printf '%s\n' "$embed_output" | strip_ansi)"
  if printf '%s\n' "$plain_output" | /usr/bin/grep -q 'chunks still failed after retries'; then
    printf '[%s] index=%s status=failed step=embed reason=chunk-failures files_new=%s files_updated=%s\n' \
      "$(timestamp)" "$label" "$files_new" "$files_updated"
    return 1
  fi

  vectors_embedded="$(printf '%s\n' "$plain_output" | parse_embed_metrics)"

  if ! printf '%s\n' "$plain_output" | is_embed_terminal_output; then
    printf '[%s] index=%s status=failed step=metrics reason=embed-output-unparseable\n' \
      "$(timestamp)" "$label"
    return 1
  fi

  if run_qmd_step "$working_directory" "$label" status 0 \
    status "${index_args[@]}"; then
    status_output="$(read_step_output "$QMD_STEP_OUTPUT_FILE")"
  else
    exit_code=$?
    status_output="$(read_step_output "$QMD_STEP_OUTPUT_FILE")"
    printf '%s\n' "$status_output"
    log_qmd_step_failure "$label" status "$exit_code" \
      " files_new=$files_new files_updated=$files_updated vectors_embedded=$vectors_embedded"
    return 1
  fi

  plain_output="$(printf '%s\n' "$status_output" | strip_ansi)"
  read -r files_indexed vectors_total < <(
    printf '%s\n' "$plain_output" | parse_status_metrics
  )

  if [[ -z "$files_indexed" || -z "$vectors_total" ]]; then
    printf '[%s] index=%s status=failed step=metrics reason=status-output-unparseable\n' \
      "$(timestamp)" "$label"
    return 1
  fi

  printf '[%s] index=%s status=completed last_run=%s files_indexed=%s files_new=%s files_updated=%s vectors_embedded=%s vectors_total=%s\n' \
    "$(timestamp)" "$label" "$started_at" "$files_indexed" "$files_new" \
    "$files_updated" "$vectors_embedded" "$vectors_total"
}

main() {
  local run_started_at repo label
  local indexes_attempted=0
  local project_indexes=0
  local failures=0
  local run_watchdog_expired=0

  initialize_logging
  run_started_at="$(timestamp)"
  printf '[%s] qmd-sync status=started dev_root=%s embed_watchdog_seconds=%s run_watchdog_seconds=%s kill_after_seconds=%s\n' \
    "$run_started_at" "$DEV_ROOT" "$QMD_EMBED_WATCHDOG_SECONDS" \
    "$QMD_RUN_WATCHDOG_SECONDS" "$QMD_WATCHDOG_KILL_AFTER_SECONDS"

  validate_watchdog_seconds QMD_EMBED_WATCHDOG_SECONDS \
    "$QMD_EMBED_WATCHDOG_SECONDS" || return 1
  validate_watchdog_seconds QMD_RUN_WATCHDOG_SECONDS \
    "$QMD_RUN_WATCHDOG_SECONDS" || return 1
  validate_watchdog_seconds QMD_WATCHDOG_KILL_AFTER_SECONDS \
    "$QMD_WATCHDOG_KILL_AFTER_SECONDS" || return 1
  RUN_DEADLINE=$((SECONDS + QMD_RUN_WATCHDOG_SECONDS))

  if [[ ! -d "$DEV_ROOT" ]]; then
    printf '[%s] qmd-sync status=failed reason=development-root-missing path=%s\n' \
      "$(timestamp)" "$DEV_ROOT"
    return 1
  fi

  if [[ ! -x "$QMD_BIN" ]]; then
    printf '[%s] qmd-sync status=failed reason=qmd-not-executable path=%s\n' \
      "$(timestamp)" "$QMD_BIN"
    return 1
  fi

  for repo in "$DEV_ROOT" "$DEV_ROOT"/*; do
    [[ -d "$repo/.git" ]] || continue
    [[ -f "$repo/.qmd/index.yml" ]] || continue

    label="${repo##*/}"
    project_indexes=$((project_indexes + 1))
    indexes_attempted=$((indexes_attempted + 1))
    if ! sync_index "$label" "$repo"; then
      failures=$((failures + 1))
    fi
    if (( SECONDS >= RUN_DEADLINE )); then
      run_watchdog_expired=1
      break
    fi
  done

  if (( project_indexes == 0 )); then
    printf '[%s] qmd-sync status=failed reason=no-project-local-indexes path=%s\n' \
      "$(timestamp)" "$DEV_ROOT"
    failures=$((failures + 1))
  fi

  if (( run_watchdog_expired == 0 )); then
    indexes_attempted=$((indexes_attempted + 1))
    sync_index "$GLOBAL_INDEX" "$DEV_ROOT" --index "$GLOBAL_INDEX" \
      || failures=$((failures + 1))
  fi

  if (( SECONDS >= RUN_DEADLINE )); then
    run_watchdog_expired=1
  fi

  if (( run_watchdog_expired == 1 )); then
    failures=$((failures + 1))
    printf '[%s] qmd-sync status=failed reason=watchdog scope=run watchdog_seconds=%d indexes_attempted=%d\n' \
      "$(timestamp)" "$QMD_RUN_WATCHDOG_SECONDS" "$indexes_attempted"
  fi

  if (( failures > 0 )); then
    printf '[%s] qmd-sync status=failed last_run=%s indexes_attempted=%d failures=%d\n' \
      "$(timestamp)" "$run_started_at" "$indexes_attempted" "$failures"
    return 1
  fi

  printf '[%s] qmd-sync status=completed last_run=%s indexes_attempted=%d failures=0\n' \
    "$(timestamp)" "$run_started_at" "$indexes_attempted"
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
