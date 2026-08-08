#!/usr/bin/env bash
# DONE-MEANS check for operator-approved improvement #2 (2026-08-08): every
# PR names the executable check that declares the work done, or gives a real
# reason why no executable check applies.
#
#   bash scripts/done-means/done-means-field-required.sh
#
# Exit 0 only when all five caller-visible validator behaviors pass. Exit 3 is
# a harness error, not a failure of the rule under test.
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TEMPLATE="$REPO_ROOT/.github/pull_request_template.md"
VALIDATOR="$REPO_ROOT/scripts/validate-pr-body.ts"

fail_hard() {
  printf 'HARNESS-ERROR: %s\n' "$1" >&2
  exit 3
}

command -v bun >/dev/null 2>&1 || fail_hard "bun not on PATH"
[ -r "$TEMPLATE" ] || fail_hard "template not readable at $TEMPLATE"
[ -r "$VALIDATOR" ] || fail_hard "validator not readable at $VALIDATOR"

DUMMY="dummy specific content for the acceptance gate"
BASE_BODY="$(
  sed \
    -e 's/\[ \]\(.*\)or \[ \] not applicable because:.*$/[x]\1or [ ] not applicable because:/' \
    -e 's/^- \[ \]/- [x]/' \
    -e "s/^\(- [^][]*:\)[[:space:]]*$/\1 $DUMMY/" \
    -e '/^- Done-means:/d' \
    "$TEMPLATE"
)" || fail_hard "could not build base PR body"

with_done_means() {
  local value="$1"
  printf '%s\n' "$BASE_BODY" | sed "/^## Verification$/a\\
- Done-means: $value"
}

run_validator() {
  local body="$1"
  VALIDATOR_OUTPUT="$(PR_BODY="$body" PR_TITLE="done-means field gate" bun "$VALIDATOR" 2>&1)"
  VALIDATOR_EXIT=$?
}

CLAUSES=()
record() { CLAUSES+=("$1|$2|$3"); }

run_validator "$BASE_BODY"
if [ "$VALIDATOR_EXIT" -ne 0 ] && printf '%s' "$VALIDATOR_OUTPUT" | rg -qF "Done-means"; then
  record a PASS "missing line rejected and the error names Done-means"
else
  record a FAIL "missing line was not rejected by the Done-means rule (exit=$VALIDATOR_EXIT): $(printf '%s' "$VALIDATOR_OUTPUT" | tr '\n' ' ')"
fi

run_validator "$(with_done_means 'scripts/validate-pr-body.ts')"
if [ "$VALIDATOR_EXIT" -eq 0 ]; then
  record b PASS "existing repo-relative path accepted"
else
  record b FAIL "existing path rejected (exit=$VALIDATOR_EXIT): $(printf '%s' "$VALIDATOR_OUTPUT" | tr '\n' ' ')"
fi

run_validator "$(with_done_means 'scripts/done-means/definitely-not-here.sh')"
if [ "$VALIDATOR_EXIT" -ne 0 ] && printf '%s' "$VALIDATOR_OUTPUT" | rg -qF "Done-means"; then
  record c PASS "nonexistent path rejected and the error names Done-means"
else
  record c FAIL "nonexistent path was not rejected by the Done-means rule (exit=$VALIDATOR_EXIT): $(printf '%s' "$VALIDATOR_OUTPUT" | tr '\n' ' ')"
fi

run_validator "$(with_done_means 'not applicable because: documentation-only change has no executable behavior')"
if [ "$VALIDATOR_EXIT" -eq 0 ]; then
  record d PASS "not-applicable form with a specific reason accepted"
else
  record d FAIL "specific not-applicable reason rejected (exit=$VALIDATOR_EXIT): $(printf '%s' "$VALIDATOR_OUTPUT" | tr '\n' ' ')"
fi

run_validator "$(with_done_means 'not applicable because: tbd')"
if [ "$VALIDATOR_EXIT" -ne 0 ] && printf '%s' "$VALIDATOR_OUTPUT" | rg -qF "Done-means"; then
  record e PASS "placeholder not-applicable reason rejected and the error names Done-means"
else
  record e FAIL "placeholder reason was not rejected by the Done-means rule (exit=$VALIDATOR_EXIT): $(printf '%s' "$VALIDATOR_OUTPUT" | tr '\n' ' ')"
fi

label_for() {
  case "$1" in
    a) printf 'body without Done-means fails naming the rule' ;;
    b) printf 'existing repo-relative path passes' ;;
    c) printf 'nonexistent path fails naming the rule' ;;
    d) printf 'not-applicable form with real reason passes' ;;
    e) printf 'placeholder not-applicable reason fails naming the rule' ;;
  esac
}

ALL_PASS=1
for entry in "${CLAUSES[@]}"; do
  id="${entry%%|*}"
  rest="${entry#*|}"
  status="${rest%%|*}"
  evidence="${rest#*|}"
  printf 'CLAUSE %s (%s): %s — %s\n' "$id" "$(label_for "$id")" "$status" "$evidence"
  [ "$status" = PASS ] || ALL_PASS=0
done

[ "$ALL_PASS" -eq 1 ] && exit 0
exit 1
