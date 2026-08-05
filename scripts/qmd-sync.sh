#!/usr/bin/env bash
set -euo pipefail

umask 077

DEV_ROOT="${DEV_ROOT:-/Volumes/ThunderBolt/Development}"
QMD_BIN="${QMD_BIN:-/Users/rico/.local/bin/qmd}"
LOG_DIR="${LOG_DIR:-/Volumes/ThunderBolt/open-brain/logs}"
LOG_FILE="${LOG_FILE:-$LOG_DIR/qmd-sync.log}"
GLOBAL_INDEX="global_docs_instructions"
HOME="${HOME:-/Users/rico}"
PATH="/Users/rico/.local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"
export HOME PATH

mkdir -p "$LOG_DIR"
touch "$LOG_FILE"
exec >> "$LOG_FILE" 2>&1

timestamp() {
  /bin/date '+%Y-%m-%dT%H:%M:%S%z'
}

strip_ansi() {
  /usr/bin/sed $'s/\033\[[0-9;]*m//g'
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

  if update_output="$(cd "$working_directory" && "$QMD_BIN" update "${index_args[@]}" 2>&1)"; then
    printf '%s\n' "$update_output"
  else
    exit_code=$?
    printf '%s\n' "$update_output"
    printf '[%s] index=%s status=failed step=update exit_code=%d\n' \
      "$(timestamp)" "$label" "$exit_code"
    return 1
  fi

  plain_output="$(printf '%s\n' "$update_output" | strip_ansi)"
  read -r files_new files_updated update_metric_lines < <(
    printf '%s\n' "$plain_output" | /usr/bin/awk '
      /^Indexed:/ { new_files += $2; updated_files += $4; lines++ }
      END { print new_files + 0, updated_files + 0, lines + 0 }
    '
  )

  if (( update_metric_lines == 0 )); then
    printf '[%s] index=%s status=failed step=metrics reason=update-output-unparseable\n' \
      "$(timestamp)" "$label"
    return 1
  fi

  if embed_output="$(cd "$working_directory" && "$QMD_BIN" embed "${index_args[@]}" 2>&1)"; then
    printf '%s\n' "$embed_output"
  else
    exit_code=$?
    printf '%s\n' "$embed_output"
    printf '[%s] index=%s status=failed step=embed exit_code=%d files_new=%s files_updated=%s\n' \
      "$(timestamp)" "$label" "$exit_code" "$files_new" "$files_updated"
    return 1
  fi

  plain_output="$(printf '%s\n' "$embed_output" | strip_ansi)"
  if printf '%s\n' "$plain_output" | /usr/bin/grep -q 'chunks still failed after retries'; then
    printf '[%s] index=%s status=failed step=embed reason=chunk-failures files_new=%s files_updated=%s\n' \
      "$(timestamp)" "$label" "$files_new" "$files_updated"
    return 1
  fi

  vectors_embedded="$(
    printf '%s\n' "$plain_output" | /usr/bin/awk '
      /Done!.*Embedded [0-9]+ chunks/ {
        for (i = 1; i <= NF; i++) {
          if ($i == "Embedded") {
            chunks += $(i + 1)
          }
        }
      }
      END { print chunks + 0 }
    '
  )"

  if ! printf '%s\n' "$plain_output" | /usr/bin/grep -Eq \
    'Done!.*Embedded [0-9]+ chunks|All content hashes already have embeddings|No non-empty documents to embed'; then
    printf '[%s] index=%s status=failed step=metrics reason=embed-output-unparseable\n' \
      "$(timestamp)" "$label"
    return 1
  fi

  if status_output="$(cd "$working_directory" && "$QMD_BIN" status "${index_args[@]}" 2>&1)"; then
    :
  else
    exit_code=$?
    printf '%s\n' "$status_output"
    printf '[%s] index=%s status=failed step=status exit_code=%d files_new=%s files_updated=%s vectors_embedded=%s\n' \
      "$(timestamp)" "$label" "$exit_code" "$files_new" "$files_updated" "$vectors_embedded"
    return 1
  fi

  plain_output="$(printf '%s\n' "$status_output" | strip_ansi)"
  files_indexed="$(printf '%s\n' "$plain_output" | /usr/bin/awk '/^[[:space:]]*Total:/ { print $2; exit }')"
  vectors_total="$(printf '%s\n' "$plain_output" | /usr/bin/awk '/^[[:space:]]*Vectors:/ { print $2; exit }')"

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

  run_started_at="$(timestamp)"
  printf '[%s] qmd-sync status=started dev_root=%s\n' "$run_started_at" "$DEV_ROOT"

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
  done

  if (( project_indexes == 0 )); then
    printf '[%s] qmd-sync status=failed reason=no-project-local-indexes path=%s\n' \
      "$(timestamp)" "$DEV_ROOT"
    failures=$((failures + 1))
  fi

  indexes_attempted=$((indexes_attempted + 1))
  if ! sync_index "$GLOBAL_INDEX" "$DEV_ROOT" --index "$GLOBAL_INDEX"; then
    failures=$((failures + 1))
  fi

  if (( failures > 0 )); then
    printf '[%s] qmd-sync status=failed last_run=%s indexes_attempted=%d failures=%d\n' \
      "$(timestamp)" "$run_started_at" "$indexes_attempted" "$failures"
    return 1
  fi

  printf '[%s] qmd-sync status=completed last_run=%s indexes_attempted=%d failures=0\n' \
    "$(timestamp)" "$run_started_at" "$indexes_attempted"
}

main "$@"
