#!/opt/homebrew/bin/bash
# install.sh -- point this repo's core.hooksPath at the tracked _githooks/
# directory, so the hook git runs IS the hook under review.
#
# THE TRAP THIS EXISTS TO CATCH
#
# The half-landed state (#311) was tracked hooks in a folder git never read:
# the reviewable pre-push lived in .githooks/ while core.hooksPath still pointed
# at untracked .git/hooks. Copying a file into .git/hooks is the wrong fix --
# that installs an unreviewable copy that silently diverges from the tracked
# one. The tracked directory must BE the hooks directory, which is exactly what
# core.hooksPath is for. So this installer sets one config value and copies
# nothing.
#
# Idempotent: setting core.hooksPath to the value it already holds is a no-op,
# and the script reports which case it hit rather than assuming.

set -uo pipefail

# Resolve to a repo-root-relative value, not an absolute one: an absolute path
# is a clone-specific string that would be wrong in every other checkout, and
# core.hooksPath is per-repo config that only this clone reads anyway.
repo_root="$(git rev-parse --show-toplevel)"
target="_githooks"

if [[ ! -d "$repo_root/$target" ]]; then
  printf 'install.sh: %s/ does not exist -- run from the repo it belongs to.\n' "$target"
  exit 1
fi

current="$(git -C "$repo_root" config --local --get core.hooksPath || true)"

if [[ "$current" == "$target" ]]; then
  printf 'core.hooksPath already set to %s -- nothing to do.\n' "$target"
else
  git -C "$repo_root" config --local core.hooksPath "$target"
  if [[ -n "$current" ]]; then
    printf 'core.hooksPath changed: %s -> %s\n' "$current" "$target"
    # Name the specific damage when the value we just corrected was ABSOLUTE
    # (issue #711). This clone held /Volumes/.../open-brain/_githooks for long
    # enough that a family of lane failures (#705-#714) traced back to it, and
    # the reason it survived is that a corrected value looks the same in the
    # output whether it was a harmless typo or this. .git/config is SHARED by
    # every linked worktree, so an absolute value silently makes every lane
    # worktree run the primary checkout's hooks -- a lane fixing a hook cannot
    # exercise its own fix, and a lane breaking one pushes green.
    if [[ "$current" == /* ]]; then
      printf '\n'
      printf 'NOTE: the previous value was an ABSOLUTE path.\n'
      printf '  .git/config is shared by every linked worktree, so that value made\n'
      printf '  EVERY worktree run the hooks in:\n'
      printf '      %s\n' "$current"
      printf '  instead of its own. If lanes in worktrees have been passing or failing\n'
      printf '  pre-push for reasons that did not match their own diff, that is why.\n'
      printf '  (issue #711)\n'
    fi
  else
    printf 'core.hooksPath set to %s\n' "$target"
  fi
fi

printf '\nHooks git will now run from %s/:\n' "$target"
for hook in "$repo_root/$target"/*; do
  name="${hook##*/}"
  [[ "$name" == "install.sh" ]] && continue
  if [[ -x "$hook" ]]; then
    printf '  %s\n' "$name"
  else
    printf '  %s (NOT executable -- git will skip it; chmod +x it)\n' "$name"
  fi
done
