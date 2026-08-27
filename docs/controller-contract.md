# The Controller Contract

Status: WRITTEN 2026-08-08, operator-directed the same day: the head agent
"needs the same sort of restraints and regulations to stay on track and to
actually call all of the sub-agents properly with very direct and succinct
instructions with formatted requirement outputs as results." This binds the
HEAD session (any model), exactly as `docs/lane-contract.md` binds lanes.
The head is not the exempt layer; it was the least-gated one, and this file
plus the merge-gate hook exist to end that.

## Dispatch rules

Every lane dispatch MUST contain, and contain little else:

1. **The task** — issue number or ledger item, with the operator decision that
   authorizes it.
2. **The deliverables** — exact files/PR expected.
3. **The done-means design** — what the red-first check must prove. The lane
   authors the check; the controller states what it must demonstrate.
4. **Route + stated reason** — routine and well-specified → Sol (per
   `_DOCS/MODEL_ROUTING.md`, Sol is the PREFERRED delegate for bounded lanes);
   judgment-heavy, security-boundary, or deep-root-cause → Opus. The reason is
   written in the dispatch. Defaulting to Opus out of momentum is the recorded
   failure this rule exists to stop (first 12 lanes, 2026-08-07/08).
5. **One pointer** to `docs/lane-contract.md` for all standing rules — the
   dispatch NEVER restates them. Restated rules fork; pointed-at rules ratchet.
6. **The report format** (below), required verbatim.

Succinctness is a correctness property: every line of briefing beyond the
task-specific content is a line that can drift from the canonical version.

## Required lane report format

Lanes return EXACTLY these fields, in order. A missing field is an incomplete
report and the controller sends it back rather than filling gaps by inference:

```
self-reported model: <id>            (weak evidence, never attestation)
branch: <name>
pr: <number + state: OPEN/MERGED, CI state>
red: <one-line proof the check failed before the change, or transcript ref>
green: <one-line proof it passes after, or transcript ref>
root-cause: <file:line — for fixes; "n/a (new capability)" otherwise>
deviations: <each: what, which recorded decision it touches, ruling requested — or "none">
refusals-and-violations: <each gate hit and how resolved; self-reported violations — or "none">
teardown: <what was created and its end state; anything not removed, named>
claim-states: <the load-bearing claims, each labeled RUNNING/MERGED/WRITTEN/PROPOSED>
lessons: <candidate Tightenings for the harvest — or "none">
```

Prose beyond the fields is welcome AFTER them, never instead of them.

## Controller obligations (the restraints)

1. **Verify before merge, through the machinery.** Run the lane's done-means
   check independently (via `scripts/verify-lane.ts` once merged; a fresh
   worktree run until then). Worker output is PROPOSED until the controller's
   own run passes. ENFORCED: the merge-gate hook refuses `gh pr merge`
   without a current-SHA receipt — the head is the first entity it gates.
2. **Harvest before the next dispatch** (ledger item 19). Every lane report's
   `lessons` and incident fields land in `docs/lane-contract.md` Tightenings
   with provenance, or the report's PR carries an explicit `No new lessons:`
   line. ENFORCED: merge-gate harvest clause.
   **DISPATCH IT, do not absorb it** (2026-08-10): the harvest is owned by the
   `tracking-scribe` agent (`.claude/agents/tracking-scribe.md`), which also owns
   the standing issue-mirror run. The head's job is to dispatch it with the lane
   reports and to confirm the receipt says it wrote to ROOT and ran `aqmd up`.
   Harvesting inline is obligation 6's failure mode wearing a bookkeeping label,
   and it is how 164 lines of rounds ended up stranded in worktrees where `aqmd`
   could not see them (`_plans/worklog/reconcile-root-2026-08-10.md`).
2b. **Close the node out loud** (ledger item 32, operator ruling 2026-08-09).
   At merge, post a CLOSURE COMMENT on the ISSUE — not only on the PR —
   stating the direction taken, why that direction over the alternatives
   considered, and the receipts (PR number, merge SHA, the done-means check
   that judged it). `scripts/sync-issues.ts` renders a `## Resolution` into
   the closed issue's artifact from the closing PR, and mirrors comments as it
   always has, so the reasoning lands in `_plans/issues/` either way and an
   `aqmd` search for a resolved question returns the answer rather than a
   CLOSED stamp. Operator: the artifacts must "explain the direction we went in
   and why we went in them." A closure comment that restates the title is not
   this; the WHY and the rejected alternative are the payload. AUDITED — the
   artifact is the record, and it is regenerated from the forge on every sync.

3. **Decisions only with the operator.** Judgment calls, deviations, and
   generalizable rulings go to the decisions pass — one item at a time, TL;DR
   each, recorded in the ledger with rejected options. Never ruled solo,
   never batched into a wall. AUDITED: the ledger itself is the record the
   operator reviews.
4. **Nothing silent applies to the head.** Route substitutions, A/B slips,
   scope adjustments, and failed intentions are announced in the operator
   report at the moment they happen (model: the 4.8 registry slip,
   2026-08-08). AUDITED.
5. **Truth grammar in every operator report.** RUNNING / MERGED / WRITTEN /
   PROPOSED on load-bearing claims; scoreboards distinguish merged from
   deployed. AUDITED.
6. **The head does not absorb delegable lanes.** Implementation with a
   definable end state goes to a lane; the head controls, verifies, harvests,
   and closes. INLINE stays for conversation, exact lookups, and tiny
   deterministic changes. AUDITED (operator called this out live,
   2026-08-07: "why are you doing it yourself?").
7. **Enforcement migration.** Where a controller obligation is AUDITED today,
   prefer building the deterministic gate that makes it ENFORCED tomorrow —
   the same trajectory PR-body validation took (advice → template → validator
   → hook). Each migration is a decisions-pass item.

## Relationship to the other contracts

`docs/lane-contract.md` — binds lanes; harvested by the controller.
`docs/controller-contract.md` — this file; binds the head; harvested by the
decisions pass with the operator.
`docs/sop-rlvr-lanes.md` — the loop both operate inside.
Agent produces, script judges, hook enforces — at every layer, including this
one.

## Graph Mode v1.3-beta (opted in 2026-08-27, pilot)

Pilot per Rico, 2026-08-27. Amendment:
`_DOCS/GRAPH_MODE_SOP-v1.3-beta.md` in Development. Executables are copied
byte-faithful into `scripts/done-means/beta/` with `PROVENANCE.md`;
improvements flow back to the Development canon, never as a local fork.
**Nothing here is hook-wired, merge-gated, or in CI.** The controller runs
these by hand at the landing points this contract already names.

1. **Briefs are assembled, not pasted.** A lane brief comes from
   `scripts/done-means/beta/brief-pack/pack.sh`, which ranks Tightenings and
   decisions against the task, emits an `## Excluded (available on request)`
   list, and REFUSES over budget rather than truncating. A refusal is the
   signal to cut a smaller lane, not to raise the budget.
2. **A lane report is accepted only after it validates.** This repo's schema is
   the eleven-field one under `## Required lane report format` above, so the
   beta's five-field `lane-report/check.sh` does NOT judge it; the repo's own
   format section remains the authority until the schemas are reconciled in a
   decisions pass. Where a lane returns the beta five-field shape instead,
   `scripts/done-means/beta/lane-report/check.sh <report>` must exit 0 before
   the report is read.
3. **Every merge pass records exits.** At each merge pass the controller runs,
   and appends the exact command, exit, and last line to
   `scripts/done-means/beta-receipts.md`:
   - `scripts/done-means/beta/ratchet-bound/check.sh docs/lane-contract.md`
   - `scripts/done-means/beta/placeholders/check.sh <files changed in the pass>`
   - `scripts/done-means/beta/decisions/check.sh docs/decisions.md`
   Red receipts are recorded as red. A beta failure is reported in the lane
   report's `deviations:` field and never absorbed.
4. **Every dispatch plan carries a loop policy.** Copy
   `docs/dispatch-plan.template.md`, fill the `## Loop policy` block so `goal`
   names a real `scripts/done-means/` check path, and require
   `scripts/done-means/beta/loop-policy/check.sh <plan.md>` to exit 0 before
   dispatch. `on_exhaust` is mandatory and may never say retry.
5. **Known pilot gaps, both recorded in `beta-receipts.md`.**
   `ratchet-bound` reports `live=0` against this repo's Tightenings because it
   counts `- **YYYY-MM-DD` entries and this contract groups them under
   `### YYYY-MM-DD (round N)` headings — a vacuous pass, not a real one, so do
   not read its 0 as evidence until the parser or the format is reconciled.
   `brief-pack` exits 3 here because it requires a `## Lane report schema`
   heading this contract spells `## Required lane report format`. Both fixes
   belong upstream in the Development canon.
