#!/usr/bin/env bash
# DONE-MEANS check for rung L5 of the server/ hardening ladder
# (issue #864, "shared-namespace owner").
#
#   bash scripts/done-means/750-l5-shared-namespace-owner.sh
#
# ---------------------------------------------------------------------------
# The defect this gates
# ---------------------------------------------------------------------------
# `src/shared-namespace.ts` and `server/tools/shared-namespace.ts` are twins.
# The src copy already knows two things the server copy does not: whether a
# name IS the retired `collab` namespace, and whether a write aimed at it must
# be refused. The server copy knowing only how to TRANSLATE names is the state
# this rung ends, because a caller on the server path has no way to ask the
# frozen-namespace question and therefore does not ask it.
#
# That failure is silent in the direction that matters. A write into the frozen
# legacy namespace succeeds and looks ordinary; nothing errors, and the row is
# indistinguishable afterward from one written before the freeze. So the gate
# is the presence of the ANSWERING functions on the server twin, not the
# presence of a caller — a caller can be added later, but it cannot be added at
# all while there is nothing to call.
#
# ---------------------------------------------------------------------------
# Four clauses, and all four must pass
# ---------------------------------------------------------------------------
# CLAUSE 1 — THE SERVER TWIN ANSWERS BOTH QUESTIONS.
#   `server/tools/shared-namespace.ts` exports `isLegacySharedNamespace` and
#   `shouldRejectLegacySharedWrite`. Both, because either alone leaves a caller
#   assembling the policy itself out of the other one, which is how two call
#   sites end up disagreeing about what "frozen" means.
#
# CLAUSE 2 — THE CONFIG GROUP CARRIES THE TWO FIELDS THAT FEED THEM.
#   `SharedNamespaceGroup` in `server/config/env-groups.ts` declares
#   `sharedNamespace` and `allowLegacySharedWrites`, and
#   `extendedEnvironmentFields` declares `OPENBRAIN_ALLOW_LEGACY_SHARED_WRITES`.
#   The helpers read no environment of their own by design, so an undeclared
#   field means the operator escape hatch is unreachable however the helper is
#   written.
#
# CLAUSE 3 — THE BEHAVIOR IS DRIVEN, NOT MERELY DECLARED.
#   `bun run test:isolated` over the three owning test files exits 0. Presence
#   checks alone are satisfied by a function that returns a constant, so this
#   clause runs the tests that pin the actual answers: an unconfigured legacy
#   name matching nothing, both admin roles passing, the escape hatch opening
#   the write, and the config reader producing both new fields.
#
# CLAUSE 4 — THE SCANNER IS PROVEN TO MATCH (positive control).
#   Clauses 1 and 2 pass either because the state is correct or because the
#   scan examined nothing — a renamed file, a bad glob, an `rg` missing from
#   PATH each produce a silent clean sweep. So the same pattern, tool, and
#   invocation must still find `export function isSharedNamespace`, which has
#   been in the server twin since before this rung and which no lane here
#   should ever remove.
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

TWIN_FILE="server/tools/shared-namespace.ts"
GROUPS_FILE="server/config/env-groups.ts"
TEST_FILES=(
  "server/config-extended.test.ts"
  "server/config-equivalence.test.ts"
  "server/tools/shared-namespace-legacy.test.ts"
)

[ -f "$REPO_ROOT/$TWIN_FILE" ] || fail_hard "$TWIN_FILE is missing"
[ -f "$REPO_ROOT/$GROUPS_FILE" ] || fail_hard "$GROUPS_FILE is missing"

CLAUSE1=FAIL; CLAUSE1_EVIDENCE=""
CLAUSE2=FAIL; CLAUSE2_EVIDENCE=""
CLAUSE3=FAIL; CLAUSE3_EVIDENCE=""
CLAUSE4=FAIL; CLAUSE4_EVIDENCE=""

# ---------------------------------------------------------------------------
# CLAUSE 1 — the server twin exports both legacy-namespace answers.
# ---------------------------------------------------------------------------
IS_LEGACY_N="$(cd "$REPO_ROOT" && rg -cF 'export function isLegacySharedNamespace' "$TWIN_FILE" 2>/dev/null)"
IS_LEGACY_N="${IS_LEGACY_N:-0}"
REJECT_N="$(cd "$REPO_ROOT" && rg -cF 'export function shouldRejectLegacySharedWrite' "$TWIN_FILE" 2>/dev/null)"
REJECT_N="${REJECT_N:-0}"

if [ "$IS_LEGACY_N" -lt 1 ] || [ "$REJECT_N" -lt 1 ]; then
  CLAUSE1_EVIDENCE="$TWIN_FILE exports isLegacySharedNamespace=$IS_LEGACY_N, shouldRejectLegacySharedWrite=$REJECT_N — both must be exported"
else
  CLAUSE1=PASS
  CLAUSE1_EVIDENCE="$TWIN_FILE exports both isLegacySharedNamespace and shouldRejectLegacySharedWrite"
fi

# ---------------------------------------------------------------------------
# CLAUSE 2 — the config group and the env field set carry the coordinates.
# ---------------------------------------------------------------------------
# The interface body is sliced out by line range so a same-named field on some
# OTHER interface in the file cannot satisfy this clause by accident.
GROUP_BODY="$(cd "$REPO_ROOT" && sed -n '/^export interface SharedNamespaceGroup {/,/^}/p' "$GROUPS_FILE")"
SHARED_N="$(printf '%s\n' "$GROUP_BODY" | rg -cF 'sharedNamespace:' 2>/dev/null)"
SHARED_N="${SHARED_N:-0}"
ALLOW_N="$(printf '%s\n' "$GROUP_BODY" | rg -cF 'allowLegacySharedWrites:' 2>/dev/null)"
ALLOW_N="${ALLOW_N:-0}"
ENV_BODY="$(cd "$REPO_ROOT" && sed -n '/^export const extendedEnvironmentFields = {/,/^} as const;/p' "$GROUPS_FILE")"
ENV_N="$(printf '%s\n' "$ENV_BODY" | rg -cF 'OPENBRAIN_ALLOW_LEGACY_SHARED_WRITES' 2>/dev/null)"
ENV_N="${ENV_N:-0}"

if [ "$SHARED_N" -lt 1 ] || [ "$ALLOW_N" -lt 1 ] || [ "$ENV_N" -lt 1 ]; then
  CLAUSE2_EVIDENCE="in $GROUPS_FILE: SharedNamespaceGroup.sharedNamespace=$SHARED_N, .allowLegacySharedWrites=$ALLOW_N, extendedEnvironmentFields.OPENBRAIN_ALLOW_LEGACY_SHARED_WRITES=$ENV_N — all three required"
else
  CLAUSE2=PASS
  CLAUSE2_EVIDENCE="SharedNamespaceGroup declares both fields and the env field set declares OPENBRAIN_ALLOW_LEGACY_SHARED_WRITES"
fi

# ---------------------------------------------------------------------------
# CLAUSE 3 — the owning tests pass against a fresh database.
# ---------------------------------------------------------------------------
MISSING_TESTS=""
for f in "${TEST_FILES[@]}"; do
  [ -f "$REPO_ROOT/$f" ] || MISSING_TESTS="$MISSING_TESTS $f"
done

if [ -n "$MISSING_TESTS" ]; then
  CLAUSE3_EVIDENCE="missing test file(s):$MISSING_TESTS"
elif ! command -v bun >/dev/null 2>&1; then
  fail_hard "bun not on PATH; clause 3 cannot be judged"
else
  TEST_OUT="$(cd "$REPO_ROOT" && bun run test:isolated "${TEST_FILES[@]}" 2>&1)"
  TEST_STATUS=$?
  if [ "$TEST_STATUS" -eq 0 ]; then
    CLAUSE3=PASS
    CLAUSE3_EVIDENCE="bun run test:isolated over ${#TEST_FILES[@]} owning test file(s) exited 0"
  else
    CLAUSE3_EVIDENCE="bun run test:isolated exited $TEST_STATUS over the owning test files:"
    CLAUSE3_HITS="$(printf '%s\n' "$TEST_OUT" | tail -n 12)"
  fi
fi

# ---------------------------------------------------------------------------
# CLAUSE 4 — positive control: the scanner still matches where it must.
# ---------------------------------------------------------------------------
CONTROL_N="$(cd "$REPO_ROOT" && rg -cF 'export function isSharedNamespace' "$TWIN_FILE" 2>/dev/null)"
CONTROL_N="${CONTROL_N:-0}"
if [ "$CONTROL_N" -lt 1 ]; then
  CLAUSE4_EVIDENCE="0 isSharedNamespace hits in $TWIN_FILE — the same scan that reported clauses 1 and 2 sees nothing"
else
  CLAUSE4=PASS
  CLAUSE4_EVIDENCE="$CONTROL_N isSharedNamespace hit(s) in $TWIN_FILE — the scanner is proven to match"
fi

printf 'CLAUSE 1 (server twin answers both legacy questions): %s — %s\n' "$CLAUSE1" "$CLAUSE1_EVIDENCE"
printf 'CLAUSE 2 (config group carries the two fields):       %s — %s\n' "$CLAUSE2" "$CLAUSE2_EVIDENCE"
printf 'CLAUSE 3 (owning tests drive the behavior):           %s — %s\n' "$CLAUSE3" "$CLAUSE3_EVIDENCE"
if [ "$CLAUSE3" != PASS ] && [ -n "${CLAUSE3_HITS:-}" ]; then
  printf '%s\n' "$CLAUSE3_HITS" | sed 's/^/    /'
fi
printf 'CLAUSE 4 (scanner proven to match in %s): %s — %s\n' "$TWIN_FILE" "$CLAUSE4" "$CLAUSE4_EVIDENCE"

if [ "$CLAUSE1" = PASS ] && [ "$CLAUSE2" = PASS ] && [ "$CLAUSE3" = PASS ] \
  && [ "$CLAUSE4" = PASS ]; then
  exit 0
fi
exit 1
