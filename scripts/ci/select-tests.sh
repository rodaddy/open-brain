#!/usr/bin/env bash
# Pick which tests a CI run needs (Rico ask 2026-10-06: a simple change must
# not run the whole suite).
#
# Usage: scripts/ci/select-tests.sh <event_name> <base_sha> [<head_sha>]
# Needs: full git history (fetch-depth 0) and, for a TS selection, npm ci done.
# Writes to $GITHUB_OUTPUT (or stdout when unset):
#   mode=full|changed|none   vitest: whole suite, the listed files, or nothing
#   files=<space-separated test files>   only when mode=changed
#   python=true|false        run the openbrain-memory pytest suite
# SELECT_PYTHON_ONLY=1 skips the vitest listing (mode=unknown) for jobs that
# only need the python flag.
#
# Rules: anything but a pull_request runs the full suite. On a PR, the full
# suite runs when a lockfile, manifest, tool config, test helper/fixture, CI
# file or DB migration changed, or when code changed but vitest's module graph
# (`vitest list --changed <base>`) maps it to zero test files. Docs-only PRs
# run no tests.
set -euo pipefail

event="${1:?event name}"
base="${2:-}"
head="${3:-HEAD}"
out="${GITHUB_OUTPUT:-/dev/stdout}"

emit() { printf '%s\n' "$@" >> "$out"; }

if [ "$event" != "pull_request" ] || [ -z "$base" ]; then
  emit "mode=full" "python=true"
  echo "select-tests: $event -> full suite" >&2
  exit 0
fi

changed="$(git diff --name-only "$base"..."$head")"
echo "select-tests: changed files:" >&2
printf '  %s\n' $changed >&2

full_re='(^|/)(package\.json|package-lock\.json|npm-shrinkwrap\.json|bun\.lockb?|uv\.lock|pyproject\.toml|go\.mod|go\.sum|Cargo\.toml|Cargo\.lock|tsconfig[^/]*\.json|vitest[^/]*\.config\.[cm]?[jt]s|vite\.config\.[cm]?[jt]s|\.oxlintrc\.json|biome\.jsonc?|\.eslintrc[^/]*|eslint\.config\.[cm]?[jt]s|pytest\.ini|conftest\.py|setup\.cfg|tox\.ini)$|(^|/)(fixtures|__fixtures__|testing|helpers|support)/|test-helpers?\.ts$|^\.forgejo/|^\.github/workflows/|^\.gitea/workflows/|^scripts/ci/|^scripts/assert-db-tests-ran\.ts$|(^|/)migrations/|\.sql$'
docs_re='(\.md$|^docs/|^_DOCS/|^_plans/|^reports/|^specs/)'

if printf '%s\n' "$changed" | grep -Eq "$full_re"; then
  echo "select-tests: full-suite trigger matched:" >&2
  printf '%s\n' "$changed" | grep -E "$full_re" | sed 's/^/  /' >&2
  emit "mode=full" "python=true"
  exit 0
fi

code="$(printf '%s\n' "$changed" | grep -Ev "$docs_re" || true)"
python=false
if printf '%s\n' "$code" | grep -Eq '^python/openbrain-memory/'; then python=true; fi

# Code outside python/ is what the vitest suite covers.
ts_code="$(printf '%s\n' "$code" | grep -Ev '^python/' || true)"
if [ -z "$ts_code" ]; then
  echo "select-tests: no TS/JS-side code changed -> vitest skipped (python=$python)" >&2
  emit "mode=none" "python=$python"
  exit 0
fi

# The python-package job has no node_modules; it only needs the python flag.
if [ "${SELECT_PYTHON_ONLY:-}" = "1" ]; then
  emit "mode=unknown" "python=$python"
  exit 0
fi

files="$(nodenode_modules/vitest/vitest.mjs list --changed "$base" --filesOnly 2>/dev/null \
  | sed "s#^$(pwd)/##" | sort -u | tr '\n' ' ' | sed 's/ *$//')"
if [ -z "$files" ]; then
  echo "select-tests: code changed but no test maps to it -> full suite (fail safe)" >&2
  emit "mode=full" "python=true"
  exit 0
fi

echo "select-tests: affected test files: $files" >&2
emit "mode=changed" "files=$files" "python=$python"
