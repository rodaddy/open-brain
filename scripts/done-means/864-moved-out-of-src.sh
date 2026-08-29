#!/opt/homebrew/bin/bash
# DONE-MEANS check for issue 864 -- each named src/ path has left src/.
#
#   bash scripts/done-means/864-moved-out-of-src.sh src/chunk-write.ts [more...]
#
# Three clauses per path, all must pass:
#   A  the old path has left src/. Either `git ls-files -- <path>` prints
#      nothing, or the tracked file is a SHIM (rule M2): every code line is an
#      `export` re-export naming a `server/` path, and nothing else survives
#      comment stripping. A shim holds no logic, so the module has moved even
#      though the path is still tracked; shims retire with src/ at L6.
#   B  <path> is absent from `bun scripts/src-runtime-closure.ts` output, or
#      it is a shim by the same test as clause A. A shim re-exports at runtime
#      so it stays reachable; what left src/ is the implementation, and the
#      closure number a lane reports counts shims as already gone.
#   C  no TypeScript importer still names the old module. Matches every quoted
#      specifier ending in the basename, and fails on any whose specifier does
#      NOT contain `server/` -- a src/ importer must now say `../server/...`,
#      and a server/ importer says `./` or `../` from inside server/. Every
#      offending line is printed. Skipped when the old path is a shim: rule M2
#      leaves those importers' lines untouched on purpose, and the shim is
#      what makes them correct.
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

# A shim (rule M2) holds no implementation: after comment lines and blank
# lines are stripped, every surviving line is an `export` re-export whose
# quoted specifier names a `server/` path. Returns 0 when the file is a shim.
is_shim() {
  SHIM_PATH="$1"
  [ -f "$SHIM_PATH" ] || return 1
  SHIM_CODE="$(rg -v '^[[:space:]]*(//|/\*|\*|$)' "$SHIM_PATH" || true)"
  [ -n "$SHIM_CODE" ] || return 1
  NON_EXPORT="$(printf '%s\n' "$SHIM_CODE" | rg -v '^[[:space:]]*export .*["'"'"'][^"'"'"']*server/[^"'"'"']*["'"'"']' || true)"
  [ -z "$NON_EXPORT" ]
}

FAILED=0
for TARGET in "$@"; do
  BASE="$(basename "$TARGET" .ts)"

  IS_SHIM=no
  is_shim "$TARGET" && IS_SHIM=yes

  TRACKED="$(git ls-files -- "$TARGET" || true)"
  if [ -n "$TRACKED" ] && [ "$IS_SHIM" = no ]; then
    printf 'FAIL A %s\n' "$TARGET"
    FAILED=1
  fi

  if printf '%s\n' "$CLOSURE" | rg -qx -- "$TARGET" && [ "$IS_SHIM" = no ]; then
    printf 'FAIL B %s\n' "$TARGET"
    FAILED=1
  fi

  # When the old path is a shim, importers legitimately still name it (rule
  # M2 leaves their import lines untouched), so clause C is satisfied by the
  # shim itself and only the no-shim case is judged.
  STALE=""
  if [ "$IS_SHIM" = no ]; then
    STALE="$(rg -n "['\"][^'\"]*/${BASE}['\"]" --type ts | rg -v 'server/' || true)"
  fi
  if [ -n "$STALE" ]; then
    printf 'FAIL C %s\n' "$TARGET"
    printf '%s\n' "$STALE"
    FAILED=1
  fi
done

[ "$FAILED" -eq 0 ] || exit 1
printf 'PASS\n'
exit 0
