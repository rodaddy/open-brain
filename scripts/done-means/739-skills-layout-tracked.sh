#!/opt/homebrew/bin/bash
# DONE-MEANS check for PR #739 (dev#264): the shared project-skills layout is
# tracked, so `.agents/skills/` stops showing as untracked on every branch.
#
#   bash scripts/done-means/739-skills-layout-tracked.sh
#
# `.agents/skills/` is the one real directory every harness reads; the
# `.claude/skills` symlink is ignored by .gitignore (`.claude/*`) and is NOT
# expected in the index. GREEN when `.agents/skills/.gitkeep` is in the index.
#
# Exit grammar: 0 pass, 1 the layout is untracked, 3 harness error.
set -u
cd "$(git rev-parse --show-toplevel)" || exit 3
if git ls-files --error-unmatch .agents/skills/.gitkeep >/dev/null 2>&1; then
  echo "PASS: .agents/skills/.gitkeep is tracked"; exit 0
fi
echo "FAIL: .agents/skills/.gitkeep is not in the index; the skills layout is untracked"; exit 1
