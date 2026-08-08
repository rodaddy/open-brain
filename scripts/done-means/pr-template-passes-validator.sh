#!/usr/bin/env bash
# DONE-MEANS check for ledger item 14 (docs/issue-graph.md, decisions pass
# 2026-08-07) — "make PR bodies right the first time".
#
#   bash scripts/done-means/pr-template-passes-validator.sh
#
# ---------------------------------------------------------------------------
# The defect this gates
# ---------------------------------------------------------------------------
# In one night, three lanes failed scripts/validate-pr-body.ts three DIFFERENT
# ways, and every one of them was a formatting failure rather than a thinking
# failure:
#
#   1. the whole body pasted inside a ``` code fence — section() matches
#      `## Name` on a trimmed line (validate-pr-body.ts:15-30), and a fenced
#      heading is still a line, but a fence around the WHOLE body means the
#      lane hand-typed it from a chat transcript rather than from the template;
#   2. `- **Highest-risk behavior:** ...` — requireSpecificLine builds
#      /^-\s*<label>:/ (validate-pr-body.ts:32-47), so the `**` between the
#      dash and the label breaks the anchor and the field reads as empty;
#   3. `## Review Gate` omitted entirely.
#
# All three are prevented by ONE thing: a checked-in template that already
# passes the validator when filled, so a lane that starts from it cannot fail
# on shape. This check is the reward function for that claim. It does not test
# whether a lane wrote GOOD content — the validator's placeholder rules do that
# — it tests that FORMAT is no longer a way to fail.
#
# ---------------------------------------------------------------------------
# Three clauses
# ---------------------------------------------------------------------------
# CLAUSE 1 — FILLED TEMPLATE PASSES.
#   Take the committed template verbatim, mechanically fill it the way a lane
#   would (append a dummy non-placeholder value to every empty `- Label:` line,
#   tick every `[ ]` checkbox, pick the first disposition of each either/or
#   pair), and feed it to the validator. Expect exit 0.
#
#   Filling is done with sed on the template's own text — no second copy of the
#   field list is maintained here for clause 1, because a hand-maintained copy
#   would itself be the drift this check exists to prevent.
#
#   Note the dummy value must not be one of PLACEHOLDER_REASONS
#   (validate-pr-body.ts:9) — "-", "n/a", "na", "none", "todo", "tbd" — or the
#   check would fail for a reason that has nothing to do with the template.
#
# CLAUSE 2 — DRIFT DETECTION.
#   The validator is the source of truth for WHICH sections and labels exist.
#   Clause 1 alone cannot catch a validator that grew a new required section,
#   because a template missing that section would fail clause 1 with a message
#   nobody reads as "drift". So the required headings and labels are enumerated
#   HERE, deliberately duplicated, and cross-checked in BOTH directions:
#
#     (a) every heading/label this check knows about is present in the
#         template — the template has not fallen behind, and
#     (b) every heading/label the VALIDATOR SOURCE names is in this check's
#         list — this check has not fallen behind the validator.
#
#   (b) is what makes the duplication safe. The list below is extracted from
#   scripts/validate-pr-body.ts by reading its literal strings, so adding a
#   required field to the validator without updating both this check and the
#   template turns the build red rather than silently passing.
#
# CLAUSE 3 — THE SCRIBE CANNOT SKIP THE VALIDATOR.
#   .claude/agents/pr-scribe.md must exist and must contain the literal string
#   `validate-pr-body.ts`. The agent composes a body from a lane's evidence and
#   then runs the script; the script never trusts the agent. An agent definition
#   that no longer names the script has quietly become advice.
#
# Exit 0 only when all three clauses pass. Exit 3 is a harness error (missing
# tool / unreadable repo), which is NOT a fail of the thing under test.
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TEMPLATE="$REPO_ROOT/.github/pull_request_template.md"
VALIDATOR="$REPO_ROOT/scripts/validate-pr-body.ts"
SCRIBE="$REPO_ROOT/.claude/agents/pr-scribe.md"

fail_hard() {
  printf 'HARNESS-ERROR: %s\n' "$1" >&2
  exit 3
}

command -v bun >/dev/null 2>&1 || fail_hard "bun not on PATH"
[ -r "$VALIDATOR" ] || fail_hard "validator not readable at $VALIDATOR"

CLAUSE1=FAIL
CLAUSE1_EVIDENCE=""
CLAUSE2=FAIL
CLAUSE2_EVIDENCE=""
CLAUSE3=FAIL
CLAUSE3_EVIDENCE=""

# ---------------------------------------------------------------------------
# The validator's own requirements, enumerated. Kept in sync by clause 2(b).
# ---------------------------------------------------------------------------
# Section headings the validator looks up via section().
REQUIRED_SECTIONS="Verification
Critical Self-Review
Review Gate"

# Labels the validator anchors with /^-\s*<label>:/ via requireSpecificLine().
REQUIRED_LABELS="Done-means
Highest-risk behavior
Assumptions that could be wrong
Missing/weak tests
Security/permission risk
Migration/deploy risk
Downstream client/runtime risk
Rollback/cleanup concern
Fixes made before PR
Known residual risk"

# ---------------------------------------------------------------------------
# CLAUSE 1 — the committed template, mechanically filled, passes the validator.
# ---------------------------------------------------------------------------
DUMMY="dummy specific content for the acceptance gate"

if [ ! -r "$TEMPLATE" ]; then
  CLAUSE1=FAIL
  CLAUSE1_EVIDENCE="no template at $TEMPLATE — a lane has nothing to start from"
else
  # A lane filling the template does exactly this, by hand:
  #   1. every `- Some Label:` with nothing after the colon gets content;
  #   2. every `- [ ]` checkbox gets ticked;
  #   3. every `[ ] first or [ ] second: ` either/or picks ONE side.
  # Order matters: the disposition rewrite (3) runs BEFORE the generic
  # empty-label fill (1), because a disposition line ends in `because:` with
  # nothing after it and would otherwise be filled as if it were a plain field,
  # leaving BOTH sides of the either/or checked — which the validator correctly
  # rejects with "must check exactly one disposition".
  FILLED="$(
    sed \
      -e 's/\[ \]\(.*\)or \[ \] not applicable because:.*$/[x]\1or [ ] not applicable because:/' \
      -e 's/^- \[ \]/- [x]/' \
      -e 's|^- Done-means:.*$|- Done-means: scripts/validate-pr-body.ts|' \
      -e "s/^\(- [^][]*:\)[[:space:]]*$/\1 $DUMMY/" \
      "$TEMPLATE"
  )"

  VOUT="$(PR_BODY="$FILLED" PR_TITLE="done-means pr-template gate" bun "$VALIDATOR" 2>&1)"
  VEXIT=$?

  if [ "$VEXIT" -eq 0 ]; then
    CLAUSE1=PASS
    CLAUSE1_EVIDENCE="filled template validated: exit=0 — $(printf '%s' "$VOUT" | tr '\n' ' ')"
  else
    CLAUSE1=FAIL
    CLAUSE1_EVIDENCE="filled template REJECTED (exit=$VEXIT): $(printf '%s' "$VOUT" | tr '\n' ' ')"
  fi
fi

# ---------------------------------------------------------------------------
# CLAUSE 2 — drift, both directions.
# ---------------------------------------------------------------------------
DRIFT=""

if [ ! -r "$TEMPLATE" ]; then
  DRIFT="template absent"
else
  # (a) template has everything this check requires.
  while IFS= read -r s; do
    [ -n "$s" ] || continue
    if ! grep -qixF "## $s" "$TEMPLATE"; then
      DRIFT="${DRIFT}template missing section '## $s'; "
    fi
  done <<EOF
$REQUIRED_SECTIONS
EOF

  while IFS= read -r l; do
    [ -n "$l" ] || continue
    # Same anchor shape the validator uses: dash, optional space, bare label,
    # colon. A bolded `- **Label:**` deliberately does NOT match — that was
    # failure mode 2 and the template must not reintroduce it.
    if ! grep -qE "^-[[:space:]]*$(printf '%s' "$l" | sed 's/[][\\.*^$/]/\\&/g'):" "$TEMPLATE"; then
      DRIFT="${DRIFT}template missing label line '- $l:'; "
    fi
  done <<EOF
$REQUIRED_LABELS
EOF

  # (b) this check has everything the VALIDATOR names. Extracted from the
  # validator source, not from memory.
  V_SECTIONS="$(grep -oE 'section\(body, "[^"]+"\)' "$VALIDATOR" | sed 's/.*"\(.*\)".*/\1/' | sort -u)"
  while IFS= read -r s; do
    [ -n "$s" ] || continue
    # Contract Parity is conditional (options.contractParityRequired) so it is
    # not in the unconditional required set; it is still checked for presence in
    # the template below, but its absence from REQUIRED_SECTIONS is correct.
    [ "$s" = "Contract Parity" ] && continue
    if ! printf '%s\n' "$REQUIRED_SECTIONS" | grep -qxF "$s"; then
      DRIFT="${DRIFT}check is behind validator: unknown required section '$s'; "
    fi
  done <<EOF
$V_SECTIONS
EOF

  # requireSpecificLine labels live in the array literal or direct literal calls.
  V_LABELS="$(
    {
      awk '/requireSpecificLine\(criticalSelfReview/{exit} /for \(const label of \[/{f=1;next} f&&/^\s*\]/{f=0} f' "$VALIDATOR" \
        | grep -oE '"[^"]+"' | tr -d '"'
      grep -oE 'requireSpecificLine\([^,]+, "[^"]+"' "$VALIDATOR" \
        | sed 's/.*"\([^"]*\)"/\1/'
    } | sort -u
  )"
  [ -n "$V_LABELS" ] || fail_hard "could not extract requireSpecificLine labels from $VALIDATOR — the extraction, not the template, is broken"
  while IFS= read -r l; do
    [ -n "$l" ] || continue
    if ! printf '%s\n' "$REQUIRED_LABELS" | grep -qxF "$l"; then
      DRIFT="${DRIFT}check is behind validator: unknown required label '$l'; "
    fi
  done <<EOF
$V_LABELS
EOF

  # The conditional section still has to exist in the template, because a
  # contract-touching PR is validated with CONTRACT_PARITY_REQUIRED=true and a
  # lane that started from a template without it would fail on shape again.
  if ! grep -qixF "## Contract Parity" "$TEMPLATE"; then
    DRIFT="${DRIFT}template missing conditional section '## Contract Parity'; "
  fi
fi

if [ -z "$DRIFT" ]; then
  CLAUSE2=PASS
  CLAUSE2_EVIDENCE="template and check both current with validator: $(printf '%s\n' "$REQUIRED_SECTIONS" | grep -c .) sections + Contract Parity, $(printf '%s\n' "$REQUIRED_LABELS" | grep -c .) labels cross-checked in both directions"
else
  CLAUSE2=FAIL
  CLAUSE2_EVIDENCE="drift: $DRIFT"
fi

# ---------------------------------------------------------------------------
# CLAUSE 3 — the scribe agent names the validator.
# ---------------------------------------------------------------------------
if [ ! -r "$SCRIBE" ]; then
  CLAUSE3=FAIL
  CLAUSE3_EVIDENCE="no agent definition at $SCRIBE"
elif grep -qF 'validate-pr-body.ts' "$SCRIBE"; then
  CLAUSE3=PASS
  CLAUSE3_EVIDENCE="$SCRIBE names validate-pr-body.ts $(grep -cF 'validate-pr-body.ts' "$SCRIBE") time(s) — the unskippable final step is still written down"
else
  CLAUSE3=FAIL
  CLAUSE3_EVIDENCE="$SCRIBE exists but never names validate-pr-body.ts — the agent has become advice"
fi

printf 'CLAUSE 1 (filled template passes the validator): %s — %s\n' "$CLAUSE1" "$CLAUSE1_EVIDENCE"
printf 'CLAUSE 2 (template and check track the validator): %s — %s\n' "$CLAUSE2" "$CLAUSE2_EVIDENCE"
printf 'CLAUSE 3 (pr-scribe agent runs the validator): %s — %s\n' "$CLAUSE3" "$CLAUSE3_EVIDENCE"

if [ "$CLAUSE1" = PASS ] && [ "$CLAUSE2" = PASS ] && [ "$CLAUSE3" = PASS ]; then
  exit 0
fi
exit 1
