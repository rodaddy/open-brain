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
