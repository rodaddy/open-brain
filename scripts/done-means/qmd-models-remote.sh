#!/usr/bin/env bash
# DONE-MEANS check: the qmd index models are remote llama-swap endpoints, not
# `hf:` local models (PR #959).
#
#   bash scripts/done-means/qmd-models-remote.sh
#
# qmd 2.6.3 (02c8dcb) refuses local models: with an `hf:` pin the librarian
# query job exits 3 ("Local models are disabled ... generate role") and
# `aqmd up` cannot embed. `.qmd/index.yml` beats `QMD_*_MODEL` env
# (qmd/src/llm.ts:292), so the yml is the thing to judge.
#
# Exit 0: all three `models.*` lines are `https://` URLs and none is `hf:`.
# Exit 1: any `hf:` model or a missing line. Exit 3: harness error.
set -u
cd "$(dirname "$0")/../.." || exit 3
yml=.qmd/index.yml
[ -f "$yml" ] || { echo "HARNESS ERROR: $yml missing"; exit 3; }
fail=0
for role in embed generate rerank; do
  line=$(rg -n "^  ${role}: " "$yml" | head -1)
  if [ -z "$line" ]; then echo "FAIL: models.${role} line missing"; fail=1; continue; fi
  case "$line" in
    *"${role}: https://"*) echo "ok   $line" ;;
    *) echo "FAIL $line (expected https://... , got a local or unknown model)"; fail=1 ;;
  esac
done
[ "$fail" -eq 0 ] && echo "PASS: qmd models are remote" && exit 0
echo "FAIL: qmd models are not all remote"
exit 1
