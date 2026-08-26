#!/usr/bin/env bash
# DONE-MEANS check for #750 -- the pre-commit oxlint gate actually REFUSES a
# violation, rather than existing and examining nothing.
#
#   bash scripts/done-means/750-precommit-lint-gate-fires.sh
#
# WHY A DELIBERATE VIOLATION AND NOT A GREEN RUN. A clean commit passing proves
# only that nothing objected; a step that is skipped, misconfigured, or pointed
# at zero files passes identically. The gate is only proven by content it MUST
# reject. This script therefore builds a probe carrying one violation of each of
# three rules and asserts the commit is refused BY THE OXLINT STEP, naming them.
#
# The three rules are chosen to cover the config's distinct rule families:
# a typescript/ rule (no-explicit-any), a plain eslint rule (no-console), and a
# SIZE rule (max-lines-per-function) whose threshold lives in .oxlintrc.json
# rather than in the rule's default. The last is what catches a config that
# loaded but was not applied.
#
# HOOKSPATH IS PART OF WHAT IS UNDER TEST. `core.hooksPath` selects exactly one
# directory, and this repo's is `_githooks` (see _githooks/install.sh). If it
# still points at an operator's global hooks dir, the hook under test is not the
# one git executes -- observed 2026-08-26, where an earlier probe committed
# clean for exactly that reason and looked like a passing gate. This script
# asserts the path before it trusts any result.
#
# NOTHING IS COMMITTED. The probe is staged, committed AGAINST, and expected to
# be refused. On the way out the stage is reset and the probe is moved into the
# temp workspace archive -- `mv`, never a recursive delete (AGENTS.md).
set -uo pipefail

ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT" || exit 1

PROBE="server/tools/__done_means_750_probe__.ts"
ARCHIVE="${HOOK_SCRATCH_ROOT:-/Volumes/ThunderBolt/_tmp/open-brain/_scratch}/../_archive"

cleanup() {
  git restore --staged "$PROBE" 2>/dev/null || true
  if [ -f "$PROBE" ]; then
    mkdir -p "$ARCHIVE" 2>/dev/null || true
    mv "$PROBE" "$ARCHIVE/$(basename "$PROBE" .ts)-$(date +%s).ts" 2>/dev/null || true
  fi
}
trap cleanup EXIT

fail() { echo "FAIL: $*" >&2; exit 1; }

# --- precondition: the hook git runs is this repo's ------------------------
hooks_path="$(git config --get core.hooksPath 2>/dev/null || true)"
if [ "$hooks_path" != "_githooks" ]; then
  fail "core.hooksPath is '${hooks_path:-<unset>}', not '_githooks'. Run _githooks/install.sh.
      A gate that git does not execute cannot refuse anything, and this check
      would otherwise report a pass for a hook that never ran."
fi
[ -x "$ROOT/_githooks/pre-commit" ] || fail "_githooks/pre-commit is missing or not executable."
[ -f "$ROOT/.oxlintrc.json" ] || fail ".oxlintrc.json is absent; the hook's oxlint step is config-guarded and would SKIP."

# --- build the probe -------------------------------------------------------
{
  echo "const x: any = 1;"
  echo "console.log(x);"
  echo ""
  echo "export function doneMeans750Oversized(): number {"
  echo "  let total = 0;"
  for i in $(seq 0 120); do echo "  total += $i;"; done
  echo "  return total;"
  echo "}"
} > "$PROBE"

git add "$PROBE" || fail "could not stage the probe"

out="$(git commit -m "done-means 750 probe -- expected to be REFUSED" 2>&1)"
status=$?

echo "$out"

# --- assertions ------------------------------------------------------------
[ $status -ne 0 ] || fail "the commit SUCCEEDED. The lint gate did not refuse a file
      carrying no-explicit-any, no-console, and an over-length function."

case "$out" in
  *"oxlint (staged content)"*) ;;
  *) fail "refused, but not by the oxlint step -- its header never printed. Something
      else blocked the commit, so this is not evidence the lint gate works." ;;
esac

case "$out" in *"SKIPPED"*"oxlintrc"*)
  fail "the oxlint step SKIPPED for want of a config while .oxlintrc.json exists." ;;
esac

for rule in "no-explicit-any" "no-console" "max-lines-per-function"; do
  case "$out" in
    *"$rule"*) ;;
    *) fail "the refusal never named $rule. Each of the three must fire; a partial
      refusal means the rule set loaded incompletely." ;;
  esac
done

echo
echo "PASS: the commit was REFUSED by the oxlint step, naming no-explicit-any,"
echo "      no-console, and max-lines-per-function. Nothing was committed."
