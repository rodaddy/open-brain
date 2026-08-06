#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# The sourced path is resolved from this test file at runtime.
# shellcheck disable=SC1091
source "$SCRIPT_DIR/qmd-sync.sh"

assert_equal() {
  local expected="$1"
  local actual="$2"
  local label="$3"

  if [[ "$actual" != "$expected" ]]; then
    printf 'not ok - %s: expected <%s>, got <%s>\n' "$label" "$expected" "$actual" >&2
    return 1
  fi

  printf 'ok - %s\n' "$label"
}

assert_embed_output() {
  local fixture="$1"
  local expected_vectors="$2"
  local label="$3"
  local actual_vectors

  if ! printf '%s\n' "$fixture" | is_embed_terminal_output; then
    printf 'not ok - %s: terminal output was rejected\n' "$label" >&2
    return 1
  fi

  actual_vectors="$(printf '%s\n' "$fixture" | parse_embed_metrics)"
  assert_equal "$expected_vectors" "$actual_vectors" "$label vectors"
}

update_fixture='Indexed: 7 new, 3 updated, 11 unchanged'
status_fixture=$'Collection: open-brain\n  Total: 2001 documents\n  Vectors: 12345 embedded'

assert_equal '7 3 1' \
  "$(printf '%s\n' "$update_fixture" | parse_update_metrics)" \
  'update metrics'
assert_embed_output \
  'Done! Embedded 12,345 chunks from 2,001 documents in 3m' \
  '12345' \
  'comma-formatted embed metrics'
assert_embed_output \
  'All content hashes already have embeddings' \
  '0' \
  'already-embedded terminal output'
assert_embed_output \
  'No non-empty documents to embed' \
  '0' \
  'empty-documents terminal output'
assert_equal '2001 12345' \
  "$(printf '%s\n' "$status_fixture" | parse_status_metrics)" \
  'status metrics'

watchdog_test_root="${QMD_SYNC_TEST_ROOT:-/Volumes/ThunderBolt/_tmp/open-brain/_scratch/qmd-sync-test-$$}"
watchdog_fake_qmd="$watchdog_test_root/fake-qmd"
watchdog_child_pid_file="$watchdog_test_root/child.pid"
watchdog_log="$watchdog_test_root/watchdog.log"
mkdir -p "$watchdog_test_root"

cat > "$watchdog_fake_qmd" <<'EOF'
#!/opt/homebrew/bin/bash
set -euo pipefail

case "${1:-}" in
  update)
    printf 'Indexed: 1 new, 0 updated, 0 unchanged\n'
    ;;
  embed)
    /opt/homebrew/bin/bash -c \
      'trap "" TERM; printf "%d\n" "$$" > "$QMD_SYNC_TEST_CHILD_PID_FILE"; while :; do sleep 1; done' &
    wait
    ;;
  status)
    printf 'Collection: watchdog-test\n  Total: 1 documents\n  Vectors: 1 embedded\n'
    ;;
esac
EOF
/bin/chmod 700 "$watchdog_fake_qmd"

QMD_BIN="$watchdog_fake_qmd"
QMD_SYNC_TEST_CHILD_PID_FILE="$watchdog_child_pid_file"
export QMD_SYNC_TEST_CHILD_PID_FILE
QMD_EMBED_WATCHDOG_SECONDS=1
QMD_RUN_WATCHDOG_SECONDS=10
QMD_WATCHDOG_KILL_AFTER_SECONDS=1
SECONDS=0
RUN_DEADLINE=$((SECONDS + QMD_RUN_WATCHDOG_SECONDS))
export QMD_BIN QMD_EMBED_WATCHDOG_SECONDS QMD_WATCHDOG_KILL_AFTER_SECONDS RUN_DEADLINE
watchdog_started_at=$SECONDS

if sync_index watchdog-test "$watchdog_test_root" > "$watchdog_log" 2>&1; then
  printf 'not ok - watchdog: hung embed unexpectedly succeeded\n' >&2
  exit 1
fi

watchdog_elapsed=$((SECONDS - watchdog_started_at))
watchdog_output="$(< "$watchdog_log")"
watchdog_child_pid="$(< "$watchdog_child_pid_file")"

if (( watchdog_elapsed > 5 )); then
  printf 'not ok - watchdog: elapsed %ds, expected at most 5s\n' \
    "$watchdog_elapsed" >&2
  exit 1
fi

if [[ "$watchdog_output" != *'status=failed step=embed reason=watchdog scope=embed'* ]]; then
  printf 'not ok - watchdog: failure line missing from log\n' >&2
  exit 1
fi

for _ in {1..20}; do
  if ! kill -0 "$watchdog_child_pid" 2>/dev/null; then
    break
  fi
  sleep 0.1
done

if kill -0 "$watchdog_child_pid" 2>/dev/null; then
  printf 'not ok - watchdog: child process %s survived\n' \
    "$watchdog_child_pid" >&2
  exit 1
fi

printf 'ok - watchdog kills a hung embed process group and logs failure (%ds)\n' \
  "$watchdog_elapsed"
