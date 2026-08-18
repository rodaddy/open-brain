#!/usr/bin/env bash
# DONE-MEANS check for the repo-local TRACKING-SCRIBE agent
# (docs/issue-graph.md ledger item 8, "Agent candidates").
#
#   bash scripts/done-means/tracking-scribe-root-only.sh
#
# ---------------------------------------------------------------------------
# The defect this gates
# ---------------------------------------------------------------------------
# The tracking scribe existed for weeks as a PASTE-IN PROMPT the operator
# re-sent each time ("TRACKING SCRIBE run for..."). Nothing on disk carried it,
# and that is exactly why the root-only rule kept getting violated: the rule was
# written in docs/lane-contract.md and repeated in operator messages, but the
# entity doing the graph-state writing had no definition of its own to carry it.
# A prompt retyped from memory drops its own guardrails. A committed file does
# not.
#
# The cost was measured on 2026-08-10 (_plans/worklog/reconcile-root-2026-08-10.md):
# three divergent copies of docs/lane-contract.md across root and two worktrees,
# no single copy a superset, 164 lines of harvest rounds stranded where `aqmd up`
# — which indexes the ROOT repo only — could never see them. Harvest rounds that
# are unsearchable are functionally deleted from the knowledge base, which
# defeats the entire point of the harvest step.
#
# So this check asserts three things a future edit could quietly undo:
#
#   1. THE AGENT EXISTS AND SURVIVES A FRESH CLONE. .gitignore:53 excludes
#      `.claude/*`; the `!.claude/agents/` negation on line 70 is what saves it.
#      That pattern nearly ate .claude/agents/pr-scribe.md on the #615 lane
#      (docs/lane-contract.md, 2026-08-08 Tightenings). An agent definition that
#      lives only in the authoring checkout protects only the machine that wrote
#      it. Like verifier-agent-grounded.sh, this asserts the OUTCOME (git tracks
#      it), not the presence of a pattern — a pattern can be present and still be
#      overridden by a later rule.
#
#   2. THE ROOT-ONLY LAW IS FIRST, AND CARRIES ITS WHY. Not merely present
#      somewhere in the body: FIRST, ahead of the standing run and the harvest
#      duty, because an agent that reads its job before its constraint has
#      already decided where to write by the time it reaches the constraint.
#      "First" is asserted structurally — the root-only section heading must
#      precede every other section heading in the file. The WHY (aqmd indexes
#      the root only, so a worktree write is invisible) must appear too: a rule
#      whose reason is stripped is the one a future editor "simplifies" away,
#      and this specific rule reads like pointless ceremony without it.
#
#   3. THE SOP NAMES THIS AGENT AS THE HARVEST OWNER. The gap being closed is
#      that harvest was described as an inline controller action with no named
#      owner, so it got absorbed by the head (controller-contract obligation 6,
#      the recorded "why are you doing it yourself?" failure). If
#      docs/sop-rlvr-lanes.md stops naming the agent, the gap silently reopens
#      while the agent file still sits there looking built.
#
# ---------------------------------------------------------------------------
# Six clauses
# ---------------------------------------------------------------------------
# CLAUSE 1 — COMMITTED, NOT JUST PRESENT.
#   .claude/agents/tracking-scribe.md exists AND `git ls-files` reports it
#   tracked. `git check-ignore` is run too and its verdict printed, so a future
#   .gitignore edit that re-ignores the path is NAMED in the output rather than
#   inferred from a bare FAIL.
#
# CLAUSE 2 — THE ROOT-ONLY LAW IS THE FIRST SECTION.
#   The first `## ` heading in the body matches /root|ROOT/ . Position is the
#   assertion; a root-only section demoted below the standing run turns the
#   first law into a footnote.
#
# CLAUSE 3 — THE LAW'S WHY IS STATED (aqmd visibility).
#   Both "aqmd" and a worktree-invisibility phrase appear. Rules without reasons
#   get edited out by well-meaning cleanup passes.
#
# CLAUSE 4 — REPORT-AND-MIRROR BOUNDARY.
#   The definition states it never closes issues and never merges. This scribe
#   runs `gh`-backed tooling against the live forge; a scribe that drifts into
#   closing things is a mutation agent wearing a bookkeeping label, and "close"
#   in this repo means finish the work, never flip the state.
#
# CLAUSE 5 — THE THREE HARVEST TARGETS NAMED BY REAL PATH.
#   docs/lane-contract.md, docs/sme/entries/, and docs/issue-graph.md each
#   appear literally. These are where a lane's returned learnings land. A scribe
#   missing one of them silently drops that category of learning.
#
# CLAUSE 6 — THE SOP NAMES THE AGENT AS HARVEST OWNER.
#   docs/sop-rlvr-lanes.md contains "tracking-scribe", AND contains it within
#   the "**Harvest (mandatory)**" step of the head-session loop specifically —
#   not merely somewhere in a file that also discusses harvest. This is the
#   clause that keeps the closed gap closed: the gap was harvest-with-no-owner,
#   so a decorative mention in the parts table must not satisfy it.
#
# Exit 0 only when all six clauses pass. Exit 3 is a harness error (missing tool
# / unreadable repo), which is NOT a fail of the thing under test.
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
AGENT_REL=".claude/agents/tracking-scribe.md"
AGENT="$REPO_ROOT/$AGENT_REL"
SOP_REL="docs/sop-rlvr-lanes.md"
SOP="$REPO_ROOT/$SOP_REL"

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
CLAUSE6=FAIL; CLAUSE6_EVIDENCE=""

# ---------------------------------------------------------------------------
# CLAUSE 1 — exists and is tracked by git.
# ---------------------------------------------------------------------------
if [ ! -r "$AGENT" ]; then
  CLAUSE1_EVIDENCE="no agent definition at $AGENT_REL — the tracking scribe is still only a paste-in prompt"
else
  TRACKED="$(git -C "$REPO_ROOT" ls-files -- "$AGENT_REL")"
  IGNORE_VERDICT="$(git -C "$REPO_ROOT" check-ignore -v -- "$AGENT_REL" 2>/dev/null)"
  if [ -n "$TRACKED" ]; then
    CLAUSE1=PASS
    CLAUSE1_EVIDENCE="$AGENT_REL present and git-tracked (visible in a fresh clone/worktree); check-ignore says: ${IGNORE_VERDICT:-not ignored}"
  else
    CLAUSE1_EVIDENCE="$AGENT_REL exists on disk but git does NOT track it — a fresh clone gets no tracking scribe. check-ignore says: ${IGNORE_VERDICT:-not ignored (so it is merely unstaged)}"
  fi
fi

# ---------------------------------------------------------------------------
# CLAUSE 2 — the root-only law is the FIRST section heading.
# ---------------------------------------------------------------------------
if [ ! -r "$AGENT" ]; then
  CLAUSE2_EVIDENCE="agent definition unreadable — no first law to check"
else
  FIRST_HEADING="$(rg -N -e '^## ' "$AGENT" 2>/dev/null | head -n 1)"
  if [ -z "$FIRST_HEADING" ]; then
    CLAUSE2_EVIDENCE="no '## ' section headings found in $AGENT_REL — cannot establish which law comes first"
  elif printf '%s' "$FIRST_HEADING" | rg -qi -e 'root'; then
    CLAUSE2=PASS
    CLAUSE2_EVIDENCE="first section is the root-only law: \"$FIRST_HEADING\""
  else
    CLAUSE2_EVIDENCE="first section is \"$FIRST_HEADING\" — the root-only law is not the first law; an agent that reads its job before its constraint has already chosen where to write"
  fi
fi

# ---------------------------------------------------------------------------
# CLAUSE 3 — the law states its WHY (aqmd indexes root only).
# ---------------------------------------------------------------------------
WHY_INVISIBLE='invisible|not indexed|never indexed|functionally deleted|unsearchable'
if [ ! -r "$AGENT" ]; then
  CLAUSE3_EVIDENCE="agent definition unreadable — no WHY to check"
elif rg -q -e 'aqmd' "$AGENT" && rg -qi -e "$WHY_INVISIBLE" "$AGENT"; then
  CLAUSE3=PASS
  CLAUSE3_EVIDENCE="root-only law carries its reason: 'aqmd' named and worktree-invisibility stated — the rule cannot be read as ceremony"
else
  MISS=""
  rg -q -e 'aqmd' "$AGENT" || MISS="${MISS}'aqmd' "
  rg -qi -e "$WHY_INVISIBLE" "$AGENT" || MISS="${MISS}invisibility-phrase "
  CLAUSE3_EVIDENCE="root-only law is missing its WHY: ${MISS}— a rule without its reason is the one a cleanup pass deletes"
fi

# ---------------------------------------------------------------------------
# CLAUSE 4 — report-and-mirror boundary (never closes, never merges).
# ---------------------------------------------------------------------------
if [ ! -r "$AGENT" ]; then
  CLAUSE4_EVIDENCE="agent definition unreadable — no boundary to check"
else
  HAS_NO_CLOSE=FAIL
  HAS_NO_MERGE=FAIL
  rg -qi -e 'never clos|do not clos|does not clos|never close issues' "$AGENT" && HAS_NO_CLOSE=PASS
  rg -qi -e 'never merge|do not merge|does not merge' "$AGENT" && HAS_NO_MERGE=PASS
  if [ "$HAS_NO_CLOSE" = PASS ] && [ "$HAS_NO_MERGE" = PASS ]; then
    CLAUSE4=PASS
    CLAUSE4_EVIDENCE="report-and-mirror boundary stated: never closes issues, never merges"
  else
    CLAUSE4_EVIDENCE="boundary incomplete (never-close: $HAS_NO_CLOSE, never-merge: $HAS_NO_MERGE) — a bookkeeping agent with unstated mutation limits drifts into mutating"
  fi
fi

# ---------------------------------------------------------------------------
# CLAUSE 5 — the three harvest targets named by real path.
# ---------------------------------------------------------------------------
HARVEST_TARGETS="docs/lane-contract.md
docs/sme/entries/
docs/issue-graph.md"

MISSING_TARGET=""
FOUND_TARGET=0
if [ -r "$AGENT" ]; then
  while IFS= read -r t; do
    [ -n "$t" ] || continue
    if grep -qF "$t" "$AGENT"; then
      FOUND_TARGET=$((FOUND_TARGET + 1))
      # A named target that does not exist is a pointer at nothing — the
      # verifier agent's clause-2 failure mode, applied here.
      [ -e "$REPO_ROOT/$t" ] || MISSING_TARGET="${MISSING_TARGET}${t}(named-but-absent-on-disk) "
    else
      MISSING_TARGET="${MISSING_TARGET}${t}(not-named) "
    fi
  done <<EOF
$HARVEST_TARGETS
EOF
else
  MISSING_TARGET="(agent definition unreadable) "
fi

if [ -z "$MISSING_TARGET" ]; then
  CLAUSE5=PASS
  CLAUSE5_EVIDENCE="all $FOUND_TARGET harvest targets named by real path and resolving (Tightenings, SME entries, ledger)"
else
  CLAUSE5_EVIDENCE="harvest target problem(s): ${MISSING_TARGET}— an unnamed target is a category of learning the scribe silently drops"
fi

# ---------------------------------------------------------------------------
# CLAUSE 6 — the SOP names this agent as the harvest owner.
# ---------------------------------------------------------------------------
if [ ! -r "$SOP" ]; then
  CLAUSE6_EVIDENCE="$SOP_REL unreadable — cannot confirm the harvest step has a named owner"
else
  # Require the name to appear in the SOP at all, AND specifically within the
  # Harvest step's text. The second half is what stops a decorative mention in
  # a parts table from satisfying a clause about ownership.
  IN_SOP=FAIL
  IN_HARVEST=FAIL
  rg -q -e 'tracking-scribe' "$SOP" && IN_SOP=PASS
  # Anchor to the numbered Harvest step of the head-session loop, not to any
  # line containing the word "harvest". A parts-table row sits above that step
  # and mentions harvest too; a window keyed on the bare word matched it and
  # reported ownership PASS while the step itself had lost the name (observed
  # while mutation-testing this check, 2026-08-10). Keying on the literal
  # "**Harvest (mandatory)**" step marker makes the clause assert what it says.
  rg -qUi -e '\*\*Harvest \(mandatory\)\*\*[\s\S]{0,900}?tracking-scribe' "$SOP" && IN_HARVEST=PASS
  if [ "$IN_SOP" = PASS ] && [ "$IN_HARVEST" = PASS ]; then
    CLAUSE6=PASS
    CLAUSE6_EVIDENCE="$SOP_REL names tracking-scribe, and does so inside the Harvest step — the step has an owner, not a description"
  else
    CLAUSE6_EVIDENCE="$SOP_REL harvest ownership missing (named-anywhere: $IN_SOP, named-in-Harvest-step: $IN_HARVEST) — harvest reverts to an unowned inline controller action"
  fi
fi

printf 'CLAUSE 1 (tracking-scribe.md exists and is git-tracked):   %s — %s\n' "$CLAUSE1" "$CLAUSE1_EVIDENCE"
printf 'CLAUSE 2 (root-only law is the FIRST section):             %s — %s\n' "$CLAUSE2" "$CLAUSE2_EVIDENCE"
printf 'CLAUSE 3 (root-only law states its aqmd WHY):              %s — %s\n' "$CLAUSE3" "$CLAUSE3_EVIDENCE"
printf 'CLAUSE 4 (report-and-mirror: never closes, never merges):  %s — %s\n' "$CLAUSE4" "$CLAUSE4_EVIDENCE"
printf 'CLAUSE 5 (three harvest targets named by real path):       %s — %s\n' "$CLAUSE5" "$CLAUSE5_EVIDENCE"
printf 'CLAUSE 6 (SOP names tracking-scribe as harvest owner):     %s — %s\n' "$CLAUSE6" "$CLAUSE6_EVIDENCE"

if [ "$CLAUSE1" = PASS ] && [ "$CLAUSE2" = PASS ] && [ "$CLAUSE3" = PASS ] \
   && [ "$CLAUSE4" = PASS ] && [ "$CLAUSE5" = PASS ] && [ "$CLAUSE6" = PASS ]; then
  exit 0
fi
exit 1
