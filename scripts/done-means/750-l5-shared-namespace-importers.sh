#!/usr/bin/env bash
# DONE-MEANS check for rung L5 of the server/ hardening ladder
# (`_plans/server-hardening-ladder.md`, issue #864).
#
#   bash scripts/done-means/750-l5-shared-namespace-importers.sh
#
# ---------------------------------------------------------------------------
# The defect this gates
# ---------------------------------------------------------------------------
# `src/shared-namespace.ts` reads the environment to decide what the shared
# namespace is called. Every server/tools module that imports from it therefore
# re-derives those names on its own, at whatever moment its call happens to
# run, from whatever the environment says then. Two modules can disagree about
# which physical namespace a write lands in, and nothing errors when they do —
# the row simply goes somewhere else.
#
# The server twin `server/tools/shared-namespace.ts` closes that by taking the
# names as an argument. It throws when the argument is absent, so the migration
# cannot half-land silently: a call site that forgets to thread the names fails
# loudly at runtime instead of quietly re-deriving them.
#
# L5 is complete for a module when both halves hold — it no longer imports the
# environment-reading `src/` copy, AND every call it makes to the twin actually
# passes the names it was handed by the composition root.
#
# ---------------------------------------------------------------------------
# GENERIC BY DESIGN — NO ARGUMENTS
# ---------------------------------------------------------------------------
# This check takes no argv. It discovers its own subject: the non-test files
# under server/tools changed against the MERGE BASE of origin/main and HEAD.
# Diffing against the moving tip of origin/main instead would drag in files
# that other branches changed after this one was cut, and judge them as if
# this lane had touched them. The merge base is the branch's own diff.
#
# Two files are always excluded from the subject, however they arrive:
# `server/tools/shared-namespace.ts`, which DEFINES the six helpers rather
# than calling them, and anything matching `*-fixture.ts`. Neither is a
# migration subject, and both fail clause 2 by construction.
#
# Self-discovery is what makes this check usable
# by the sibling lanes on this rung without editing it — each lane changes a
# different pair of modules, and each gets its own subject list for free.
#
# `CHANGED_FILES` (space-separated) overrides the discovery, which is how the
# RED receipt is taken before any edit exists to be discovered.
#
# ---------------------------------------------------------------------------
# Three clauses, and all three must pass
# ---------------------------------------------------------------------------
# CLAUSE 1 — NO MODULE IN THE SUBJECT IMPORTS THE src/ COPY.
#   Zero references to `src/shared-namespace` in each subject file. That import
#   is the environment read; while it is present the module can still reach the
#   old names regardless of what it was handed.
#
# CLAUSE 2 — EVERY CALL PASSES THE NAMES (arrival, not departure).
#   Clause 1 alone is satisfiable by deleting the calls, which is worse than
#   the defect. So clause 2 counts ARRIVALS: for each of the six helpers, the
#   number of call sites in the file must equal the number of call sites whose
#   argument list carries the names.
#
#   The scan window starts at the CALL LINE ITSELF and runs to the third line
#   after it. Prettier wraps a two-argument call across lines, so the argument
#   often sits below the call — but just as often it does not, and a window
#   that began one line late read `sharedNamespaceConfig(dependencies.shared\
#   NamespaceNames)` on a single line as a call carrying nothing.
#
#   An argument counts as arrival when it is `sharedNamespaceNames` OR the
#   bare identifier `names`. A module that derives the config once at its
#   composition root and threads it inward as a local parameter has done
#   exactly what this rung asks for; insisting on the outer spelling at every
#   inner call would read correct threading as a miss and push callers toward
#   re-deriving the names per call, which is the defect itself.
#
#   A file with ZERO helper call sites PASSES: a type-only importer (`import
#   type { SharedNamespaceConfig }`) has no calls to thread and is not
#   evidence of a failed migration. The guard against a silent pass lives at
#   the SUBJECT level — an empty subject list is exit 1 — not per file, so a
#   check that examines nothing still cannot report success.
#
# CLAUSE 3 — THE TREE TYPECHECKS.
#   `bunx tsc --noEmit` exits 0. The twin's trailing argument is typed, so a
#   call threading the wrong shape is caught here rather than at runtime.
#
# An EMPTY subject list is exit 1 with a message, never a silent pass: a check
# that examines nothing and reports success is the failure mode this whole
# family of scripts exists to avoid.
#
# NO ARGUMENTS.
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

fail_hard() {
  printf 'HARNESS-ERROR: %s\n' "$1" >&2
  exit 3
}

command -v rg >/dev/null 2>&1 || fail_hard "rg (ripgrep) not on PATH"
command -v git >/dev/null 2>&1 || fail_hard "git not on PATH"
[ -d "$REPO_ROOT/.git" ] || [ -f "$REPO_ROOT/.git" ] || fail_hard "not a git repo at $REPO_ROOT"

HELPERS='canonicalNamespace|physicalNamespace|sharedNamespaceConfig|isSharedNamespace|isLegacySharedNamespace|shouldRejectLegacySharedWrite'
NAMES_ARG='sharedNamespaceNames'

# ---------------------------------------------------------------------------
# SUBJECT — the non-test server/tools files changed against origin/main.
# ---------------------------------------------------------------------------
if [ -n "${CHANGED_FILES:-}" ]; then
  SUBJECT="$(printf '%s\n' $CHANGED_FILES)"
  SUBJECT_SOURCE="CHANGED_FILES override"
else
  MERGE_BASE="$(cd "$REPO_ROOT" && git merge-base origin/main HEAD 2>/dev/null)"
  [ -n "$MERGE_BASE" ] || fail_hard "git merge-base origin/main HEAD produced nothing"
  SUBJECT="$(cd "$REPO_ROOT" && git diff --name-only "$MERGE_BASE" -- server/tools 2>/dev/null | rg -v '\.test\.ts$')"
  SUBJECT_SOURCE="git diff --name-only \$(git merge-base origin/main HEAD) -- server/tools (non-test)"
fi
SUBJECT="$(printf '%s\n' "$SUBJECT" | rg -v '^$' || true)"
# The twin DEFINES the helpers; a fixture is test scaffolding. Neither is ever
# a subject, whether discovery or CHANGED_FILES put it there.
SUBJECT="$(printf '%s\n' "$SUBJECT" \
  | rg -v '^server/tools/shared-namespace\.ts$' \
  | rg -v -- '-fixture\.ts$' || true)"

if [ -z "$SUBJECT" ]; then
  printf 'SUBJECT: none — %s produced no files.\n' "$SUBJECT_SOURCE" >&2
  printf 'A check with nothing to examine is not a pass. Exiting 1.\n' >&2
  exit 1
fi

SUBJECT_N="$(printf '%s\n' "$SUBJECT" | rg -c '^')"
printf 'SUBJECT (%s file(s), from %s):\n' "$SUBJECT_N" "$SUBJECT_SOURCE"
printf '%s\n' "$SUBJECT" | sed 's/^/    /'
printf '\n'

CLAUSE1=PASS
CLAUSE2=PASS

# ---------------------------------------------------------------------------
# CLAUSE 1 — no src/shared-namespace import survives in any subject file.
# CLAUSE 2 — helper calls and names-carrying calls arrive at the same count.
# ---------------------------------------------------------------------------
while IFS= read -r FILE; do
  [ -n "$FILE" ] || continue
  if [ ! -f "$REPO_ROOT/$FILE" ]; then
    printf 'CLAUSE 1 [%s]: FAIL — file does not exist\n' "$FILE"
    CLAUSE1=FAIL
    continue
  fi

  SRC_HITS="$(cd "$REPO_ROOT" && rg -nF 'src/shared-namespace' "$FILE" 2>/dev/null)"
  RG_STATUS=$?
  [ "$RG_STATUS" -ge 2 ] && fail_hard "rg failed with status $RG_STATUS scanning $FILE"
  if [ -n "$SRC_HITS" ]; then
    printf 'CLAUSE 1 [%s]: FAIL — still imports the environment-reading src/ copy:\n' "$FILE"
    printf '%s\n' "$SRC_HITS" | sed 's/^/    /'
    CLAUSE1=FAIL
  else
    printf 'CLAUSE 1 [%s]: PASS — 0 references to src/shared-namespace\n' "$FILE"
  fi

  # Departures: every call to one of the six helpers. The `\(` anchors on the
  # call rather than the import line, which carries no parenthesis.
  CALL_N="$(cd "$REPO_ROOT" && rg -c "\\b($HELPERS)\\(" "$FILE" 2>/dev/null)"
  CALL_N="${CALL_N:-0}"
  # Arrivals: calls carrying the names on the call line itself or within the
  # 3 lines after it. `-A3` includes the matched line, so the window starts at
  # the call. Either the outer `sharedNamespaceNames` or the local alias
  # `names` a module threads inward counts.
  ARRIVE_N="$(cd "$REPO_ROOT" && rg -A3 "\\b($HELPERS)\\(" "$FILE" 2>/dev/null \
    | rg -c "\\b($NAMES_ARG|names)\\b" 2>/dev/null)"
  ARRIVE_N="${ARRIVE_N:-0}"

  if [ "$CALL_N" -eq 0 ]; then
    printf 'CLAUSE 2 [%s]: PASS — 0 helper call sites (type-only importer)\n' "$FILE"
  elif [ "$CALL_N" -ne "$ARRIVE_N" ]; then
    printf 'CLAUSE 2 [%s]: FAIL — %s helper call(s), %s carrying %s\n' \
      "$FILE" "$CALL_N" "$ARRIVE_N" "$NAMES_ARG"
    (cd "$REPO_ROOT" && rg -n -A3 "\\b($HELPERS)\\(" "$FILE" 2>/dev/null) | sed 's/^/    /'
    CLAUSE2=FAIL
  else
    printf 'CLAUSE 2 [%s]: PASS — %s helper call(s), all %s carrying %s\n' \
      "$FILE" "$CALL_N" "$ARRIVE_N" "$NAMES_ARG"
  fi
done <<EOF
$SUBJECT
EOF

# ---------------------------------------------------------------------------
# CLAUSE 3 — the tree typechecks.
# ---------------------------------------------------------------------------
CLAUSE3=FAIL
if ! command -v bunx >/dev/null 2>&1; then
  fail_hard "bunx not on PATH; clause 3 cannot be judged"
fi
TSC_OUT="$(cd "$REPO_ROOT" && bunx tsc --noEmit 2>&1)"
TSC_STATUS=$?
if [ "$TSC_STATUS" -eq 0 ]; then
  CLAUSE3=PASS
  printf '\nCLAUSE 3 (bunx tsc --noEmit): PASS — exited 0\n'
else
  printf '\nCLAUSE 3 (bunx tsc --noEmit): FAIL — exited %s\n' "$TSC_STATUS"
  printf '%s\n' "$TSC_OUT" | tail -n 12 | sed 's/^/    /'
fi

printf '\nCLAUSE 1 (no src/shared-namespace import):        %s\n' "$CLAUSE1"
printf 'CLAUSE 2 (every helper call carries the names):   %s\n' "$CLAUSE2"
printf 'CLAUSE 3 (bunx tsc --noEmit exits 0):            %s\n' "$CLAUSE3"

if [ "$CLAUSE1" = PASS ] && [ "$CLAUSE2" = PASS ] && [ "$CLAUSE3" = PASS ]; then
  exit 0
fi
exit 1
