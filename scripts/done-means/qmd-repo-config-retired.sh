#!/usr/bin/env bash
# DONE-MEANS check: this repo carries no tracked .qmd/ config and ignores the
# directory, because the qmd index is ONE STORE, the Development catalogue
# (/Volumes/ThunderBolt/Development/.qmd/index.yml; Rico ruling 2026-08-28,
# _ob/bin/aqmd "ONE STORE"). A stray repo-local .qmd/index.yml re-scopes aqmd
# to an empty config, so nothing under .qmd/ may be tracked here.
#
#   bash scripts/done-means/qmd-repo-config-retired.sh
#
# Exit 0: `git ls-files .qmd` is empty and .gitignore has a `.qmd/` line.
# Exit 1: either condition fails. Exit 3: harness error.
set -u
cd "$(dirname "$0")/../.." || exit 3
git rev-parse --is-inside-work-tree >/dev/null 2>&1 || { echo "HARNESS ERROR: not a checkout"; exit 3; }
tracked=$(git ls-files .qmd)
fail=0
if [ -n "$tracked" ]; then echo "FAIL: tracked under .qmd/:"; printf '%s\n' "$tracked"; fail=1; else echo "ok   nothing tracked under .qmd/"; fi
if rg -q '^\.qmd/$' .gitignore; then echo "ok   .gitignore ignores .qmd/"; else echo "FAIL: .gitignore has no '.qmd/' line"; fail=1; fi
[ "$fail" -eq 0 ] && echo "PASS: repo-local qmd config retired" && exit 0
echo "FAIL: repo-local qmd config still present"
exit 1
