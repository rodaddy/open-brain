#!/opt/homebrew/bin/bash
# DONE-MEANS check for issue 864 -- each named src/ path has left src/.
#
#   bash scripts/done-means/864-moved-out-of-src.sh src/chunk-write.ts [more...]
#
# Three clauses per path, all must pass:
#   A  `git ls-files -- <path>` prints nothing (the old path is untracked)
#   B  <path> is absent from `bun scripts/src-runtime-closure.ts` output
#   C  no TypeScript importer still names the old module. Matches every quoted
#      specifier ending in the basename, and fails on any whose specifier does
#      NOT contain `server/` -- a src/ importer must now say `../server/...`,
#      and a server/ importer says `./` or `../` from inside server/. Every
#      offending line is printed.
#
# Exit 0: every clause passes for every path.
# Exit 1: any clause fails; each failure printed as `FAIL <clause> <path>`.
# Exit 3: harness error -- no arguments, bun or rg missing, not in a git tree.
set -u

cd "$(dirname "$0")/../.." || exit 3
git rev-parse --is-inside-work-tree >/dev/null 2>&1 || {
  printf 'HARNESS-ERROR: not run from a checkout\n' >&2
  exit 3
}
[ "$#" -gt 0 ] || { printf 'HARNESS-ERROR: no paths given\n' >&2; exit 3; }
command -v bun >/dev/null 2>&1 || { printf 'HARNESS-ERROR: bun not on PATH\n' >&2; exit 3; }
command -v rg >/dev/null 2>&1 || { printf 'HARNESS-ERROR: rg not on PATH\n' >&2; exit 3; }

CLOSURE="$(bun scripts/src-runtime-closure.ts)" || {
  printf 'HARNESS-ERROR: src-runtime-closure.ts failed\n' >&2
  exit 3
}

FAILED=0
for TARGET in "$@"; do
  BASE="$(basename "$TARGET" .ts)"

  TRACKED="$(git ls-files -- "$TARGET" || true)"
  if [ -n "$TRACKED" ]; then
    printf 'FAIL A %s\n' "$TARGET"
    FAILED=1
  fi

  if printf '%s\n' "$CLOSURE" | rg -qx -- "$TARGET"; then
    printf 'FAIL B %s\n' "$TARGET"
    FAILED=1
  fi

  STALE="$(rg -n "['\"][^'\"]*/${BASE}['\"]" --type ts | rg -v 'server/' || true)"
  if [ -n "$STALE" ]; then
    printf 'FAIL C %s\n' "$TARGET"
    printf '%s\n' "$STALE"
    FAILED=1
  fi
done

[ "$FAILED" -eq 0 ] || exit 1
printf 'PASS\n'
exit 0
