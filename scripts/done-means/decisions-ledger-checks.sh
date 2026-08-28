#!/opt/homebrew/bin/bash
# DONE-MEANS check for a decisions-ledger pass: the ledger, the Tightenings
# ratchet, and the placeholder scan all judge the tree at once.
#
#   bash scripts/done-means/decisions-ledger-checks.sh
#
# Runs the three Graph Mode v1.3-beta canon checks from the Development canon
# path (docs/controller-contract.md, "Graph Mode v1.3-beta", item 3) and fails
# if any of them fails. A ledger PR that ratifies rows, graduates a round, or
# edits the contract is GREEN only when every one of them exits 0.
#
# Exit grammar: 0 pass, 1 a check failed, 3 harness error (canon missing).
set -u
BETA=/Volumes/ThunderBolt/Development/_ob/skills/graph-mode/beta
cd "$(git rev-parse --show-toplevel)" || exit 3
for c in decisions ratchet-bound placeholders; do
  [ -x "$BETA/$c/check.sh" ] || { echo "HARNESS: missing canon check $BETA/$c/check.sh"; exit 3; }
done
rc=0
run() {
  local label=$1; shift
  if /opt/homebrew/bin/bash "$@"; then echo "PASS: $label"; else echo "FAIL: $label"; rc=1; fi
}
run "decisions/check.sh docs/decisions.md" "$BETA/decisions/check.sh" docs/decisions.md
run "ratchet-bound/check.sh docs/lane-contract.md" "$BETA/ratchet-bound/check.sh" docs/lane-contract.md
run "placeholders/check.sh docs/decisions.md docs/lane-contract.md docs/controller-contract.md" \
  "$BETA/placeholders/check.sh" docs/decisions.md docs/lane-contract.md docs/controller-contract.md
[ "$rc" -eq 0 ] && echo "PASS: ledger, ratchet, and placeholders all green" || echo "FAIL: a ledger check is red"
exit "$rc"
