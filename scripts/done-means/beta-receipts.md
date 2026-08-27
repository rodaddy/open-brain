# Graph Mode v1.3-beta — pilot receipts (open-brain)

Opted in 2026-08-27. Every beta check run against this repo's REAL artifacts,
red or green, nothing hidden. Exit grammar: `0` pass, `1` the thing under test
failed, `3` harness error.

Nothing here is hook-wired, merge-gated, or in CI. The controller appends to
this file at every merge pass (`docs/controller-contract.md`, "Graph Mode
v1.3-beta").

## Inventory (read-only, 2026-08-27)

| thing | value |
|---|---|
| lane contract | `docs/lane-contract.md`, 1396 lines, FAST LANE / STANDARD tiers |
| Tightenings | 42 `### YYYY-MM-DD (round N)` headings, 263 bullet entries; the beta parser counts 0 (see R1) |
| controller contract | `docs/controller-contract.md`, 113 lines |
| lane report schema | 11 fields: `self-reported model, branch, pr, red, green, root-cause, deviations, refusals-and-violations, teardown, claim-states, lessons` |
| decisions ledger candidates | `docs/issue-graph.md` `## Ledger` (LIVE — most recently edited 2026-08-17, and the one the controller contract cites as "ledger item N"); `specs/ob-first-class-memory/DECISIONS.md` (2026-07-21, spec-scoped); `_plans/front-of-mind-decisions.md` (2026-08-01, plan-scoped); `docs/decisions/` (long-form rationale records, not a ledger) |
| dispatch-plan template | **ABSENT** before this lane; added as `docs/dispatch-plan.template.md` |
| done-means dir | `scripts/done-means/`, 90 files, exit grammar 0/1/3 |

## Run receipts, 2026-08-27

| # | command | exit | last line |
|---|---|---|---|
| 1 | `scripts/done-means/beta/ratchet-bound/check.sh docs/lane-contract.md` | 0 | `live=0 graduated=0 bound=15 source=default` |
| 2 | `scripts/done-means/beta/placeholders/check.sh docs/lane-contract.md` | **1** | `FAIL: 5 unresolved placeholder hit(s)` |
| 3 | `scripts/done-means/beta/placeholders/check.sh docs/controller-contract.md` | 0 | `PASS: no unresolved placeholders` |
| 4 | `scripts/done-means/beta/placeholders/check.sh docs/issue-graph.md` | 0 | `PASS: no unresolved placeholders` |
| 5 | `scripts/done-means/beta/placeholders/check.sh docs/decisions.md` | 0 | `PASS: no unresolved placeholders` |
| 6 | `scripts/done-means/beta/placeholders/check.sh docs/dispatch-plan.template.md` | 0 | `PASS: no unresolved placeholders` |
| 7 | `scripts/done-means/beta/placeholders/check.sh scripts/done-means/beta/PROVENANCE.md` | 0 | `PASS: no unresolved placeholders` |
| 8 | `scripts/done-means/beta/decisions/check.sh docs/decisions.md` | 0 | `ok: docs/decisions.md — 1 rows, 0 failures` |
| 9 | `scripts/done-means/beta/decisions/check.sh docs/issue-graph.md` | **1** | `FAIL schema row 52: header is [Flagged \| What it actually was] but v1.3-beta requires the nine columns ...; this ledger needs MIGRATION` |
| 10 | `scripts/done-means/beta/loop-policy/check.sh docs/dispatch-plan.template.md` | 0 | (no output) |
| 11 | `scripts/done-means/beta/brief-pack/pack.sh --task <2-line task> --lane-contract docs/lane-contract.md --controller-contract docs/controller-contract.md --done-means scripts/done-means/563-bounded-recall.sh` | **3** | `HARNESS ERROR: controller contract has no "## Lane report schema" section` |

Notes on the reds:

- **#2 is a true positive against an expected shape.** The five hits are
  `<lane>` and `<path>` inside command examples the lane contract deliberately
  shows as templates (lines 72, 201, 351, 352, 1392). Not fixed by this lane:
  the placeholders check has an `--allow <tok>` flag, and whether to allow
  `<path>`/`<lane>` here or rewrite the examples is a decisions-pass call, not
  a lane's.
- **#9 is the expected migration receipt**, exactly as the amendment says
  ("that failure is the migration reminder, not a bug"). The legacy ledger is
  left untouched in content; a forward nine-column ledger is `docs/decisions.md`
  and passes (#8).
- **#11 brief-pack did not produce a brief**, so there is no token count and no
  OVER-BUDGET refusal to report from this repo yet. It exits 3 before packing.

## Pilot findings for the Development canon (improvements flow one way)

- **R1 — `ratchet-bound` passes vacuously here.** It counts entries matching
  `- **YYYY-MM-DD` and this repo groups Tightenings under
  `### YYYY-MM-DD (round N)` headings with prose-bold bullets. Live entries by
  the repo's own shape: **263 bullets across 42 rounds**, against a bound of
  15. The check reported `live=0 ... bound=15` and exited 0. A `0` that
  examined nothing is the failure the beta's own exit grammar exists to
  prevent, and it is the more dangerous direction: it reads as a green.
  Graduation is NOT done by this lane — harvest is the controller's, with Rico.
- **R2 — `brief-pack` hard-requires a `## Lane report schema` heading.** This
  repo's controller contract has spelled it `## Required lane report format`
  since 2026-08-08. The packer should accept the repo's heading (or take the
  section name as a flag) rather than exit 3.
- **R3 — `brief-pack` defaults `--controller-contract` to a Development-shaped
  path** (`_DOCS/controller-contract.md` relative to the invocation), which
  cannot exist in a repo that keeps contracts in `docs/`. Passing the flag
  explicitly works; the default should be repo-relative or required.
- **R4 — lane-report is N/A for this repo's lane reports.** The repo schema is
  eleven fields; the beta checks five. Reconciling them is a decisions-pass
  item, not something a lane forces. The beta checker was still exercised in
  this lane, against this lane's own five-field report.
