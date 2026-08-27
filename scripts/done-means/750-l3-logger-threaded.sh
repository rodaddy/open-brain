#!/usr/bin/env bash
# DONE-MEANS check for rung L3 of the server/ hardening ladder
# (`_plans/server-hardening-ladder.md`, "one logger, threaded", issue #860).
#
#   bash scripts/done-means/750-l3-logger-threaded.sh
#
# ---------------------------------------------------------------------------
# The defect this gates
# ---------------------------------------------------------------------------
# L2 put every env read behind the composition root. L3 does the same job for
# the logger: ONE logger is constructed, at the root, and every module that
# wants to log receives it rather than reaching for a constructor of its own.
#
# The state L3 ends is the one where logging is decided per module. When a
# second `createLogger(` appears somewhere under server/, that module gets its
# own transport, its own destination chain, and its own view of the correlation
# context — and the two disagree silently, because nothing errors when a line
# is written to the wrong place. #612 is the receipt for how quiet that failure
# is: the service logged into a void for as long as the server path existed,
# with no error, no warning, and no dropped-line counter.
#
# Threading a logger by hand through every call signature is the obvious
# alternative and the reason this rung stalls: it edits every function that
# logs. So L3 delivers a decoration seam instead — `server/logging/decorate.ts`
# — and the check asserts BOTH halves: the single construction site (clauses 1
# and 2) and the seam that makes it reachable without rewriting signatures
# (clauses 3 and 4).
#
# ABSENCE ALONE IS NOT THE BAR. "No module imports the logger" is satisfiable
# by deleting all logging, which is worse than the defect. So clause 4 runs a
# driver test: a real thrown error inside a decorated function must produce a
# real log line carrying the stack and the correlation id from
# `server/logging/context.ts`. The seam has to WORK, not merely exist.
#
# ---------------------------------------------------------------------------
# Four clauses, and all four must pass
# ---------------------------------------------------------------------------
# CLAUSE 1 — EXACTLY ONE CONSTRUCTION SITE, AND IT IS THE ROOT.
#   `createLogger(` appears exactly once as a CALL in non-test server/ code, in
#   `server/main.ts`. The definition in `server/logging/logger.ts` is excluded
#   by path, not by pattern, so a second definition elsewhere still fails.
#
# CLAUSE 2 — NOBODY ELSE IMPORTS THE LOGGER MODULE.
#   Zero references to `logging/logger` in non-test server/ code outside
#   `server/main.ts` and `server/logging/`. An import is how a second
#   construction site starts, so this catches the state one commit earlier than
#   clause 1 does.
#
# CLAUSE 3 — THE SEAM EXISTS.
#   `server/logging/decorate.ts` is present and exports both `withLogging` (the
#   function wrapper, for plain functions and closures) and `logged` (the method
#   decorator, for class methods). Two spellings because the server has both
#   shapes and forcing either into the other's form is how a seam gets bypassed.
#
# CLAUSE 4 — THE SEAM DEMONSTRABLY LOGS THE FAILURE.
#   `server/logging/decorate.driver.test.ts` exists and
#   `bun test server/logging/decorate.driver.test.ts` exits 0. That test throws
#   inside a decorated function and asserts the emitted line carries `stack` and
#   the active correlation id. It is written RED, BEFORE decorate.ts, and it is
#   the specification the implementing lane codes against.
#
# CLAUSE 5 — THE SCANNER IS PROVEN TO MATCH (positive control).
#   The natural clause-1/2 assertions pass for two very different reasons:
#   because the state is correct, or because the scan examined nothing. A
#   renamed directory, a bad glob, an `rg` that is not on PATH — every one
#   produces a silent clean sweep and a meaningless exit 0. So the check proves
#   the same pattern, tool, and invocation still find a hit where one MUST
#   exist: `createLogger` in `server/logging/logger.ts`, the definition site,
#   which no lane on this rung should ever empty.
#
# ---------------------------------------------------------------------------
# STATE AT THE HEAD THAT INTRODUCES THIS CHECK (origin/main, this PR)
# ---------------------------------------------------------------------------
# Clauses 1, 2 and 5 PASS ALREADY. Measured: one `createLogger(` call at
# server/main.ts:495, one `logging/logger` import at server/main.ts:61, and the
# definition at server/logging/logger.ts:117. That is not an accident of this
# lane — the server rewrite root was built that way — and it is exactly why the
# check is worth having: those two properties are one careless import away from
# being false, and nothing else in the repo notices.
#
# Clauses 3 and 4 FAIL, by design, until States 5-6 of the L3 handover land.
# The overall exit is therefore 1 today. That is the honest answer, and the
# PR that introduces this file receipts its sibling
# `750-l3-check-well-formed.sh` instead, which asserts that THIS check is
# well-formed rather than that its subject is finished.
#
# NO ARGUMENTS.
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

fail_hard() {
  printf 'HARNESS-ERROR: %s\n' "$1" >&2
  exit 3
}

command -v rg >/dev/null 2>&1 || fail_hard "rg (ripgrep) not on PATH"
[ -d "$REPO_ROOT/.git" ] || [ -f "$REPO_ROOT/.git" ] || fail_hard "not a git repo at $REPO_ROOT"

ROOT_FILE="server/main.ts"
SEAM_FILE="server/logging/decorate.ts"
DRIVER_FILE="server/logging/decorate.driver.test.ts"
CONTROL_FILE="server/logging/logger.ts"

CLAUSE1=FAIL; CLAUSE1_EVIDENCE=""
CLAUSE2=FAIL; CLAUSE2_EVIDENCE=""
CLAUSE3=FAIL; CLAUSE3_EVIDENCE=""
CLAUSE4=FAIL; CLAUSE4_EVIDENCE=""
CLAUSE5=FAIL; CLAUSE5_EVIDENCE=""

# ---------------------------------------------------------------------------
# CLAUSE 1 — exactly one createLogger( call site, and it is the root.
# ---------------------------------------------------------------------------
# The definition lives in CONTROL_FILE and is excluded by path so that a second
# DEFINITION anywhere else still shows up as an extra hit here.
CALL_HITS="$(cd "$REPO_ROOT" && rg -nF 'createLogger(' server \
  --glob '!*.test.ts' --glob "!$CONTROL_FILE" 2>/dev/null)"
RG_STATUS=$?
[ "$RG_STATUS" -ge 2 ] && fail_hard "rg failed with status $RG_STATUS scanning for createLogger( call sites"

CALL_FILES="$(printf '%s\n' "$CALL_HITS" | rg -v '^$' | cut -d: -f1 | sort -u)"
CALL_COUNT="$(printf '%s\n' "$CALL_HITS" | rg -c '^' 2>/dev/null || true)"
[ -n "$CALL_HITS" ] || CALL_COUNT=0

if [ "$CALL_COUNT" -ne 1 ]; then
  CLAUSE1_EVIDENCE="found $CALL_COUNT createLogger( call site(s) in non-test server/ code, expected exactly 1"
elif [ "$CALL_FILES" != "$ROOT_FILE" ]; then
  CLAUSE1_EVIDENCE="the single call site is in $CALL_FILES, not the composition root $ROOT_FILE"
else
  CLAUSE1=PASS
  CLAUSE1_EVIDENCE="exactly 1 createLogger( call site, in $ROOT_FILE"
fi

# ---------------------------------------------------------------------------
# CLAUSE 2 — nobody outside the root and server/logging/ imports the module.
# ---------------------------------------------------------------------------
IMPORT_HITS="$(cd "$REPO_ROOT" && rg -nF 'logging/logger' server \
  --glob '!*.test.ts' --glob "!$ROOT_FILE" --glob '!server/logging/**' 2>/dev/null)"
RG_STATUS=$?
[ "$RG_STATUS" -ge 2 ] && fail_hard "rg failed with status $RG_STATUS scanning for logging/logger imports"

if [ -n "$IMPORT_HITS" ]; then
  IMPORT_COUNT="$(printf '%s\n' "$IMPORT_HITS" | rg -c '^')"
  CLAUSE2_EVIDENCE="$IMPORT_COUNT reference(s) to logging/logger outside $ROOT_FILE and server/logging/:"
  CLAUSE2_HITS="$IMPORT_HITS"
else
  CLAUSE2=PASS
  CLAUSE2_EVIDENCE="0 references to logging/logger outside $ROOT_FILE and server/logging/"
fi

# ---------------------------------------------------------------------------
# CLAUSE 3 — the decoration seam exists and exports both spellings.
# ---------------------------------------------------------------------------
if [ ! -f "$REPO_ROOT/$SEAM_FILE" ]; then
  CLAUSE3_EVIDENCE="$SEAM_FILE does not exist — States 5-6 of the L3 handover have not landed"
else
  WRAPPER_N="$(cd "$REPO_ROOT" && rg -cF 'export function withLogging' "$SEAM_FILE" 2>/dev/null)"
  WRAPPER_N="${WRAPPER_N:-0}"
  DECORATOR_N="$(cd "$REPO_ROOT" && rg -cF 'export function logged' "$SEAM_FILE" 2>/dev/null)"
  DECORATOR_N="${DECORATOR_N:-0}"
  if [ "$WRAPPER_N" -lt 1 ] || [ "$DECORATOR_N" -lt 1 ]; then
    CLAUSE3_EVIDENCE="$SEAM_FILE exists but exports withLogging=$WRAPPER_N, logged=$DECORATOR_N — both must be exported"
  else
    CLAUSE3=PASS
    CLAUSE3_EVIDENCE="$SEAM_FILE exports both withLogging (wrapper) and logged (method decorator)"
  fi
fi

# ---------------------------------------------------------------------------
# CLAUSE 4 — the driver test exists and passes.
# ---------------------------------------------------------------------------
if [ ! -f "$REPO_ROOT/$DRIVER_FILE" ]; then
  CLAUSE4_EVIDENCE="$DRIVER_FILE does not exist — nothing proves the seam actually logs a failure"
elif ! command -v bun >/dev/null 2>&1; then
  fail_hard "bun not on PATH; clause 4 cannot be judged"
else
  DRIVER_OUT="$(cd "$REPO_ROOT" && bun test "$DRIVER_FILE" 2>&1)"
  DRIVER_STATUS=$?
  if [ "$DRIVER_STATUS" -eq 0 ]; then
    CLAUSE4=PASS
    CLAUSE4_EVIDENCE="bun test $DRIVER_FILE exited 0 — a thrown error logs stack and correlation id"
  else
    CLAUSE4_EVIDENCE="bun test $DRIVER_FILE exited $DRIVER_STATUS — the seam does not yet log the failure:"
    CLAUSE4_HITS="$(printf '%s\n' "$DRIVER_OUT" | tail -n 12)"
  fi
fi

# ---------------------------------------------------------------------------
# CLAUSE 5 — positive control: the scanner still matches where it must.
# ---------------------------------------------------------------------------
if [ ! -f "$REPO_ROOT/$CONTROL_FILE" ]; then
  CLAUSE5_EVIDENCE="$CONTROL_FILE is missing — every clean result above is a broken scan, not a clean tree"
else
  CONTROL_N="$(cd "$REPO_ROOT" && rg -cF 'createLogger' "$CONTROL_FILE" 2>/dev/null)"
  CONTROL_N="${CONTROL_N:-0}"
  if [ "$CONTROL_N" -lt 1 ]; then
    CLAUSE5_EVIDENCE="0 createLogger hits in $CONTROL_FILE — the same scan that reported clauses 1 and 2 sees nothing"
  else
    CLAUSE5=PASS
    CLAUSE5_EVIDENCE="$CONTROL_N createLogger hit(s) in $CONTROL_FILE — the scanner is proven to match"
  fi
fi

printf 'CLAUSE 1 (one createLogger call site, at the root):  %s — %s\n' "$CLAUSE1" "$CLAUSE1_EVIDENCE"
if [ "$CLAUSE1" != PASS ] && [ -n "$CALL_HITS" ]; then
  printf '%s\n' "$CALL_HITS" | sed 's/^/    /'
fi
printf 'CLAUSE 2 (no logger imports outside the root):       %s — %s\n' "$CLAUSE2" "$CLAUSE2_EVIDENCE"
if [ "$CLAUSE2" != PASS ] && [ -n "${CLAUSE2_HITS:-}" ]; then
  printf '%s\n' "$CLAUSE2_HITS" | sed 's/^/    /'
fi
printf 'CLAUSE 3 (decoration seam exports both spellings):   %s — %s\n' "$CLAUSE3" "$CLAUSE3_EVIDENCE"
printf 'CLAUSE 4 (driver test proves the failure is logged): %s — %s\n' "$CLAUSE4" "$CLAUSE4_EVIDENCE"
if [ "$CLAUSE4" != PASS ] && [ -n "${CLAUSE4_HITS:-}" ]; then
  printf '%s\n' "$CLAUSE4_HITS" | sed 's/^/    /'
fi
printf 'CLAUSE 5 (scanner proven to match in %s): %s — %s\n' "$CONTROL_FILE" "$CLAUSE5" "$CLAUSE5_EVIDENCE"

if [ "$CLAUSE1" = PASS ] && [ "$CLAUSE2" = PASS ] && [ "$CLAUSE3" = PASS ] \
  && [ "$CLAUSE4" = PASS ] && [ "$CLAUSE5" = PASS ]; then
  exit 0
fi
exit 1
