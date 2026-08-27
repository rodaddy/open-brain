#!/usr/bin/env bash
# DONE-MEANS check for a handover PR: every handover document this PR adds or
# changes passes the handover-author validator.
#
#   bash scripts/done-means/handover-validates.sh
#
# The validator is the Development skill's judge
# (`_ob/skills/handover-author/scripts/validate-handover.sh`); HANDOVER-BASE.md
# says its exit 0 is the done condition for a handover, prose conformance does
# not count. It lives outside this repo, so this check runs on a Development
# machine through verify-lane, not in CI; a missing validator FAILS the check
# rather than skipping it.
#
# Files come from this branch's own diff against `origin/main`
# (`origin/main...HEAD`, `_DOCS/_handover/*.md`), plus untracked handover files, or
# from `DONE_MEANS_HANDOVER_FILES="<space-separated paths>"` as an override. A
# change to the rules layer (`_DOCS/HANDOVER-RULES.md`) is judged by the newest
# handover document, the last `_DOCS/_handover/*.md` by name sort.
# The override is the RED control: point it at one of the skill's
# `fixtures/fail-*.md` and this must exit 1. An empty file list is a FAIL, so
# the check cannot pass by examining nothing.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/../.."

VALIDATOR=/Volumes/ThunderBolt/Development/_ob/skills/handover-author/scripts/validate-handover.sh
if [[ ! -f $VALIDATOR ]]; then
  echo "FAIL: validator not found at $VALIDATOR"
  exit 1
fi

if [[ -n ${DONE_MEANS_HANDOVER_FILES:-} ]]; then
  read -r -a files <<< "$DONE_MEANS_HANDOVER_FILES"
  echo "note: file list overridden by DONE_MEANS_HANDOVER_FILES (${#files[@]} files)"
else
  # Committed, working-tree, and untracked handover files alike, so the check
  # answers the same before the commit (author) and at the PR head
  # (verify-lane).
  mapfile -t files < <(
    {
      git diff --name-only origin/main...HEAD -- '_DOCS/_handover/*.md'
      git ls-files --others --exclude-standard -- '_DOCS/_handover/*.md'
      if [[ -n $(git diff --name-only origin/main...HEAD -- _DOCS/HANDOVER-RULES.md) ]]; then
        newest=$(ls -1 _DOCS/_handover/*.md | sort | tail -n 1)
        if [[ -n $newest ]]; then
          echo "note: rules layer changed; validating newest handover $newest" >&2
          echo "$newest"
        fi
      fi
    } | sort -u
  )
fi

if (( ${#files[@]} == 0 )); then
  echo "FAIL: no handover files to check (nothing under _DOCS/_handover/ differs from origin/main)"
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
  echo "FAIL: a handover document does not conform"
  exit 1
fi

# HANDOVER-RULES rule 47: the authoring session drains. Merged branches on
# origin or in a lane clone, a stash, a dirty clone, or a registered worktree
# fail the handover PR here, on the Development machine that verifies it.
DRAINED=/Volumes/ThunderBolt/Development/_ob/skills/handover-author/scripts/check-drained.sh
if [[ ! -f $DRAINED ]]; then
  echo "FAIL: drain check not found at $DRAINED"
  exit 1
fi
if ! /opt/homebrew/bin/bash "$DRAINED" .; then
  echo "FAIL: the repo is not drained (rule 47)"
  exit 1
fi
echo "PASS: ${#files[@]} handover document(s) conform and the repo is drained"
