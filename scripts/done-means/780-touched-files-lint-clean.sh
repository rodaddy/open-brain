#!/usr/bin/env bash
# Done-means for the #780 lint-debt sweep (Rico ruling 2026-08-26, option O1:
# one file at a time, each brought fully to standard before the next).
#
# WHAT THIS CHECKS, in plain words: every non-test TypeScript file under
# server/ that THIS BRANCH CHANGED must lint clean under the repo's own
# .oxlintrc.json with warnings treated as errors. That is the whole claim.
#
# WHAT A GREEN RUN DOES NOT MEAN. It does NOT mean server/ is clean. The
# sweep's own config comment records 142 production findings across 99 files in
# server/ at the lint gate's landing, and this sweep retires them ONE FILE PER
# LANE. So "PASS" here reads exactly as: "the files this PR touched are clean",
# never "the directory is clean". Anyone quoting this check as directory-level
# evidence is quoting it wrong.
#
# WHY THE FILE LIST COMES FROM THE DIFF. A per-lane check hardcoding its own
# file name would have to be edited every lane, and an edited check is a check
# nobody re-reads. Deriving the list from `git diff --name-only
# origin/main...HEAD` makes ONE script serve every rung of the sweep, and it
# also means a lane cannot pass by forgetting to list the file it changed.
#
# WHY AN EMPTY LIST IS A FAILURE, NOT A PASS. A linter handed zero paths exits
# 0. That is the classic vacuous green: the check would report success on a
# branch that changed nothing, on a detached HEAD where the three-dot diff comes
# back empty, and on a merge-base resolution that quietly broke. So an empty
# list exits 1 and SAYS SO by name, rather than being read as "all clean".
#
# THE OVERRIDE IS THE RED CONTROL. DONE_MEANS_780_FILES="<space-separated
# paths>" replaces the diff-derived list. That exists so the check can be proven
# to FAIL on content that is known dirty -- a check that has never failed proves
# nothing (docs/lane-contract.md, standing contract item 1). For lane 1:
#
#   # RED, on origin/main content -- must exit 1 naming the three findings
#   git stash / checkout origin/main -- server/main.ts   (or run from a main tree)
#   DONE_MEANS_780_FILES=server/main.ts bash scripts/done-means/780-touched-files-lint-clean.sh
#
#   # GREEN, on the lane head -- must exit 0 both with and without the override
#   bash scripts/done-means/780-touched-files-lint-clean.sh
#   DONE_MEANS_780_FILES=server/main.ts bash scripts/done-means/780-touched-files-lint-clean.sh
#
# MISSING BINARY FAILS CLOSED. If ./node_modules/.bin/oxlint is absent the check
# exits 1 naming it, never 0. Round 34 measured this exact hole from the other
# side: verify-lane installed dependencies at origin/main, hit `MISSING TOOL:
# oxlint`, and posted NO receipt. A lint check whose linter is missing has
# measured nothing, and must not be readable as clean.
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

OXLINT=./node_modules/.bin/oxlint
if [ ! -x "$OXLINT" ]; then
  echo "FAIL: missing lint binary $OXLINT -- run 'bun install --frozen-lockfile'."
  echo "      A lint check without a linter has measured nothing; failing closed."
  exit 1
fi
if [ ! -f .oxlintrc.json ]; then
  echo "FAIL: missing .oxlintrc.json at the repo root; there is no config to lint against."
  exit 1
fi

# The file list. Override wins; otherwise the branch's own diff against the
# upstream default branch, filtered to non-test TypeScript under server/.
declare -a targets=()
source_label=""
if [ -n "${DONE_MEANS_780_FILES:-}" ]; then
  source_label="DONE_MEANS_780_FILES override"
  # Word-split deliberately: the contract is a space-separated path list.
  # shellcheck disable=SC2206
  targets=(${DONE_MEANS_780_FILES})
else
  source_label="git diff --name-only origin/main...HEAD"
  while IFS= read -r f; do
    [ -n "$f" ] && targets+=("$f")
  done < <(git diff --name-only origin/main...HEAD -- 'server/**/*.ts' \
    | rg -v '\.test\.ts$' || true)
fi

# Deleted or renamed-away paths are in the diff but not on disk. Lint what
# exists; announce anything dropped, because nothing is adjusted silently
# (AGENTS.md Coding Standards, 2026-08-08).
declare -a present=()
for f in "${targets[@]}"; do
  if [ -f "$f" ]; then
    present+=("$f")
  else
    echo "note: $f is in the file list but not on disk (deleted or renamed); not linted."
  fi
done

if [ "${#present[@]}" -eq 0 ]; then
  echo "FAIL: EMPTY FILE LIST -- nothing was linted, so this run proves nothing."
  echo "      source: $source_label"
  echo "      A lint run over zero paths exits 0; that is a vacuous green and is"
  echo "      refused here. Expected at least one non-test server/**/*.ts file."
  exit 1
fi

echo "linting ${#present[@]} file(s) from: $source_label"
for f in "${present[@]}"; do echo "  - $f"; done

if "$OXLINT" --config .oxlintrc.json --deny-warnings "${present[@]}"; then
  echo "PASS: every file this branch touched under server/ lints clean."
  echo "      This says nothing about the rest of server/ -- see the header."
  exit 0
fi

echo "FAIL: oxlint reported findings in the file(s) listed above."
exit 1
