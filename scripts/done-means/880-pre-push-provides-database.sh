#!/usr/bin/env bash
# DONE-MEANS check for issue #880 — the pre-push hook provides a database to the
# test suite instead of running it bare.
#
#   bash scripts/done-means/880-pre-push-provides-database.sh
#
# ---------------------------------------------------------------------------
# The defect this gates
# ---------------------------------------------------------------------------
# `_githooks/pre-push` ran a bare `bun test` on the working tree with no
# OPENBRAIN_TEST_DATABASE_URL set. Under the #878 ruling a Postgres test no
# longer skips itself when no database is configured —
# `scripts/test-support/require-test-database.ts` throws
# `test_database_required` — so from the moment the first converted Postgres
# test landed on main (`server/tools/reporting.pg.test.ts`, 3468bdf8) this hook
# refused EVERY push, including ones whose diff contained no TypeScript at all.
#
# A gate that refuses for a reason unrelated to the change in hand is the same
# family as #705 and #712, and it is the condition that trains everyone to reach
# for `--no-verify`. `bun run test:isolated` (scripts/test-isolated.ts) is the
# repo's own answer: it creates a uniquely-named database, migrates it, exports
# the variable, passes its arguments through to `bun test`, and drops the
# database on the way out.
#
# ---------------------------------------------------------------------------
# Two clauses, and both must pass
# ---------------------------------------------------------------------------
# CLAUSE 1 — THE HOOK CALLS THE ISOLATED RUNNER, AND NOTHING CALLS `bun test`
#   BARE. At least one `bun run test:isolated` in the hook, and zero lines whose
#   first word is `bun test`. Both halves matter: adding the isolated runner
#   while leaving the bare call in place fixes nothing, and the bare call is what
#   actually produced the refusal.
#
# CLAUSE 2 — THE HOOK ACTUALLY PASSES ON THE CURRENT TREE. The hook is driven
#   the way git drives it — an empty line on stdin, `origin` and a URL as
#   arguments — and must exit 0. Clause 1 is a text assertion and could be
#   satisfied by a hook that is broken for some other reason; this clause is the
#   behavioural one, and it is the receipt the issue is actually about.
#
# A MISSING OR EMPTY HOOK IS A FAILURE, NOT A PASS. Deleting the file would make
# every text assertion above vacuously clean, which is the classic way a check
# reports success for having examined nothing.
#
# NO ARGUMENTS.
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
HOOK_FILE="_githooks/pre-push"

fail_hard() {
  printf 'HARNESS-ERROR: %s\n' "$1" >&2
  exit 3
}

command -v rg >/dev/null 2>&1 || fail_hard "rg (ripgrep) not on PATH"

if [ ! -s "$REPO_ROOT/$HOOK_FILE" ]; then
  printf 'CLAUSE 1 (hook calls the isolated runner): FAIL — %s is missing or empty\n' "$HOOK_FILE"
  printf 'CLAUSE 2 (hook exits 0 on the current tree): FAIL — no hook to run\n'
  exit 1
fi

CLAUSE1=FAIL; CLAUSE1_EVIDENCE=""
CLAUSE2=FAIL; CLAUSE2_EVIDENCE=""

# ---------------------------------------------------------------------------
# CLAUSE 1 — the isolated runner is present and the bare call is gone.
# ---------------------------------------------------------------------------
ISOLATED_HITS="$(cd "$REPO_ROOT" && rg -n 'bun run test:isolated' "$HOOK_FILE" 2>/dev/null)"
RG_STATUS=$?
[ "$RG_STATUS" -ge 2 ] && fail_hard "rg failed with status $RG_STATUS scanning for the isolated runner"
ISOLATED_N=0
[ -n "$ISOLATED_HITS" ] && ISOLATED_N="$(printf '%s\n' "$ISOLATED_HITS" | rg -c '^')"

BARE_HITS="$(cd "$REPO_ROOT" && rg -n '^\s*bun test' "$HOOK_FILE" 2>/dev/null)"
RG_STATUS=$?
[ "$RG_STATUS" -ge 2 ] && fail_hard "rg failed with status $RG_STATUS scanning for a bare bun test call"
BARE_N=0
[ -n "$BARE_HITS" ] && BARE_N="$(printf '%s\n' "$BARE_HITS" | rg -c '^')"

if [ "$ISOLATED_N" -lt 1 ]; then
  CLAUSE1_EVIDENCE="0 'bun run test:isolated' invocations in $HOOK_FILE — the suite still gets no database"
elif [ "$BARE_N" -ne 0 ]; then
  CLAUSE1_EVIDENCE="$BARE_N bare 'bun test' invocation(s) remain in $HOOK_FILE alongside the isolated runner"
else
  CLAUSE1=PASS
  CLAUSE1_EVIDENCE="$ISOLATED_N 'bun run test:isolated' invocation(s), 0 bare 'bun test' invocations"
fi

# ---------------------------------------------------------------------------
# CLAUSE 2 — the hook exits 0 when driven the way git drives it.
# ---------------------------------------------------------------------------
command -v zsh >/dev/null 2>&1 || fail_hard "zsh not on PATH; the hook's shebang cannot be honoured"

HOOK_OUT="$(cd "$REPO_ROOT" && echo | zsh "$HOOK_FILE" origin git@github.com:rodaddy/open-brain.git 2>&1)"
HOOK_STATUS=$?
if [ "$HOOK_STATUS" -eq 0 ]; then
  CLAUSE2=PASS
  CLAUSE2_EVIDENCE="the hook exited 0 on the current working tree"
else
  CLAUSE2_EVIDENCE="the hook exited $HOOK_STATUS on the current working tree:"
  CLAUSE2_HITS="$(printf '%s\n' "$HOOK_OUT" | tail -n 12)"
fi

printf 'CLAUSE 1 (isolated runner in, bare bun test out):  %s — %s\n' "$CLAUSE1" "$CLAUSE1_EVIDENCE"
if [ "$CLAUSE1" != PASS ] && [ -n "$BARE_HITS" ]; then
  printf '%s\n' "$BARE_HITS" | sed 's/^/    /'
fi
printf 'CLAUSE 2 (hook exits 0 on the current tree):       %s — %s\n' "$CLAUSE2" "$CLAUSE2_EVIDENCE"
if [ "$CLAUSE2" != PASS ] && [ -n "${CLAUSE2_HITS:-}" ]; then
  printf '%s\n' "$CLAUSE2_HITS" | sed 's/^/    /'
fi

if [ "$CLAUSE1" = PASS ] && [ "$CLAUSE2" = PASS ]; then
  exit 0
fi
exit 1
