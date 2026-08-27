# Dispatch plan — open-brain engagement

Status: PROPOSED. Copy this file per engagement; do not edit it in place.

Graph Mode v1.3-beta, opted in 2026-08-27 (pilot). Every dispatch plan in this
repo carries the `## Loop policy` block below, validated with
`scripts/done-means/beta/loop-policy/check.sh <plan.md>` before dispatch.

## Objective

One paragraph: what this engagement changes in open-brain, and for whom
(server, client runtime, downstream MCP consumers, the operator).

## Lanes

- lane-a — one bounded deliverable, one PR. Non-goals: the serving tree, the
  contract fixtures, anything not named in the deliverable.
- lane-b — one bounded deliverable, one PR. Non-goals: lane-a's files.

Lane tiering is `docs/lane-contract.md` (FAST LANE / STANDARD). Escalation is
one-way and loud.

## Loop policy

<!-- Schema and field meanings: scripts/done-means/beta/loop-policy/templates/loop-policy.md
     Validate with: scripts/done-means/beta/loop-policy/check.sh <this-file>
     on_exhaust is mandatory, non-empty, and may never say "retry". -->

```yaml
goal: scripts/done-means/563-bounded-recall.sh exits 0 when a budgetless durable_memory request answers as a bounded burst plus a pointer pool
deadline_minutes: 60
budget_tokens: 250000
max_turns: 5
no_progress:
  metric: done-means RED streak
  window: 3
on_goal: commit, PR, harvest into docs/lane-contract.md Tightenings
on_exhaust: park — open a decisions-pass item in docs/issue-graph.md with the last RED output, leave the worktree named in the report, then emit "ABANDONED: 563-bounded-recall blocked"
priority:
  - goal
  - deadline
  - budget
  - max_turns
  - no_progress
```

Replace `goal` with the engagement's own covering check under
`scripts/done-means/`. The goal must name a real check path that exists.

## Done-means

| check | proves |
| --- | --- |
| `scripts/done-means/563-bounded-recall.sh` | a broad durable_memory request is answerable only as a bounded burst plus pointers, never one whole-corpus payload |

## Harvest

What gets written back on success: the `docs/lane-contract.md` Tightenings
entry with provenance, any `docs/GOTCHAS.md` line, any new
`scripts/done-means/` check, and the SME entry under `docs/sme/entries/`.
