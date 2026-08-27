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
  angle-bracket `lane` and `path` tokens inside command examples the lane contract deliberately
  shows as templates (lines 72, 201, 351, 352, 1392). Not fixed by this lane:
  the placeholders check has an `--allow <tok>` flag, and whether to allow
  those two tokens here or rewrite the examples is a decisions-pass call, not
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

## Run receipts, 2026-08-27 (resync to 6bfc3e3f)

Beta checks resynced from Development canon `3d1a45a0` to `6bfc3e3f` (four fix
commits driven by the receipts above). Same repo artifacts, same exit grammar.
Exit codes captured with `rc=$?` on its own line; the brief-pack runs redirect
stdout and stderr to files so no pipe swallows the status.

| # | command | exit | last line |
|---|---|---|---|
| 1 | `scripts/done-means/beta/ratchet-bound/check.sh docs/lane-contract.md` | **1** | `live=45 graduated=0 bound=15 source=default shape=heading` |
| 2 | `scripts/done-means/beta/placeholders/check.sh docs/lane-contract.md` | 0 | `PASS: no unresolved placeholders` |
| 3 | `scripts/done-means/beta/placeholders/check.sh docs/controller-contract.md` | 0 | `PASS: no unresolved placeholders` |
| 4 | `scripts/done-means/beta/placeholders/check.sh docs/issue-graph.md` | 0 | `PASS: no unresolved placeholders` |
| 5 | `scripts/done-means/beta/placeholders/check.sh docs/decisions.md` | 0 | `PASS: no unresolved placeholders` |
| 6 | `scripts/done-means/beta/placeholders/check.sh docs/dispatch-plan.template.md` | 0 | `PASS: no unresolved placeholders` |
| 7 | `scripts/done-means/beta/placeholders/check.sh scripts/done-means/beta/PROVENANCE.md` | 0 | `PASS: no unresolved placeholders` |
| 8 | `scripts/done-means/beta/decisions/check.sh docs/issue-graph.md --section '## Ledger'` | **1** | `FAIL schema row 281: judged the table at line 281 (selected via section) with header [# \| Item \| State \| Resolution] ... needs MIGRATION` |
| 9 | `scripts/done-means/beta/decisions/check.sh docs/issue-graph.md` | **1** | `FAIL schema row 281: judged the table at line 281 (selected via hash-column) with header [# \| Item \| State \| Resolution] ... needs MIGRATION` |
| 10 | `scripts/done-means/beta/decisions/check.sh docs/decisions.md` | 0 | `ok: docs/decisions.md — 1 rows, 0 failures` |
| 11 | `scripts/done-means/beta/loop-policy/check.sh docs/dispatch-plan.template.md` | 0 | (no output) |
| 12 | `scripts/done-means/beta/brief-pack/pack.sh --task <2-line task> --lane-contract docs/lane-contract.md --done-means scripts/done-means/563-bounded-recall.sh` (NO `--controller-contract`) | **1** | `OVER BUDGET: 9498 > 8000` |
| 13 | same as #12 plus `--max-tightenings 3` | 0 | `budget: 5081/8000 tokens (ceil chars/4) \| report-format: ## Required lane report format` |

Table-selection first lines, receipts 8-10:

- #8 `table: line 281 via section`
- #9 `table: line 281 via hash-column`
- #10 `table: line 27 via hash-column`

Receipt 12's OVER BUDGET table, verbatim from stderr (stdout was empty and no
brief was written):

```
OVER BUDGET: 9498 > 8000
section                          tokens
Task                             36
Done-means                       869
Standing rules                   22
Tightenings (ranked)             7416
Report format                    250
Excluded (available on request)  879
header                           26
```

Receipt 13 ranked three heading-shaped entries rather than reporting `(none)`:
rounds 31 (`2026-08-17`), 34 (`2026-08-26`) and 29 (`2026-08-10`). stderr empty.

### Heading count: 45 here, 42 in the receipts above

The inventory line above records "42 `### YYYY-MM-DD (round N)` headings, 263
bullet entries"; `ratchet-bound` now reports `live=45`. The difference is
counted, not guessed. Reading the `awk` in `ratchet-bound/check.sh`: an entry
opens on `^### +[0-9]{4}-[0-9]{2}-[0-9]{2}`, i.e. any level-3 date heading,
with free text after the date. It does not require the `(round N)` suffix.

- `rg -c '^### +[0-9]{4}-[0-9]{2}-[0-9]{2}' docs/lane-contract.md` -> **45**
- `rg -c '^### [0-9]{4}-[0-9]{2}-[0-9]{2} \(round' docs/lane-contract.md` -> **41**

The four date headings the earlier `(round N)` count did not include, by line:

- 1564 `### 2026-08-08 (latest) — harvest of the #612 lane (PR #624)`
- 1591 `### 2026-08-08 (later) — harvest of the #614 lane (PR #623) and its ruling`
- 1608 `### 2026-08-08 — harvest of the tooling + fixture lanes (PRs #615, #616, #617, #619, #620, #621)`
- 1652 `### 2026-08-07 — founding round (PRs #609, #610, #611 and the decisions pass)`

41 + 4 = 45. (`### 2026-08-08 (round 10b, lane-authored)` at line 1400 does
carry `(round`, so it is inside the 41 and inside the 45.) The remaining gap to
the inventory's 42 is that the earlier figure was a `(round N)` count plus one;
the parser's unit is the date heading, and 45 is the number of those. The
section runs from line 89 to EOF (1666) with no following `##` heading, so
nothing is truncated by the section boundary. Bullets inside the section:
`rg -c '^- '` -> 267, none of them `- **YYYY-MM-DD` shaped, so the parser
counts headings and not bullets — `shape=heading`, as reported.

### Gates

| gate | command | exit | note |
|---|---|---|---|
| pr-template validator | `bash scripts/done-means/pr-template-passes-validator.sh` | 0 | all three clauses PASS |
| touched-files lint | `bash scripts/done-means/780-touched-files-lint-clean.sh` | **1** | `FAIL: missing lint binary ./node_modules/.bin/oxlint` — `node_modules/` does not exist in this scratch clone; the gate fails closed on the environment, not on this lane's content. Verified absent with `ls node_modules`. This lane changes only `.md`, `.sh` and vendored `.ts` under the prettier/lint-ignored `scripts/done-means/beta/` tree. |
| placeholders on this lane's own files | `scripts/done-means/beta/placeholders/check.sh scripts/done-means/beta-receipts.md scripts/done-means/beta/PROVENANCE.md` | 0 | `PASS: no unresolved placeholders` |

`npx prettier --check` reports style issues in `scripts/done-means/beta-receipts.md`
and `docs/dispatch-plan.template.md`, but this is **pre-existing and not this
lane's**: the same check against the committed `HEAD` copies of both files
(extracted with `git show HEAD:<path>`) reports the identical two warnings, and
both files were unmodified in the working tree at the time of that run.
`prettier` is also not a script in this repo's `package.json`. Recorded as an
observation, not a gate result; not fixed here, because reformatting a file this
lane did not restyle would bury the resync diff.

### Findings status

- **R1 — `ratchet-bound` passes vacuously here — CLOSED.** Canon commit
  `266f68c5` ("ratchet-bound reads heading-shaped entries, refuses vacuous
  green") added the `### YYYY-MM-DD` shape and a guard that exits 3 when a
  non-empty `## Tightenings` section yields zero recognised entries. Proven by
  receipt row 1: was `exit 0, live=0`, now `exit 1, live=45 ... shape=heading`.
  The vacuous green is gone and the check is examining the section.
  **The new red is real and stands: 45 live against a bound of 15, and all 45
  entries lack a literal `provenance:` key** (45 `FAIL provenance` lines). No
  entries are graduated by this lane — the harvest is the controller's, with
  Rico. `source=default`: the section declares no `Bounded at N live entries`
  valve, so the check fell back to the built-in 15.
- **R2 — `brief-pack` hard-requires `## Lane report schema` — CLOSED.** Canon
  commit `6bfc3e3f` discovers the heading by `/report/i`. Proven by receipt row
  13: `report-format: ## Required lane report format`, exit 0, where the earlier
  receipt row 11 was `exit 3 HARNESS ERROR`.
- **R3 — `brief-pack` defaults `--controller-contract` to a Development-shaped
  path — CLOSED.** Same canon commit `6bfc3e3f`; the default is now an ordered
  candidate list starting beside the lane contract. Proven by receipts 12 and
  13, both run with **no** `--controller-contract` flag: neither exits 3 for a
  missing contract, and 13 resolves `docs/controller-contract.md` beside
  `docs/lane-contract.md` and packs.
- **R4 — `lane-report` is N/A for this repo's eleven-field lane reports — still
  OPEN, unchanged.** No canon commit addressed it and none was asked to;
  reconciling the eleven-field repo schema against the beta's five is a
  decisions-pass item, not a lane's. The beta checker is still exercised against
  this lane's own five-field report
  (`scripts/done-means/beta-lane-report-resync.txt`, uncommitted).
- **Receipt-2 red (five `<path>`/`<lane>` hits in the lane contract) — CLOSED.**
  Canon commit `faa18017` dropped `<path>` and `<lane>` from the default token
  list. Proven by receipt row 2: `exit 1, FAIL: 5 unresolved placeholder hit(s)`
  became `exit 0, PASS`.
- **Receipt-9 red (doctor judged the prose table at line 52) — CLOSED as a
  defect; the migration red it was masking remains OPEN and correct.** Canon
  commit `65d5ef67` made table selection ordered and prints the selected table.
  Proven by receipt rows 8 and 9: both now report `table: line 281` — the real
  `## Ledger` table — instead of line 52, by either selection rule. Both still
  exit 1, which is the right verdict: the live ledger is a four-column
  `# | Item | State | Resolution` table and genuinely needs migration to the
  nine columns. `docs/decisions.md`, the forward nine-column ledger, still
  passes (row 10).
