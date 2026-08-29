#!/opt/homebrew/bin/bash
# DONE-MEANS check for issue 864 -- each named src/ path has left src/.
#
#   bash scripts/done-means/864-moved-out-of-src.sh src/chunk-write.ts [more...]
#   bash scripts/done-means/864-moved-out-of-src.sh
#
# With no arguments the paths to judge are discovered from the tree itself:
# every tracked `src/*.ts` file that is an L5 shim by the re-export test, plus
# every one whose first line DECLARES the L5 header. A file that claims the
# header but names a non-server/ relative specifier is therefore judged and
# fails clause A out loud, rather than being dropped from the set in silence.
# Discovery makes the check meaningful when the PR-body validator hands the
# whole Done-means line over as a single path with nothing after it.
# The count prints as `judged=<n> shims` when no adapter was found, and as
# `judged=<n> shims, <m> adapters` when at least one was; zero of both prints
# `judged=0 shims` and exits 0 rather than passing in silence.
#
# Three clauses per path, all must pass:
#   A  the old path has left src/. Either `git ls-files -- <path>` prints
#      nothing, or the tracked file is a SHIM (rule M2): every code line is an
#      `export` re-export naming a `server/` path, and nothing else survives
#      comment stripping. A shim holds no logic, so the module has moved even
#      though the path is still tracked; shims retire with src/ at L6.
#      An ADAPTER (rule M9) is accepted the same way: its first line matches
#      `^// L5 (shim|adapter) \(issue 864\)` AND every relative import or
#      export specifier it names -- `from "./..."`, `from "../..."`,
#      `import("../...")` -- resolves under a `server/` path. An adapter keeps
#      a legacy call form the server/ version cannot, so it holds its own
#      code; what makes it accepted is that every relative dependency it has
#      is already under server/. Node and npm specifiers are not relative and
#      are not judged. Any relative specifier NOT naming server/ fails A and
#      the offending line is printed.
#   B  <path> is absent from `bun scripts/src-runtime-closure.ts` output, or
#      it is a shim or an adapter by the same test as clause A. A shim
#      re-exports at runtime so it stays reachable, and an adapter keeps a
#      legacy call form over code that has moved; what left src/ is the
#      implementation, and the closure number a lane reports counts both as
#      already gone.
#   C  no TypeScript importer still names the old module. Matches every quoted
#      specifier ending in the basename, and fails on any whose specifier does
#      NOT contain `server/` -- a src/ importer must now say `../server/...`,
#      and a server/ importer says `./` or `../` from inside server/. Every
#      offending line is printed. Skipped when the old path is a shim or an
#      adapter: rule M2 and rule M9 leave those importers' lines untouched on
#      purpose, and the shim or adapter is what makes them correct.
#
# Exit 0: every clause passes for every path.
# Exit 1: any clause fails; each failure printed as `FAIL <clause> <path>`.
# Exit 3: harness error -- bun or rg missing, or not in a git tree.
#
# Receipts, all run from this checkout on branch chore/864-l5-adapter-clause:
#   RED    `bash scripts/done-means/864-moved-out-of-src.sh src/embedding.ts`
#          -> `FAIL A src/embedding.ts` / `FAIL B src/embedding.ts`, exit 1.
#          src/embedding.ts is still a tracked implementation, not a shim.
#   GREEN  `bash scripts/done-means/864-moved-out-of-src.sh`
#          -> `judged=19 shims` / `PASS`, exit 0. The 19 shims already on main
#          are unaffected by the adapter clause: none carries the M9 header
#          and all 19 stay accepted by the re-export test.
#   PROBE  an untracked `src/l5-adapter-probe.ts` carrying the M9 header line,
#          `import { x } from "../server/config.ts"`-style lines and one
#          `export function legacy() {}`, `git add`ed so discovery sees it,
#          then the no-argument run -> `judged=19 shims, 1 adapters` / `PASS`,
#          exit 0. Discovery finds the adapter and clause A accepts it.
#   PROBE  the same file with its second import rewritten to
#          `from "./logger.ts"` -> `judged=19 shims, 1 adapters`,
#          `FAIL A src/l5-adapter-probe.ts`, the offending line
#          `3:import { z } from "./logger.ts";`, exit 1. A relative specifier
#          that does not name server/ is what the clause exists to reject, and
#          discovery keeps the file in the judged set so the failure is loud.
#          Both probes were unstaged with `git restore --staged` and moved out
#          of the tree afterwards.
set -u

cd "$(dirname "$0")/../.." || exit 3
git rev-parse --is-inside-work-tree >/dev/null 2>&1 || {
  printf 'HARNESS-ERROR: not run from a checkout\n' >&2
  exit 3
}
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

# An adapter (rule M9) keeps a legacy call form the server/ version cannot, so
# unlike a shim it holds its own code. What makes it accepted is dependency
# direction: its first line declares it, and every RELATIVE specifier it names
# resolves under server/. Node and npm specifiers are absolute names, not
# relative, and are not judged. Prints nothing; use adapter_bad_specifiers for
# the offending lines. Returns 0 when the file is an adapter.
adapter_bad_specifiers() {
  rg -n '(from|import\()[[:space:]]*["'"'"']\.[^"'"'"']*["'"'"']' "$1" \
    | rg -v 'server/' || true
}

# Returns 0 when the file DECLARES itself an L5 shim or adapter on its first
# line. Discovery uses this rather than is_adapter so that a file claiming the
# header but naming a non-server/ relative specifier is judged and fails clause
# A out loud, instead of being dropped from the set in silence.
declares_l5_header() {
  [ -f "$1" ] || return 1
  head -n 1 "$1" | rg -q '^// L5 (shim|adapter) \(issue 864\)'
}

is_adapter() {
  ADAPTER_PATH="$1"
  declares_l5_header "$ADAPTER_PATH" || return 1
  [ -z "$(adapter_bad_specifiers "$ADAPTER_PATH")" ]
}

# With explicit arguments the caller names the paths. With none, discover
# every tracked src/*.ts that is a shim or an adapter and announce the judged
# counts. Adapters are only reported when at least one was found, so the
# established `judged=<n> shims` line is unchanged on a shim-only tree.
SHIM_COUNT=0
ADAPTER_COUNT=0
TARGETS=("$@")
if [ "${#TARGETS[@]}" -eq 0 ]; then
  TARGETS=()
  while IFS= read -r CANDIDATE; do
    [ -n "$CANDIDATE" ] || continue
    if is_shim "$CANDIDATE"; then
      TARGETS+=("$CANDIDATE")
      SHIM_COUNT=$((SHIM_COUNT + 1))
    elif declares_l5_header "$CANDIDATE"; then
      TARGETS+=("$CANDIDATE")
      ADAPTER_COUNT=$((ADAPTER_COUNT + 1))
    fi
  done < <(git ls-files -- 'src/*.ts')
  if [ "$ADAPTER_COUNT" -gt 0 ]; then
    printf 'judged=%d shims, %d adapters\n' "$SHIM_COUNT" "$ADAPTER_COUNT"
  else
    printf 'judged=%d shims\n' "$SHIM_COUNT"
  fi
fi


FAILED=0
for TARGET in ${TARGETS[@]+"${TARGETS[@]}"}; do
  BASE="$(basename "$TARGET" .ts)"

  IS_SHIM=no
  is_shim "$TARGET" && IS_SHIM=yes

  IS_ADAPTER=no
  [ "$IS_SHIM" = no ] && is_adapter "$TARGET" && IS_ADAPTER=yes

  TRACKED="$(git ls-files -- "$TARGET" || true)"
  if [ -n "$TRACKED" ] && [ "$IS_SHIM" = no ] && [ "$IS_ADAPTER" = no ]; then
    printf 'FAIL A %s\n' "$TARGET"
    if head -n 1 "$TARGET" 2>/dev/null | rg -q '^// L5 (shim|adapter) \(issue 864\)'; then
      adapter_bad_specifiers "$TARGET"
    fi
    FAILED=1
  fi

  if printf '%s\n' "$CLOSURE" | rg -qx -- "$TARGET" && [ "$IS_SHIM" = no ] && [ "$IS_ADAPTER" = no ]; then
    printf 'FAIL B %s\n' "$TARGET"
    FAILED=1
  fi

  # When the old path is a shim, importers legitimately still name it (rule
  # M2 leaves their import lines untouched), so clause C is satisfied by the
  # shim itself and only the no-shim case is judged.
  STALE=""
  if [ "$IS_SHIM" = no ] && [ "$IS_ADAPTER" = no ]; then
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
