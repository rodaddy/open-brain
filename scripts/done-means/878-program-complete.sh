#!/usr/bin/env bash
# DONE-MEANS check for issue #878 -- the whole program: every Postgres test
# demands the test database, none skips itself, and the demand fails loudly.
#
#   bash scripts/done-means/878-program-complete.sh
#
# Three clauses, all must pass. Subject: tracked `*.test.ts` files outside
# `scripts/test-support/`, read from the working tree.
#   A  no code-line `process.env.OPENBRAIN_TEST_DATABASE_URL` read
#   B  no code-line `describe.skip`, `skipIf`, or `dbDescribe`; the one
#      allowlisted path is tests/enforcement.test.ts (its `skipIf` guards on
#      the oxlint config file's presence, not on a database variable)
#   C  `OPENBRAIN_TEST_DATABASE_URL='' bun test <one pg file>` exits non-zero
#      and prints `test_database_required`
# Comment lines (`//`, `/*`, `*`) are exempt in A and B, as in
# 878-pg-tests-require-database.sh: a converted file's header may still name
# the variable it demands.
# Exit 0: all three pass. Exit 1: any clause fails (each hit printed as
# `<clause> path:line`). Exit 3: harness error, including exit 127 from bun.
#
# NO ARGUMENTS. The subject is discovered from `git ls-files`, and the files
# are read from the WORKING TREE so a deliberate edit is judged before it is
# ever committed -- which is what makes the RED receipt takeable.
set -u

cd "$(dirname "$0")/../.." || exit 3
git rev-parse --is-inside-work-tree >/dev/null 2>&1 || {
  printf 'HARNESS-ERROR: not run from a checkout\n' >&2
  exit 3
}

command -v rg >/dev/null 2>&1 || { printf 'HARNESS-ERROR: rg not on PATH\n' >&2; exit 3; }
command -v bun >/dev/null 2>&1 || { printf 'HARNESS-ERROR: bun not on PATH\n' >&2; exit 3; }

ENV_READ='process\.env\.OPENBRAIN_TEST_DATABASE_URL'
BANNED_MACHINERY='describe\.skip|skipIf|dbDescribe'
# The single allowlisted clause-B path. `tests/enforcement.test.ts` uses
# `describe.skipIf(!CONFIG_PRESENT)`, which guards on whether the oxlint
# config FILE exists -- not on a database variable -- so it is not the
# self-skipping this program removes.
CLAUSE_B_ALLOWED='tests/enforcement.test.ts'
CLAUSE_C_FILE='src/tools/__tests__/append-session-event.pg.test.ts'
CLAUSE_C_LOG='/Volumes/ThunderBolt/_tmp/open-brain/_scratch/session13/878-clause-c.log'
HARD_FAIL_STRING='test_database_required'

SUBJECT="$(git ls-files -- '*.test.ts' | rg -v '^scripts/test-support/' || true)"
if [ -z "$SUBJECT" ]; then
  printf 'HARNESS-ERROR: git ls-files found no *.test.ts subject\n' >&2
  exit 3
fi

A_HITS=""
B_HITS=""
while IFS= read -r FILE; do
  [ -n "$FILE" ] || continue
  [ -f "$FILE" ] || continue
  # Comment lines are stripped first, then matches are numbered against the
  # ORIGINAL file with `rg -n` on the surviving text, so the printed line
  # numbers are the file's own.
  CODE="$(rg -n --no-heading '' "$FILE" 2>/dev/null | rg -v '^[0-9]+:[[:space:]]*(//|/\*|\*)' || true)"
  HIT_A="$(printf '%s\n' "$CODE" | rg "$ENV_READ" | cut -d: -f1 || true)"
  HIT_B="$(printf '%s\n' "$CODE" | rg "$BANNED_MACHINERY" | cut -d: -f1 || true)"
  if [ -n "$HIT_A" ]; then
    A_HITS="$A_HITS$(printf '%s\n' "$HIT_A" | sed "s|^|A $FILE:|")
"
  fi
  if [ -n "$HIT_B" ] && [ "$FILE" != "$CLAUSE_B_ALLOWED" ]; then
    B_HITS="$B_HITS$(printf '%s\n' "$HIT_B" | sed "s|^|B $FILE:|")
"
  fi
done <<EOSUBJ
$SUBJECT
EOSUBJ

A_HITS="$(printf '%s' "$A_HITS" | rg -v '^$' || true)"
B_HITS="$(printf '%s' "$B_HITS" | rg -v '^$' || true)"
A_COUNT=0
B_COUNT=0
[ -n "$A_HITS" ] && A_COUNT="$(printf '%s\n' "$A_HITS" | rg -c '^')"
[ -n "$B_HITS" ] && B_COUNT="$(printf '%s\n' "$B_HITS" | rg -c '^')"
[ -n "$A_HITS" ] && printf '%s\n' "$A_HITS"
[ -n "$B_HITS" ] && printf '%s\n' "$B_HITS"

# ---------------------------------------------------------------------------
# CLAUSE C -- the demand is OBSERVED failing, not merely arranged in source.
# ---------------------------------------------------------------------------
mkdir -p "$(dirname "$CLAUSE_C_LOG")" || exit 3
OPENBRAIN_TEST_DATABASE_URL='' bun test "$CLAUSE_C_FILE" >"$CLAUSE_C_LOG" 2>&1
C_STATUS=$?
if [ "$C_STATUS" -eq 127 ]; then
  printf 'HARNESS-ERROR: bun exited 127 running %s; see %s\n' "$CLAUSE_C_FILE" "$CLAUSE_C_LOG" >&2
  exit 3
fi
C_SEEN=absent
rg -qF "$HARD_FAIL_STRING" "$CLAUSE_C_LOG" && C_SEEN=seen

printf 'A: %s\n' "$A_COUNT"
printf 'B: %s\n' "$B_COUNT"
printf 'C: exit %s, %s %s\n' "$C_STATUS" "$HARD_FAIL_STRING" "$C_SEEN"

FAILED=""
[ "$A_COUNT" -ne 0 ] && FAILED="${FAILED}A"
[ "$B_COUNT" -ne 0 ] && FAILED="${FAILED}B"
{ [ "$C_STATUS" -eq 0 ] || [ "$C_SEEN" != seen ]; } && FAILED="${FAILED}C"

if [ -z "$FAILED" ]; then
  printf 'PASS\n'
  exit 0
fi
printf 'FAIL: %s\n' "$FAILED"
exit 1
