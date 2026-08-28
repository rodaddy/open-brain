#!/opt/homebrew/bin/bash
# DONE-MEANS check for PR #745: the provider's git and merge guard refusals
# are labelled for every runtime, not for Codex alone.
#
#   bash scripts/done-means/745-guard-label-not-codex.sh
#
# The guard in python/openbrain-provider/src/openbrain_provider/policy_safety.py
# fires for Claude and Codex lanes alike; a refusal that opens with "Codex git
# guard:" tells a Claude lane the wrong thing about who refused it. GREEN when
# no refusal string carries the "Codex " prefix and the plain "git guard:" /
# "merge guard:" labels are present in both the source and the recorded
# ts_gate_parity fixture.
#
# Exit grammar: 0 pass, 1 the label is still Codex-specific, 3 harness error.
set -u
cd "$(git rev-parse --show-toplevel)" || exit 3
SRC=python/openbrain-provider/src/openbrain_provider/policy_safety.py
FIX=python/openbrain-provider/tests/fixtures/ts_gate_parity/recorded.json
[ -f "$SRC" ] && [ -f "$FIX" ] || { echo "HARNESS: $SRC or $FIX missing"; exit 3; }
rc=0
for f in "$SRC" "$FIX"; do
  stale=$(rg -c 'Codex (git|merge) guard:' "$f" || true)
  plain=$(rg -c '(^|[^a-zA-Z])(git|merge) guard:' "$f" || true)
  if [ "${stale:-0}" -ne 0 ]; then echo "FAIL: $f still has ${stale} Codex-labelled guard refusal(s)"; rc=1; fi
  if [ "${plain:-0}" -eq 0 ]; then echo "FAIL: $f has no plain guard label"; rc=1; fi
done
[ "$rc" -eq 0 ] && echo "PASS: guard refusals are labelled for every runtime in $SRC and $FIX"
exit "$rc"
