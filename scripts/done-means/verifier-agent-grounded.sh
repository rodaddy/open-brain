#!/usr/bin/env bash
# DONE-MEANS check for ledger item 8 (docs/issue-graph.md, "Agent candidates")
# — the repo-local VERIFIER agent, first candidate to graduate to built.
#
#   bash scripts/done-means/verifier-agent-grounded.sh
#
# ---------------------------------------------------------------------------
# The defect this gates
# ---------------------------------------------------------------------------
# The verifier agent's design is deliberately unusual: it holds almost no
# knowledge of its own. Its BRAIN is three sets of files read fresh on every
# invocation (SME scope keys, the lane contract's Tightenings, the done-means
# toolbox), and its HANDS are deterministic scripts whose exit codes it reads.
# That design has exactly two ways to rot, and neither is visible by reading
# the agent's prose:
#
#   1. THE BRAIN POINTS AT NOTHING. A path named in the definition gets moved,
#      renamed, or was mistyped at authoring time. The agent still reads
#      confidently and correctly — it just reads an empty result, and a
#      verifier with no known-goods matrix classifies every change as "known"
#      because it has nothing to contradict it. Prose cannot detect this; only
#      resolving each referenced path against the real tree can.
#   2. THE FILE ISN'T THERE FOR ANYONE ELSE. `.gitignore:53` excludes
#      `.claude/*`, and that pattern nearly ate `.claude/agents/pr-scribe.md`
#      on the #615 lane (docs/lane-contract.md, 2026-08-08 Tightenings). An
#      agent definition that exists only in the authoring checkout protects
#      only the machine that wrote it, while every worktree, runner, and worker
#      — where verification actually happens — gets nothing. The negation
#      `!.claude/agents/` is what makes it survive; this check asserts the
#      OUTCOME (git tracks the file), not the presence of the pattern, because
#      a pattern can be present and still be overridden by a later rule.
#
# The remaining three clauses assert the three load-bearing sentences of the
# design survive future edits: the guardrail that keeps the agent from becoming
# enforcement, the loud-unknown instruction that is this design's only defense
# against its single failure mode (a forced wrong "this is a known class"), and
# the naming of all three brain sources.
#
# ---------------------------------------------------------------------------
# Five clauses
# ---------------------------------------------------------------------------
# CLAUSE 1 — COMMITTED, NOT JUST PRESENT.
#   .claude/agents/verifier.md exists AND `git ls-files` reports it as tracked.
#   Tracked is the real assertion: `test -e` passes in the authoring checkout
#   of a file that a fresh clone would never see. `git check-ignore` is run too
#   and its verdict reported, so a future .gitignore edit that re-ignores the
#   path is named in the output rather than inferred.
#
# CLAUSE 2 — GROUNDING: EVERY REFERENCED PATH RESOLVES.
#   Extract every repo-path-shaped token from the definition body and `test -e`
#   each one against the repo root. Zero unresolvable paths required. Also
#   requires the extraction to have found a non-trivial number of paths (>= 5),
#   because an extraction that silently matches nothing would pass vacuously —
#   the "0 items examined, exit 0" failure this repo has been burned by before.
#
# CLAUSE 3 — THE GUARDRAIL SENTENCE.
#   The literal string "never the enforcement" appears. This is the sentence
#   that keeps the agent a receipt-producer: agent produces, script judges,
#   hook enforces. An edit that softens it into "should not usually be the
#   enforcement" turns the boundary into a preference and this clause red.
#
# CLAUSE 4 — THE LOUD-UNKNOWN INSTRUCTION.
#   The distinctive phrase "NOVEL CLASS" appears in the definition (uppercase,
#   as the literal announcement string the agent is told to emit). The design's
#   one failure mode is a forced wrong "this is a known class"; the loud path
#   out is the only thing standing against it, and it must never be quietly
#   dropped in an edit that tightens the prose.
#
# CLAUSE 5 — ALL THREE BRAIN SOURCES NAMED BY REAL PATH.
#   docs/sme/entries/, docs/lane-contract.md, and scripts/done-means/ each
#   appear literally. Clause 2 proves whatever is named resolves; this clause
#   proves the three that MUST be named actually are. A verifier missing the
#   SME entries has no known-goods matrix; missing the contract has no
#   Tightenings; missing done-means has no hands.
#
# Exit 0 only when all five clauses pass. Exit 3 is a harness error (missing
# tool / unreadable repo), which is NOT a fail of the thing under test.
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
AGENT_REL=".claude/agents/verifier.md"
AGENT="$REPO_ROOT/$AGENT_REL"

fail_hard() {
  printf 'HARNESS-ERROR: %s\n' "$1" >&2
  exit 3
}

command -v git >/dev/null 2>&1 || fail_hard "git not on PATH"
command -v rg  >/dev/null 2>&1 || fail_hard "rg (ripgrep) not on PATH"
[ -d "$REPO_ROOT/.git" ] || [ -f "$REPO_ROOT/.git" ] || fail_hard "not a git repo at $REPO_ROOT"

CLAUSE1=FAIL; CLAUSE1_EVIDENCE=""
CLAUSE2=FAIL; CLAUSE2_EVIDENCE=""
CLAUSE3=FAIL; CLAUSE3_EVIDENCE=""
CLAUSE4=FAIL; CLAUSE4_EVIDENCE=""
CLAUSE5=FAIL; CLAUSE5_EVIDENCE=""

# ---------------------------------------------------------------------------
# CLAUSE 1 — exists and is tracked by git.
# ---------------------------------------------------------------------------
if [ ! -r "$AGENT" ]; then
  CLAUSE1_EVIDENCE="no agent definition at $AGENT_REL"
else
  TRACKED="$(git -C "$REPO_ROOT" ls-files -- "$AGENT_REL")"
  IGNORE_VERDICT="$(git -C "$REPO_ROOT" check-ignore -v -- "$AGENT_REL" 2>/dev/null)"
  if [ -n "$TRACKED" ]; then
    CLAUSE1=PASS
    CLAUSE1_EVIDENCE="$AGENT_REL present and git-tracked (visible in a fresh clone/worktree); check-ignore says: ${IGNORE_VERDICT:-not ignored}"
  else
    CLAUSE1_EVIDENCE="$AGENT_REL exists on disk but git does NOT track it — a fresh clone gets no verifier. check-ignore says: ${IGNORE_VERDICT:-not ignored (so it is merely unstaged)}"
  fi
fi

# ---------------------------------------------------------------------------
# CLAUSE 2 — every repo path the definition names actually exists.
# ---------------------------------------------------------------------------
# Extraction rule: a repo-path-shaped token is a run of path characters
# containing at least one "/", starting with a letter, dot, or underscore, and
# either ending in a known file extension or in a "/" (a directory reference).
# Anchored to the start of a path segment so prose like "input/output" and URLs
# are not swept in. Trailing punctuation from prose is stripped.
if [ ! -r "$AGENT" ]; then
  CLAUSE2_EVIDENCE="agent definition unreadable — nothing to ground"
else
  RAW_PATHS="$(
    rg -o -e '(?:^|[^A-Za-z0-9_/.-])([A-Za-z_.][A-Za-z0-9_.-]*(?:/[A-Za-z0-9_.*-]+)+/?)' \
       --replace '$1' --no-line-number --no-filename "$AGENT" 2>/dev/null \
    | sed -e 's/[.,;:)]*$//' \
    | rg -e '(\.(md|ts|sh|json|yml|yaml|py|sql)$|/$)' \
    | sort -u
  )"

  # Drop tokens that are plainly not repo paths (URLs, tool invocations).
  CANDIDATES="$(printf '%s\n' "$RAW_PATHS" | rg -v -e '^https?:' | rg -e '.' || true)"

  # CONDITIONAL FORWARD REFERENCES.
  # The definition may name a tool that does not exist YET, but only if it
  # guards the reference with an explicit presence condition — the verify-lane.ts
  # driver is the live case: it is a parallel lane's deliverable, and the agent
  # is told to prefer it "when present" and to fall back otherwise. That is a
  # correct instruction about an absent file, not a broken pointer, and failing
  # it would force the definition to either lie about the file existing or drop
  # a real instruction.
  #
  # The allowance is deliberately narrow: the path is exempt from resolution
  # ONLY while the definition also contains a guarding phrase naming that
  # condition. Once the file lands, it resolves normally and the exemption stops
  # mattering. An UNguarded reference to a missing file is still a hard fail.
  # Guard phrases, matched case-insensitively. Kept as plain alternates so a
  # future conditional reference can reuse them without regex surgery.
  CONDITIONAL_GUARD='is present|when present|if it is absent|if absent'

  N_PATHS=0
  MISSING=""
  CONDITIONAL=""
  while IFS= read -r p; do
    [ -n "$p" ] || continue
    N_PATHS=$((N_PATHS + 1))
    if [ ! -e "$REPO_ROOT/$p" ]; then
      # Exempt only if the definition guards this specific path with a
      # presence condition in the same paragraph-ish neighbourhood: require
      # both the path and a guard phrase to appear within 6 lines of each other.
      # The path is data, not a pattern: escape regex metacharacters (notably
      # the "." in a filename) before embedding it. Unescaped, "verify-lane.ts"
      # still matched itself by luck, but a path whose dot mattered would have
      # matched the wrong text — and the guard would silently over-exempt.
      P_RE="$(printf '%s' "$p" | sed 's/[][\\.*^$+?(){}|\/]/\\&/g')"
      if rg -Ui -e "$P_RE"'[\s\S]{0,400}?('"$CONDITIONAL_GUARD"')' "$AGENT" >/dev/null 2>&1 \
         || rg -Ui -e '('"$CONDITIONAL_GUARD"')[\s\S]{0,400}?'"$P_RE" "$AGENT" >/dev/null 2>&1; then
        CONDITIONAL="${CONDITIONAL}${p} "
      else
        MISSING="${MISSING}${p} "
      fi
    fi
  done <<EOF
$CANDIDATES
EOF

  if [ "$N_PATHS" -lt 5 ]; then
    # Vacuous-pass guard: the extraction found (almost) nothing, which means
    # either the definition names no files (a brainless verifier) or the
    # extraction is broken. Either way this is not a pass.
    CLAUSE2_EVIDENCE="only $N_PATHS repo path(s) extracted from $AGENT_REL — a verifier whose brain is files must name at least 5; extraction or definition is broken"
  elif [ -n "$MISSING" ]; then
    CLAUSE2_EVIDENCE="$N_PATHS path(s) referenced, UNRESOLVABLE: ${MISSING}— the agent's brain points at nothing"
  else
    CLAUSE2=PASS
    if [ -n "$CONDITIONAL" ]; then
      CLAUSE2_EVIDENCE="all $N_PATHS referenced repo path(s) resolve under $REPO_ROOT, EXCEPT guarded forward reference(s) explicitly conditioned on presence: ${CONDITIONAL}(announced, not silent)"
    else
      CLAUSE2_EVIDENCE="all $N_PATHS referenced repo path(s) resolve under $REPO_ROOT"
    fi
  fi
fi

# ---------------------------------------------------------------------------
# CLAUSE 3 — the guardrail sentence, literally.
# ---------------------------------------------------------------------------
GUARDRAIL="never the enforcement"
if [ -r "$AGENT" ] && grep -qF "$GUARDRAIL" "$AGENT"; then
  CLAUSE3=PASS
  CLAUSE3_EVIDENCE="literal guardrail \"$GUARDRAIL\" present $(grep -cF "$GUARDRAIL" "$AGENT") time(s)"
else
  CLAUSE3_EVIDENCE="literal guardrail \"$GUARDRAIL\" ABSENT — the agent no longer states that its judgment gates nothing"
fi

# ---------------------------------------------------------------------------
# CLAUSE 4 — the loud-unknown instruction.
# ---------------------------------------------------------------------------
LOUD="NOVEL CLASS"
if [ -r "$AGENT" ] && grep -qF "$LOUD" "$AGENT"; then
  CLAUSE4=PASS
  CLAUSE4_EVIDENCE="loud-unknown marker \"$LOUD\" present $(grep -cF "$LOUD" "$AGENT") time(s) — the unknown path is announced, not silent"
else
  CLAUSE4_EVIDENCE="loud-unknown marker \"$LOUD\" ABSENT — nothing stops a forced wrong \"this is a known class\""
fi

# ---------------------------------------------------------------------------
# CLAUSE 5 — all three brain sources named by real path.
# ---------------------------------------------------------------------------
BRAIN_SOURCES="docs/sme/entries/
docs/lane-contract.md
scripts/done-means/"

MISSING_BRAIN=""
FOUND_BRAIN=0
if [ -r "$AGENT" ]; then
  while IFS= read -r b; do
    [ -n "$b" ] || continue
    if grep -qF "$b" "$AGENT"; then
      FOUND_BRAIN=$((FOUND_BRAIN + 1))
    else
      MISSING_BRAIN="${MISSING_BRAIN}${b} "
    fi
  done <<EOF
$BRAIN_SOURCES
EOF
else
  MISSING_BRAIN="(agent definition unreadable) "
fi

if [ -z "$MISSING_BRAIN" ]; then
  CLAUSE5=PASS
  CLAUSE5_EVIDENCE="all $FOUND_BRAIN brain sources named by real path (SME scope keys, lane contract, done-means toolbox)"
else
  CLAUSE5_EVIDENCE="brain source(s) NOT named: $MISSING_BRAIN"
fi

printf 'CLAUSE 1 (verifier.md exists and is git-tracked):        %s — %s\n' "$CLAUSE1" "$CLAUSE1_EVIDENCE"
printf 'CLAUSE 2 (every referenced repo path resolves):          %s — %s\n' "$CLAUSE2" "$CLAUSE2_EVIDENCE"
printf 'CLAUSE 3 (guardrail "never the enforcement" present):    %s — %s\n' "$CLAUSE3" "$CLAUSE3_EVIDENCE"
printf 'CLAUSE 4 (loud-unknown "NOVEL CLASS" present):           %s — %s\n' "$CLAUSE4" "$CLAUSE4_EVIDENCE"
printf 'CLAUSE 5 (all three brain sources named by path):        %s — %s\n' "$CLAUSE5" "$CLAUSE5_EVIDENCE"

if [ "$CLAUSE1" = PASS ] && [ "$CLAUSE2" = PASS ] && [ "$CLAUSE3" = PASS ] && [ "$CLAUSE4" = PASS ] && [ "$CLAUSE5" = PASS ]; then
  exit 0
fi
exit 1
