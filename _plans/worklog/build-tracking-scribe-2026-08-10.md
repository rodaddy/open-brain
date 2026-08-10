# Build the TRACKING-SCRIBE as a real agent (2026-08-10)

**Status: WRITTEN — agent definition, done-means check, and doc deltas written
to the ROOT checkout `/Volumes/ThunderBolt/Development/open-brain` and committed
on `wip/2026-08-07`. Not deployed anywhere; an agent definition is a file.**

## The gap this closes

The tracking scribe existed ONLY as a paste-in prompt the operator re-sent each
time ("TRACKING SCRIBE run for..."). Nothing on disk carried it. Two
consequences, both measured on 2026-08-09/10:

1. **The root-only rule kept getting violated.** The rule lives in
   `docs/lane-contract.md` and in the operator's messages, but the entity that
   does the graph-state writing had no definition of its own to carry it. A
   prompt that is retyped from memory drops its own guardrails; a file does
   not. The reconcile lane
   (`_plans/worklog/reconcile-root-2026-08-10.md`) measured the cost: three
   divergent copies of `docs/lane-contract.md`, no single one a superset,
   164 lines of harvest rounds stranded in worktrees and invisible to `aqmd`.
2. **The harvest step had no named owner.** `docs/sop-rlvr-lanes.md` step 5
   and `docs/controller-contract.md` obligation 2 both describe harvest as an
   inline controller action. Inline actions get absorbed by the head, which is
   the recorded failure mode of controller obligation 6.

## Scope decision (operator, 2026-08-10)

Do NOT widen `pr-scribe`. It stays narrow: render a validator-passing PR body.
Graph-state maintenance is a SEPARATE agent, `.claude/agents/tracking-scribe.md`.

## What was built

1. `.claude/agents/tracking-scribe.md` — the agent definition. Frontmatter
   matches the repo style (`name`, `description`, `model`, `effort`, `tools`),
   as read from `.claude/agents/pr-scribe.md` and `.claude/agents/verifier.md`.
   Its FIRST law is the root-only rule, with the `aqmd`-visibility WHY stated
   in the definition itself.
2. `scripts/done-means/tracking-scribe-root-only.sh` — the done-means check,
   written RED-first.
3. `docs/sop-rlvr-lanes.md` — step 5 (Harvest) and the parts table name the
   agent as the owner.
4. `docs/controller-contract.md` — obligation 2 (Harvest) delegates to the
   agent instead of describing an inline head action.
5. `docs/issue-graph.md` — ledger item 8 "Agent candidates" table gains the
   built row.

## Red-first proof

The check was written and run BEFORE `.claude/agents/tracking-scribe.md`
existed. All six clauses failed, each naming its real reason rather than
erroring out:

```text
CLAUSE 1 (tracking-scribe.md exists and is git-tracked):   FAIL — no agent definition at .claude/agents/tracking-scribe.md — the tracking scribe is still only a paste-in prompt
CLAUSE 2 (root-only law is the FIRST section):             FAIL — agent definition unreadable — no first law to check
CLAUSE 3 (root-only law states its aqmd WHY):              FAIL — agent definition unreadable — no WHY to check
CLAUSE 4 (report-and-mirror: never closes, never merges):  FAIL — agent definition unreadable — no boundary to check
CLAUSE 5 (three harvest targets named by real path):       FAIL — harvest target problem(s): (agent definition unreadable)
CLAUSE 6 (SOP names tracking-scribe as harvest owner):     FAIL — docs/sop-rlvr-lanes.md harvest ownership missing (named-anywhere: FAIL, named-in-Harvest-step: FAIL)
EXIT=1
```

GREEN after the agent, the SOP delta, and staging: **EXIT=0**, all six PASS.

An intermediate state is worth recording because it is the clause working:
with the file written but not yet staged, clause 1 read `exists on disk but git
does NOT track it — a fresh clone gets no tracking scribe`. That is the
`.gitignore` `.claude/*` trap (line 53, negated for `.claude/agents/` on line
70) that nearly ate `pr-scribe.md` on the #615 lane. `test -e` would have passed
there; tracked-by-git is the assertion that means anything.

## Mutation testing — the clauses are not vacuous

Each clause was proven able to fail independently, by mutating a copy and
restoring:

| Mutation | Clause | Result |
|---|---|---|
| Root-only law demoted below another `##` heading | 2 | FAIL — `first section is "## Some other section first"` |
| `aqmd` + invisibility wording stripped | 3 | FAIL — `missing its WHY: 'aqmd'` |
| never-close / never-merge wording softened | 4 | FAIL — `never-close: FAIL, never-merge: FAIL` |
| `tracking-scribe` removed from the SOP entirely | 6 | FAIL — both sub-conditions red |
| Name kept in the parts table, removed from the Harvest step | 6 | FAIL — `named-anywhere: PASS, named-in-Harvest-step: FAIL` |

**A defect in the check, found by its own mutation test and fixed.** The first
clause-6 window keyed on the bare word `Harvest`, and mutation D reported
`named-in-Harvest-step: PASS` while the SOP no longer contained the name at all
— the window had matched the parts-table row sitting above the step. The clause
was asserting something weaker than its label claimed. It now anchors on the
literal `**Harvest (mandatory)**` step marker, which is what makes mutation E
(decorative mention in the table, ownership gone from the step) come out red.
This is announced rather than quietly corrected: the check as first written
would have passed a repo where the gap had reopened.

Also fixed during the RED run: `$MISSING_TARGET—` and `$MISS—` parsed the
following em-dash as part of the variable name under `set -u`, aborting the
script at line 210 before it printed anything. Braced to `${MISSING_TARGET}` /
`${MISS}`. Worth noting as a general trap for these checks — an em-dash directly
after a bare `$VAR` in a double-quoted string is a runtime abort, not a cosmetic
issue, and it only fires on the failure path where the evidence string is built.

## Receipts

- Agent: `/Volumes/ThunderBolt/Development/open-brain/.claude/agents/tracking-scribe.md`
  — root-only law is the FIRST section (`## FIRST LAW — ROOT ONLY, ALWAYS`),
  carrying the `aqmd`-visibility WHY and the 2026-08-10 measurement.
- Check: `/Volumes/ThunderBolt/Development/open-brain/scripts/done-means/tracking-scribe-root-only.sh`
  — RED (exit 1, six clauses) → GREEN (exit 0, six clauses).
- Registration: `.claude/agents/` is git-tracked via the `!.claude/agents/`
  negation (`.gitignore:70`), the same mechanism that makes `pr-scribe` and
  `verifier` discoverable. Named in `docs/sop-rlvr-lanes.md` (parts table +
  its own section + step 5), `docs/controller-contract.md` (obligation 2), and
  `docs/issue-graph.md` (ledger item 8 agent-candidates table, row `built`).
- Everything above was written to the ROOT checkout. No worktree was created or
  used. Scratch copies for mutation testing went to
  `/Volumes/ThunderBolt/_tmp/open-brain/_scratch/` and are not part of the repo.

## Claim states

- Agent definition, done-means check, SOP/controller/ledger deltas: **WRITTEN**,
  committed to `wip/2026-08-07` in root.
- Done-means check red→green and the five mutation results: **RUNNING** —
  observed this session, exit codes quoted above.
- The agent itself has never been dispatched. Nothing here is evidence that it
  behaves as written; it is evidence that the definition exists, is committed,
  carries its first law, and is named as the harvest owner. **PROPOSED** until a
  real scribe run happens through it.
