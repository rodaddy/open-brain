#!/usr/bin/env bash
# SUPERSEDED — the hook installer is `_githooks/install.sh` (issue #711).
#
# This file used to run:
#
#     git config core.hooksPath .githooks
#
# `.githooks/` DOES NOT EXIST in this repo; the tracked hooks live in
# `_githooks/`. Pointing core.hooksPath at a directory that is not there does
# not fail loudly — git simply finds no hooks and every tracked hook silently
# stops running. That is the exact #311 half-landed state the `_githooks/`
# installer was written to end, left behind here as a one-line command that
# reintroduces it.
#
# It also wrote the value WITHOUT `--local` and without resolving a repo root,
# so what it configured depended on the caller's cwd.
#
# This is a redirecting stub rather than a deletion because the path is
# referenced by name in docs/standards/REPO_BOOTSTRAP.md and may be in a runbook
# or in muscle memory; a stub that says where to go is more useful than a "no
# such file" error. It REFUSES rather than silently forwarding to the real
# installer, because a script that quietly does something other than what its
# name says is how the original divergence went unnoticed.
set -uo pipefail

printf 'scripts/install-hooks.sh is SUPERSEDED and does nothing.\n\n'
printf 'It pointed core.hooksPath at .githooks/, which does not exist in this\n'
printf 'repo -- that silently disables every tracked hook. The tracked hooks are\n'
printf 'in _githooks/, and its installer sets the correct RELATIVE value so each\n'
printf 'worktree resolves its own copy.\n\n'
printf 'Run this instead, from the repo root:\n'
printf '    ./_githooks/install.sh\n\n'
printf '(issue #711)\n'
exit 1
