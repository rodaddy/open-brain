#!/usr/bin/env bash
# DONE-MEANS check for a handoff PR: every handoff document this PR adds or
# changes passes the handoff-author validator.
#
#   bash scripts/done-means/handoff-validates.sh
#
# The validator is the Development skill's judge
# (`_ob/skills/handoff-author/scripts/validate-handoff.sh`); HANDOFF-BASE.md
# says its exit 0 is the done condition for a handoff, prose conformance does
# not count. It lives outside this repo, so this check runs on a Development
# machine through verify-lane, not in CI; a missing validator FAILS the check
# rather than skipping it.
#
# Files come from the diff against `origin/main` (`_DOCS/_handoff/*.md`), or
# from `DONE_MEANS_HANDOFF_FILES="<space-separated paths>"` as an override.
# The override is the RED control: point it at one of the skill's
# `fixtures/fail-*.md` and this must exit 1. An empty file list is a FAIL, so
# the check cannot pass by examining nothing.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/../.."

VALIDATOR=/Volumes/ThunderBolt/Development/_ob/skills/handoff-author/scripts/validate-handoff.sh
if [[ ! -f $VALIDATOR ]]; then
  echo "FAIL: validator not found at $VALIDATOR"
  exit 1
fi

if [[ -n ${DONE_MEANS_HANDOFF_FILES:-} ]]; then
  read -r -a files <<< "$DONE_MEANS_HANDOFF_FILES"
  echo "note: file list overridden by DONE_MEANS_HANDOFF_FILES (${#files[@]} files)"
else
  # Committed, working-tree, and untracked handoff files alike, so the check
  # answers the same before the commit (author) and at the PR head
  # (verify-lane).
  mapfile -t files < <(
    {
      git diff --name-only origin/main...HEAD -- '_DOCS/_handoff/*.md'
      git diff --name-only origin/main -- '_DOCS/_handoff/*.md'
      git ls-files --others --exclude-standard -- '_DOCS/_handoff/*.md'
    } | sort -u
  )
fi

if (( ${#files[@]} == 0 )); then
  echo "FAIL: no handoff files to check (nothing under _DOCS/_handoff/ differs from origin/main)"
  exit 1
fi

failed=0
for f in "${files[@]}"; do
  if /opt/homebrew/bin/bash "$VALIDATOR" "$f"; then
    echo "ok   $f"
  else
    echo "FAIL $f"
    failed=1
  fi
done

if (( failed )); then
  echo "FAIL: a handoff document does not conform"
  exit 1
fi
echo "PASS: ${#files[@]} handoff document(s) conform"
