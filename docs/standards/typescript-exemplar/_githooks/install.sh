#!/usr/bin/env bash
# install.sh -- install these hooks into .git/hooks, and REFUSE if something
# would stop them firing.
#
# THE TRAP THIS EXISTS TO CATCH
#
# `git config core.hooksPath` overrides .git/hooks entirely. If a global
# hooksPath is set -- and it commonly is, for org-wide secret scanning -- then
# copying files into .git/hooks installs nothing. Git reports no error. Every
# commit passes. That is exactly what happened in one of the repos this standard
# came from: tracked hooks that never fired even once, and no commit-msg hook
# existed at all.
#
# So this script checks first and refuses rather than producing a silent no-op.
# An installer that cannot install must say so.

set -uo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(git -C "$here" rev-parse --show-toplevel 2>/dev/null)"

if [[ -z "$repo_root" ]]; then
  printf 'install.sh: not inside a git repository.\n'
  printf '  This tree has no .git/ of its own -- it is a reference exemplar.\n'
  printf '  To see the hooks actually block, run:  ./scripts/dev/demo-hooks.sh\n'
  exit 1
fi

git_dir="$(git -C "$repo_root" rev-parse --git-dir)"
[[ "$git_dir" = /* ]] || git_dir="$repo_root/$git_dir"
mkdir -p "$git_dir/hooks"   # must exist before the hooksPath comparison below

# --- the hooksPath check, before touching anything ------------------------
#
# Only a hooksPath pointing AWAY from this repo's own hooks dir is a problem.
# Some setups legitimately point it AT .git/hooks; refusing on any value at all
# would make the installer unusable for them and, worse, train people to skip it.
hooks_path="$(git -C "$repo_root" config --get core.hooksPath || true)"
if [[ -n "$hooks_path" ]]; then
  # Resolve both sides before comparing: one may be relative to the repo root.
  abs_hooks_path="$hooks_path"
  [[ "$abs_hooks_path" = /* ]] || abs_hooks_path="$repo_root/$abs_hooks_path"
  if [[ "$(cd "$abs_hooks_path" 2>/dev/null && pwd)" == "$(cd "$git_dir/hooks" 2>/dev/null && pwd)" ]]; then
    hooks_path=""   # points at our own hooks dir; harmless
  fi
fi
if [[ -n "$hooks_path" ]]; then
  printf '\nREFUSING TO INSTALL: core.hooksPath is set to:\n'
  printf '    %s\n\n' "$hooks_path"
  printf '  Git reads hooks from THERE, not from .git/hooks, so copying files\n'
  printf '  into .git/hooks would install nothing and every commit would pass\n'
  printf '  while looking enforced.\n\n'
  printf '  Pick one:\n'
  printf '    1. Install into that path instead:\n'
  printf '         cp %s/{pre-commit,commit-msg,pre-push,post-merge} %s/\n' "$here" "$hooks_path"
  printf '    2. Unset it for this repo so .git/hooks wins:\n'
  printf '         git -C %s config --unset core.hooksPath\n\n' "$repo_root"
  printf '  Option 2 is repo-local and does not affect your global config.\n\n'
  exit 1
fi

target="$git_dir/hooks"
mkdir -p "$target"

installed=0
for hook in pre-commit commit-msg pre-push post-merge; do
  src="$here/$hook"
  [[ -f "$src" ]] || { printf '  MISSING SOURCE: %s\n' "$src"; exit 1; }

  if [[ -e "$target/$hook" && ! -L "$target/$hook" ]]; then
    if ! cmp -s "$src" "$target/$hook"; then
      backup="$target/$hook.replaced-$(date +%Y%m%d%H%M%S)"
      cp "$target/$hook" "$backup"
      printf '  existing %-12s backed up to %s\n' "$hook" "${backup##*/}"
    fi
  fi

  cp "$src" "$target/$hook"
  chmod +x "$target/$hook"
  printf '  installed %s\n' "$hook"
  installed=$((installed + 1))
done

printf '\n%d hooks installed into %s\n' "$installed" "$target"
printf 'Verify they actually block -- installed is not the same as working:\n'
printf '    ./scripts/dev/demo-hooks.sh\n\n'
