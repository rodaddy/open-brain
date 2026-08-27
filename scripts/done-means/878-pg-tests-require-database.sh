#!/usr/bin/env bash
# DONE-MEANS check for issue #878 -- a `.pg.test.ts` file demands the test
# database instead of skipping itself when the variable is absent.
#
#   bash scripts/done-means/878-pg-tests-require-database.sh
#
# ---------------------------------------------------------------------------
# The defect this gates
# ---------------------------------------------------------------------------
# A Postgres test file that reads `OPENBRAIN_TEST_DATABASE_URL` itself and
# swaps in `describe.skip` when it is unset reports `0 pass, N skip, 0 fail`
# and exits 0. At the exit code that is indistinguishable from a suite that ran
# and passed. CI stays green while the Postgres behavior nobody exercised
# drifts underneath it -- the false green.
#
# `scripts/test-support/require-test-database.ts` closes it. The suite calls
# `requireTestDatabaseUrl()` at module scope; absent the variable it throws
# `test_database_required` and the run fails loudly. A converted file therefore
# has no environment read of its own left, and no conditional describe.
#
# ---------------------------------------------------------------------------
# GENERIC BY DESIGN -- NO ARGUMENTS
# ---------------------------------------------------------------------------
# This check takes no argv. It discovers its own subject: files matching
# `*.pg.test.ts` changed against the MERGE BASE of origin/main and HEAD.
# Diffing against the moving tip of origin/main instead would drag in files
# other branches changed after this one was cut and judge them as if this lane
# had touched them. The merge base is the branch's own diff.
#
# `scripts/test-support/**` is always excluded, however it arrives. That
# directory holds the helper being imported, not a conversion subject, and it
# fails clause 2 by construction.
#
# Self-discovery is what makes one check serve every #878 conversion lane
# without editing it -- each lane converts different files and gets its own
# subject list for free.
#
# `CHANGED_FILES` (space-separated) overrides the discovery, which is how the
# RED receipt is taken before any edit exists to be discovered.
#
# ---------------------------------------------------------------------------
# Four clauses, and all four must pass
# ---------------------------------------------------------------------------
# CLAUSE 1 -- NO SELF-SKIPPING MACHINERY SURVIVES, per file.
#   Zero CODE references to the literal `OPENBRAIN_TEST_DATABASE_URL`, and zero
#   to `describe.skip`, `skipIf`, or `dbDescribe`. Comment lines are exempt:
#   a converted file's header still explains what it requires and why, and
#   reading prose as machinery would push authors to delete the explanation.
#   The exemption is line-shaped (`//`, `/*`, `*`), which is what prettier
#   leaves behind; a literal buried mid-expression on a code line still fails.
#
# CLAUSE 2 -- THE HELPER IS ACTUALLY IMPORTED.
#   Clause 1 alone is satisfiable by deleting the environment read and leaving
#   the suite connecting to nothing, which is worse than the defect. So clause 2
#   demands the identifier `requireTestDatabaseUrl` on an import line whose
#   module path ends in the basename `require-test-database`. Matching the
#   IDENTIFIER and the BASENAME rather than a fixed relative path is what lets
#   files at different depths under server/ and src/ satisfy the same clause --
#   `../../scripts/test-support/...` and `../scripts/test-support/...` are the
#   same import.
#
# CLAUSE 3 -- THE HARD FAIL IS OBSERVED, not merely arranged, per file.
#   Clauses 1 and 2 read source. Clause 3 runs the thing: with the variable
#   explicitly removed from the environment, `bun test <file>` must exit
#   NON-ZERO and its combined output must contain `test_database_required`.
#   Both halves matter. Non-zero alone is satisfiable by any unrelated crash,
#   and the string alone could appear in a run that still exited 0. Together
#   they say this specific guard fired and took the run down with it. `env -u`
#   removes the variable for that child only, so a developer with it exported
#   gets the same verdict as CI.
#
# CLAUSE 4 -- THE CONVERTED SUITE STILL PASSES, once for the whole subject.
#   `bun run test:isolated <subject files>` exits 0. Clause 3 proves the file
#   fails without a database; clause 4 proves it passes with one. A conversion
#   that broke the tests satisfies clause 3 perfectly and is not done.
#
# An EMPTY subject list is exit 1 with a message, never a silent pass: a check
# that examines nothing and reports success is the failure mode this whole
# family of scripts exists to avoid.
#
# NO ARGUMENTS.
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

fail_hard() {
  printf 'HARNESS-ERROR: %s\n' "$1" >&2
  exit 3
}

command -v rg >/dev/null 2>&1 || fail_hard "rg (ripgrep) not on PATH"
command -v git >/dev/null 2>&1 || fail_hard "git not on PATH"
command -v bun >/dev/null 2>&1 || fail_hard "bun not on PATH"
command -v env >/dev/null 2>&1 || fail_hard "env not on PATH"
[ -d "$REPO_ROOT/.git" ] || [ -f "$REPO_ROOT/.git" ] || fail_hard "not a git repo at $REPO_ROOT"

BANNED_MACHINERY='describe\.skip|skipIf|dbDescribe'
ENV_LITERAL='OPENBRAIN_TEST_DATABASE_URL'
HELPER_IDENT='requireTestDatabaseUrl'
HELPER_BASENAME='require-test-database'
HARD_FAIL_STRING='test_database_required'

# ---------------------------------------------------------------------------
# SUBJECT -- the *.pg.test.ts files changed against origin/main.
# ---------------------------------------------------------------------------
if [ -n "${CHANGED_FILES:-}" ]; then
  SUBJECT="$(printf '%s\n' $CHANGED_FILES)"
  SUBJECT_SOURCE="CHANGED_FILES override"
else
  MERGE_BASE="$(cd "$REPO_ROOT" && git merge-base origin/main HEAD 2>/dev/null)"
  [ -n "$MERGE_BASE" ] || fail_hard "git merge-base origin/main HEAD produced nothing"
  SUBJECT="$(cd "$REPO_ROOT" && git diff --name-only "$MERGE_BASE" 2>/dev/null)"
  SUBJECT_SOURCE="git diff --name-only \$(git merge-base origin/main HEAD)"
fi
SUBJECT="$(printf '%s\n' "$SUBJECT" | rg '\.pg\.test\.ts$' || true)"
# The helper directory is never a conversion subject, whether discovery or
# CHANGED_FILES put it there.
SUBJECT="$(printf '%s\n' "$SUBJECT" | rg -v '^scripts/test-support/' || true)"
SUBJECT="$(printf '%s\n' "$SUBJECT" | rg -v '^$' || true)"

if [ -z "$SUBJECT" ]; then
  printf 'SUBJECT: none -- %s produced no *.pg.test.ts files.\n' "$SUBJECT_SOURCE" >&2
  printf 'A check with nothing to examine is not a pass. Exiting 1.\n' >&2
  exit 1
fi

SUBJECT_N="$(printf '%s\n' "$SUBJECT" | rg -c '^')"
printf 'SUBJECT (%s file(s), from %s):\n' "$SUBJECT_N" "$SUBJECT_SOURCE"
printf '%s\n' "$SUBJECT" | sed 's/^/    /'
printf '\n'

CLAUSE1=PASS
CLAUSE2=PASS
CLAUSE3=PASS

# Strips the lines prettier leaves as comments, so clause 1 judges code only.
code_lines_of() {
  rg -v '^\s*(//|/\*|\*)' "$1" 2>/dev/null
}

while IFS= read -r FILE; do
  [ -n "$FILE" ] || continue
  if [ ! -f "$REPO_ROOT/$FILE" ]; then
    printf 'CLAUSE 1 [%s]: FAIL -- file does not exist\n' "$FILE"
    CLAUSE1=FAIL
    CLAUSE2=FAIL
    CLAUSE3=FAIL
    continue
  fi

  # -------------------------------------------------------------------------
  # CLAUSE 1 -- no environment read and no conditional describe, on code lines.
  # -------------------------------------------------------------------------
  CODE="$(cd "$REPO_ROOT" && code_lines_of "$FILE")"
  ENV_HITS="$(printf '%s\n' "$CODE" | rg -nF "$ENV_LITERAL" || true)"
  MACHINERY_HITS="$(printf '%s\n' "$CODE" | rg -n "$BANNED_MACHINERY" || true)"
  if [ -n "$ENV_HITS" ] || [ -n "$MACHINERY_HITS" ]; then
    printf 'CLAUSE 1 [%s]: FAIL -- self-skipping machinery survives on code lines:\n' "$FILE"
    printf '%s\n' "$ENV_HITS" "$MACHINERY_HITS" | rg -v '^$' | sed 's/^/    /'
    CLAUSE1=FAIL
  else
    printf 'CLAUSE 1 [%s]: PASS -- 0 code references to %s, describe.skip, skipIf, dbDescribe\n' \
      "$FILE" "$ENV_LITERAL"
  fi

  # -------------------------------------------------------------------------
  # CLAUSE 2 -- the helper arrives, matched on identifier plus module basename.
  # -------------------------------------------------------------------------
  IMPORT_HITS="$(cd "$REPO_ROOT" && rg -n "$HELPER_IDENT" "$FILE" 2>/dev/null \
    | rg -F "$HELPER_BASENAME" || true)"
  if [ -n "$IMPORT_HITS" ]; then
    printf 'CLAUSE 2 [%s]: PASS -- imports %s from a %s module\n' \
      "$FILE" "$HELPER_IDENT" "$HELPER_BASENAME"
  else
    printf 'CLAUSE 2 [%s]: FAIL -- no import of %s from a %s module\n' \
      "$FILE" "$HELPER_IDENT" "$HELPER_BASENAME"
    CLAUSE2=FAIL
  fi

  # -------------------------------------------------------------------------
  # CLAUSE 3 -- the hard fail is observed with the variable removed.
  # -------------------------------------------------------------------------
  RUN_OUT="$(cd "$REPO_ROOT" && env -u OPENBRAIN_TEST_DATABASE_URL bun test "$FILE" 2>&1)"
  RUN_STATUS=$?
  RUN_HAS_STRING=no
  printf '%s\n' "$RUN_OUT" | rg -qF "$HARD_FAIL_STRING" && RUN_HAS_STRING=yes
  if [ "$RUN_STATUS" -ne 0 ] && [ "$RUN_HAS_STRING" = yes ]; then
    printf 'CLAUSE 3 [%s]: PASS -- exited %s and printed %s\n' \
      "$FILE" "$RUN_STATUS" "$HARD_FAIL_STRING"
  else
    printf 'CLAUSE 3 [%s]: FAIL -- exit %s, %s present: %s\n' \
      "$FILE" "$RUN_STATUS" "$HARD_FAIL_STRING" "$RUN_HAS_STRING"
    printf '%s\n' "$RUN_OUT" | tail -n 12 | sed 's/^/    /'
    CLAUSE3=FAIL
  fi
done <<EOF
$SUBJECT
EOF

# ---------------------------------------------------------------------------
# CLAUSE 4 -- the whole subject still passes against a real database.
# ---------------------------------------------------------------------------
CLAUSE4=FAIL
SUBJECT_ARGS="$(printf '%s\n' "$SUBJECT" | tr '\n' ' ')"
ISO_OUT="$(cd "$REPO_ROOT" && bun run test:isolated $SUBJECT_ARGS 2>&1)"
ISO_STATUS=$?
if [ "$ISO_STATUS" -eq 0 ]; then
  CLAUSE4=PASS
  printf '\nCLAUSE 4 (bun run test:isolated over the subject): PASS -- exited 0\n'
else
  printf '\nCLAUSE 4 (bun run test:isolated over the subject): FAIL -- exited %s\n' "$ISO_STATUS"
  printf '%s\n' "$ISO_OUT" | tail -n 15 | sed 's/^/    /'
fi

printf '\nCLAUSE 1 (no self-skipping machinery on code lines): %s\n' "$CLAUSE1"
printf 'CLAUSE 2 (imports requireTestDatabaseUrl):           %s\n' "$CLAUSE2"
printf 'CLAUSE 3 (hard fail observed without the variable):  %s\n' "$CLAUSE3"
printf 'CLAUSE 4 (test:isolated over the subject exits 0):   %s\n' "$CLAUSE4"

if [ "$CLAUSE1" = PASS ] && [ "$CLAUSE2" = PASS ] && [ "$CLAUSE3" = PASS ] && [ "$CLAUSE4" = PASS ]; then
  exit 0
fi
exit 1
