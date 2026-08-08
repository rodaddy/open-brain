#!/usr/bin/env bash
# DONE-MEANS check for issue #637 — "design-lookup-gate: word-match false
# positives tax every lane (prune, tighter, truncation, constraint)".
#
#   bash scripts/done-means/637-gate-precision.sh
#
# ---------------------------------------------------------------------------
# The defect this gates
# ---------------------------------------------------------------------------
# The cap wall in `.claude/hooks/design-lookup-gate.ts` judged VOCABULARY: any
# text carrying a limitation word hit a HARD NO with no precondition to clear
# it. That is the same defect class as #618 (a git guard matching protected
# branch names inside heredoc TEXT rather than in the command being run).
#
# Measured false positives, 2026-08-07/08 sessions, every one of them recorded
# in `docs/lane-contract.md` Tightenings or on #637 itself:
#
#   - `prune` inside `git worktree prune` — a command AGENTS.md MANDATES at
#     cleanup — blocked twice, in commit messages.
#   - `tighter` inside an OPERATOR QUOTE being harvested into the lane contract.
#   - `truncation` in a BUG REPORT describing a defect that already existed.
#   - `constraint` naming a SQL identifier
#     (`information_schema.constraint_column_usage`).
#   - an AskUserQuestion presenting the operator's OWN recorded #563 options.
#
# ---------------------------------------------------------------------------
# What this check asserts, and what it deliberately does NOT relax
# ---------------------------------------------------------------------------
# The hard constraint on any fix (issue #637, verbatim): "the no-size-reduction
# standing rule's teeth must NOT weaken". So this check is TWO-SIDED and both
# sides are load-bearing:
#
#   FALSE-POSITIVE corpus (scripts/done-means/fixtures/637-false-positives.json)
#     Every entry MUST be ALLOWED (exit 0). These are the recorded taxes.
#
#   TRUE-POSITIVE corpus  (scripts/done-means/fixtures/637-true-positives.json)
#     Every entry MUST be BLOCKED (exit 2) by the cap wall specifically — not
#     by some other clause that happens to also refuse. The refusal text is
#     asserted so a block for the WRONG reason cannot bank a false pass.
#
# A one-sided version of this check is worthless in both directions: passing
# every false positive is trivially achieved by deleting the wall, and blocking
# every true positive is trivially achieved by blocking everything. Only the
# conjunction means anything, which is why a single script owns both corpora
# and why a true-positive regression fails the whole run.
#
# ---------------------------------------------------------------------------
# Why the fixtures are DATA FILES and not inline strings
# ---------------------------------------------------------------------------
# This check's fixtures are, by construction, exactly the text that trips the
# gate. Inlining them into the script means every agent that edits this file
# hits the wall on its own test data — the gate firing on the lane fixing the
# gate. Holding them as JSON that the driver reads keeps the payloads out of
# the tool calls that write the checker.
#
# ---------------------------------------------------------------------------
# Isolation
# ---------------------------------------------------------------------------
# The gate persists lookup history to a shared state file under
# ~/.local/state/open-brain-design-gate/state.json. This check drives it with a
# UNIQUE session id per fixture and PRE-SEEDS a covering lookup, so:
#   - the relevance clause (a different, working feature) never fires and is
#     never what is being measured here, and
#   - the live session's own history is untouched.
# The driver saves and restores the state file regardless of outcome.
#
# Verdict convention matches the other gates: exit 2 = blocked with a reason on
# stderr, exit 0 = allowed. Exit 3 from THIS script is a harness error (missing
# tool, unreadable fixture), which is NOT a fail of the thing under test.
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
HOOK="$REPO_ROOT/.claude/hooks/design-lookup-gate.ts"
DRIVER="$REPO_ROOT/scripts/done-means/637-gate-precision.driver.ts"
FP_FIXTURES="$REPO_ROOT/scripts/done-means/fixtures/637-false-positives.json"
TP_FIXTURES="$REPO_ROOT/scripts/done-means/fixtures/637-true-positives.json"

fail_hard() {
  printf 'HARNESS-ERROR: %s\n' "$1" >&2
  exit 3
}

command -v bun >/dev/null 2>&1 || fail_hard "bun not on PATH"
[ -r "$HOOK" ] || fail_hard "hook not readable at $HOOK"
[ -r "$DRIVER" ] || fail_hard "driver not readable at $DRIVER"
[ -r "$FP_FIXTURES" ] || fail_hard "false-positive fixtures missing at $FP_FIXTURES"
[ -r "$TP_FIXTURES" ] || fail_hard "true-positive fixtures missing at $TP_FIXTURES"

# Sanity: both corpora must be non-empty and the true-positive corpus must
# carry at least the 6 varied agent-voice proposals #637 asks for. A check that
# silently runs zero clauses exits 0 and proves nothing — the silent-no-op
# failure mode this repo has been bitten by before.
FP_COUNT="$(bun -e 'console.log(JSON.parse(await Bun.file(process.argv[1]).text()).length)' "$FP_FIXTURES")" \
  || fail_hard "could not parse $FP_FIXTURES"
TP_COUNT="$(bun -e 'console.log(JSON.parse(await Bun.file(process.argv[1]).text()).length)' "$TP_FIXTURES")" \
  || fail_hard "could not parse $TP_FIXTURES"

[ "$FP_COUNT" -ge 5 ] || fail_hard "false-positive corpus has only $FP_COUNT entries; the recorded corpus is larger"
[ "$TP_COUNT" -ge 6 ] || fail_hard "true-positive corpus has only $TP_COUNT entries; #637 requires at least 6 varied proposals"

printf 'Corpora: %s false positives (must ALLOW), %s true positives (must BLOCK)\n\n' \
  "$FP_COUNT" "$TP_COUNT"

bun "$DRIVER" --hook "$HOOK" --false-positives "$FP_FIXTURES" --true-positives "$TP_FIXTURES"
exit $?
