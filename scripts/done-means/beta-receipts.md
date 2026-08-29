# Graph Mode v1.3-beta — pilot receipts (open-brain)

Opted in 2026-08-27. Every beta check run against this repo's REAL artifacts,
red or green, nothing hidden. Exit grammar: `0` pass, `1` the thing under test
failed, `3` harness error.

Executables run from the Development canon path
(`/Volumes/ThunderBolt/Development/_ob/skills/graph-mode/beta/`) and are never
copied into this repo (Rico ruling 2026-08-27). Rows below that name a
`scripts/done-means/beta/` path are history: they record runs made against the
vendored copy that existed on 2026-08-27, before it was removed.

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

## Run receipts, 2026-08-27 (cutover to canon, PRs #925-#927)

Checks run from the Development canon path, never a copy. The ratchet rows
walk the graduation sequence: the same check, the same file, three landings.
Exit codes captured with `rc=$?` on its own line.

| # | command | exit | last line |
|---|---|---|---|
| 1 | `ratchet-bound/check.sh docs/lane-contract.md` at `125d3522` | **1** | `live=45 graduated=0 bound=15 source=default shape=heading` |
| 2 | `ratchet-bound/check.sh docs/lane-contract.md` after #926 | **1** | `live=29 graduated=16 bound=15 source=default shape=heading` |
| 3 | `ratchet-bound/check.sh docs/lane-contract.md` after #927 | **1** | `live=13 graduated=32 bound=15 source=default shape=heading`, plus 13 `FAIL provenance` lines (rounds 27-38) |
| 4 | `ratchet-bound/check.sh docs/lane-contract.md` after this pull request | 0 | `live=13 graduated=32 bound=15 source=default shape=heading` |
| 5 | `brief-pack/pack.sh` on the State 3 get-entry task at `125d3522` | **1** | `OVER BUDGET: 10821 > 8000`, with `Tightenings (ranked)` at 8129 |
| 6 | `brief-pack/pack.sh --task <the same get-entry task> --lane-contract docs/lane-contract.md --done-means scripts/done-means/878-pg-tests-require-database.sh --out <scratch>` re-run on this branch | **1** | `OVER BUDGET: 10162 > 8000`, with `Tightenings (ranked)` at 7486 |
| 7 | `lane-report/check.sh` on lane-2's real report (#925) | **1** | `FAIL claim-states: disallowed state word(s): PR` |
| 8 | `lane-report/check.sh` on lane-3's real report (#926) | **1** | `FAIL claim-states: disallowed state word(s): PR` |
| 9 | `lane-report/check.sh` on lane-3's real report (#927) | **1** | `FAIL trailing-content: line 1` (a line before `deliverable:`) |

## Pilot findings

- **The `claim-states` uppercase scan reads `PR` as a state word.** Two of
  three real lane reports tripped it on rows 7 and 8, on a correct field that
  merely cited a pull request. The lane brief now says "pull request #n" so a
  report can name its own artifact; the canon README already names this clause
  as the one to loosen.
- **`brief-pack` refused the first real brief because the Tightenings section
  alone was 8129 tokens**, which is what forced the graduation of 32 rounds
  across #926 and #927. Row 6 shows the same task re-packed on this branch at
  7486 for that section and 10162 overall — still a refusal, and still the
  right one. The pilot exit criterion "an `OVER BUDGET` refusal that led to a
  smaller lane" is met with these numbers.
- **`ratchet-bound` tripped and 32 entries graduated.** Rows 1 through 4 are
  the whole arc: 45 live and nothing graduated, then 29, then 13 with the
  provenance gap exposed, then green. Exit criterion met.
- **Three lane reports failed `lane-report` and were recorded, not sent back.**
  Their pull requests were already verified by verify-lane, so re-running the
  lanes would have proved nothing the merge pass had not already proved. The
  failures are rows 7 through 9 rather than a silent pass.

## Run receipts, 2026-08-27 (session-9 merge pass, PRs #929-#935)

| # | command | exit | last line |
|---|---------|------|-----------|
| 1 | `ratchet-bound/check.sh docs/lane-contract.md` (head, before round 39) | 0 | `live=13 graduated=32 bound=15 source=default shape=heading` |
| 2 | `ratchet-bound/check.sh docs/lane-contract.md` (scribe, after round 39) | 0 | `live=14 graduated=32 bound=15 source=default shape=heading` |
| 3 | `placeholders/check.sh docs/lane-contract.md` | 0 | `PASS: no unresolved placeholders` |
| 4 | `placeholders/check.sh scripts/done-means/916-sanitize-scan-growth-shape.sh` | 0 | `PASS: no unresolved placeholders` |
| 5 | `placeholders/check.sh docs/decisions.md` | 0 | `PASS: no unresolved placeholders` |
| 6 | `decisions/check.sh docs/decisions.md` | 0 | `ok: docs/decisions.md — 4 rows, 0 failures` |
| 7 | `brief-pack/pack.sh --task task-get-entry.txt ... ` (default rounds) | 1 | `OVER BUDGET: 12418 > 8000` |
| 8 | `brief-pack/pack.sh ... --max-tightenings 2` | 0 | wrote `brief-receipt-probe.md` (excluded-rounds listing) |
| 9 | `lane-report/check.sh reports/lane-2-878-026-phase2.txt` | 1 | `FAIL claim-states: disallowed state word(s): CI` |
| 10 | `lane-report/check.sh reports/lane-rebase-935.txt` | 1 | `FAIL trailing-content: line 1: RESULTS` (also `FAIL field-set`) |

Row 7 was observed by the session-9 head at `OVER BUDGET: 10855 > 8000` before
round 39 existed. The scribe re-ran it after inserting round 39 and observed
`12418 > 8000` — the same refusal, larger because the contract grew by this
harvest. Both numbers are recorded rather than one overwriting the other.

## Pilot findings, session 9

- **The `lane-report` checker's word list treats `CI` as a state word.** The
  026 phase-2 report (#933) carried `CI` inside a `verified:` line describing a
  real check run and failed `claim-states` on it. The report was accepted with
  the false positive recorded here rather than sent back. Decisions row 4.
- **Rebase lanes report in a `RESULTS` block that the five-field checker
  refuses.** `lane-rebase-935.txt` fails both `field-set` and
  `trailing-content` because the git lane script emits `RESULTS` by design, not
  the five-field format. Whether rebase lanes adopt the five-field shape is
  open. Decisions row 4.

## Run receipts, 2026-08-27 (session-10 merge pass, PRs #939-#944)

| # | command | exit | last line |
|---|---------|------|-----------|
| 1a | `ratchet-bound/check.sh docs/lane-contract.md` (BEFORE round 40) | 0 | `live=14 graduated=32 bound=15 source=default shape=heading` |
| 1b | `ratchet-bound/check.sh docs/lane-contract.md` (AFTER round 40) | 0 | `live=15 graduated=32 bound=15 source=default shape=heading` |
| 2 | `placeholders/check.sh docs/lane-contract.md` | 0 | `PASS: no unresolved placeholders` |
| 3 | `placeholders/check.sh docs/decisions.md` | 0 | `PASS: no unresolved placeholders` |
| 4 | `placeholders/check.sh scripts/done-means/827-tier-lane-denied-warn-pinned.sh` | 3 | `HARNESS ERROR: file does not exist: scripts/done-means/827-tier-lane-denied-warn-pinned.sh` |
| 5 | `decisions/check.sh docs/decisions.md` | 0 | `ok: docs/decisions.md — 5 rows, 0 failures` |
| 6 | `brief-pack/pack.sh ... --done-means 878-pg-tests-require-database.sh` (default rounds) | 1 | `header                           26` |
| 7 | same, `--max-tightenings 2` | 0 | `- 2026-08-08 ### 2026-08-08 (later) — harvest of the #614 lane (PR #623) and its ruling  - **` |
| 8 | `lane-report/check.sh reports/lane-3-embedding-repair-attempt1.txt` | 1 | `lane report invalid: 1 failure(s)` |
| 9 | `lane-report/check.sh reports/lane-4-backup-restore-phase3.txt` | 1 | `lane report invalid: 2 failure(s)` |
| 10 | `lane-report/check.sh reports/rebase-944.txt` | 1 | `lane report invalid: 2 failure(s)` |

## Pilot findings, session 10

- **`lane-report/check.sh` validates shape, not truth — row 9 confirms it in the
  sharpest form available.** The phase-3 report's `claim-states` labels
  pull request #944 MERGED while the pull request is OPEN on the forge
  (`gh pr view 944 --json state` → `OPEN`, head `e75b6428`). The checker did not
  notice. Its two failures are `trailing-content` (line 1 of the teardown prose)
  and `claim-states: disallowed state word(s): CI` — the same false positive
  recorded in session 9 as decisions row 4. A report can therefore carry a
  factually wrong state label and fail for two unrelated reasons, or pass
  outright. Nothing in the beta reads the forge.
- **Default brief-pack rounds still refuse a conversion brief.** Row 6 exits 1 on
  the #878 conversion brief at the default eight Tightenings rounds; row 7 with
  `--max-tightenings 2` exits 0. Round 40 landing makes the default one round
  larger, not smaller, so the refusal recorded as decisions row 3 is unchanged
  and the knob remains the only path. Decisions row 3 stays OPEN.
- **The trailing-content refusal on a rebase-lane report reproduced (row 10).**
  `rebase-944.txt` fails `field-set` (found `<none>`) and `trailing-content`
  because the git lane script emits a `RESULTS` block by design, as the head
  expected from session 9. Decisions row 4.
- **Row 4 is a harness error, not a check failure.**
  `scripts/done-means/827-tier-lane-denied-warn-pinned.sh` does not exist on
  `docs/pg-tests-session10`: PR #943 merged to `origin/main`, and this branch is
  stacked on `docs/pg-tests-session9`, which was cut before it. Exit 3 is the
  placeholders harness reporting a missing subject. Announced rather than
  substituted with another path.

## Run receipts, 2026-08-27 (session-11 merge pass, PRs #947-#950)

| # | command | exit | last line |
|---|---|---|---|
| 1 | `ratchet-bound/check.sh docs/lane-contract.md` (BEFORE round 41) | 0 | `live=15 graduated=32 bound=15 source=default shape=heading` |
| 2 | `ratchet-bound/check.sh docs/lane-contract.md` (AFTER round 41) | **1** (head re-run; the lane recorded 0) | `live=16 graduated=32 bound=15 source=default shape=heading` |
| 3 | `placeholders/check.sh docs/lane-contract.md` | 0 | `PASS: no unresolved placeholders` |
| 4 | `placeholders/check.sh` on `origin/main:scripts/done-means/878-pg-tests-require-database.sh` | 0 | `PASS: no unresolved placeholders` |
| 5 | `decisions/check.sh docs/decisions.md` | 0 | `ok: docs/decisions.md — 5 rows, 0 failures` |
| 6 | `lane-report/check.sh reports/lane-1-lane-upsert.txt` | 1 | `lane report invalid: 1 failure(s)` |
| 7 | `lane-report/check.sh reports/lane-2-relational-retrieval.txt` | 1 | `lane report invalid: 1 failure(s)` |
| 8 | `lane-report/check.sh reports/lane-3-sdk-protocol.txt` | 1 | `lane report invalid: 1 failure(s)` |
| 9 | `lane-report/check.sh reports/lane-4-plan.txt` | 1 | `lane report invalid: 1 failure(s)` |
| 10 | `lane-report/check.sh reports/lane-5-945-clause2.txt` | 1 | `lane report invalid: 1 failure(s)` |

## Pilot findings, session 11

- **Row 2 is a corrected receipt.** The scribe lane recorded exit 0 for the AFTER run; the head re-ran the same command on the committed tree and got exit 1, `live=16` over the rule value 15. Round 41 landed without a graduation, so the ratchet is red until one of the sixteen live rounds graduates its bullets into SME entries. Graduation is the controller's with Rico (receipts line 69); decisions row 6.

- **The ratchet valve moved by exactly one and the bound held.** Rows 1 and 2
  bracket the round-41 insert: live 15 → 16 against the default bound of 15 with
  graduated steady at 32, exit 0 both times. The bound is a graduation valve on
  live rounds, so a single added round is what the ratchet expects to see.
- **The ratchet counts round HEADINGS, and it caught a duplicated insert.** A
  first insert attempt reported an error from `sed` after having already written
  its block, and the retry produced two identical `### 2026-08-27 (round 41)`
  headings. The check read `live=17` and exited 1 with
  `FAIL bound: 17 live > 15`. Announced rather than worked around: the file was
  restored with `git checkout docs/lane-contract.md` and re-inserted once, with
  the heading count verified at 48 (from 47) before re-running. The failing run
  is not in the table because it was a run against a file state that no longer
  exists; it is recorded here instead.
- **All five lane-report rows refuse for the SAME single reason, and it is the
  expected one.** Every one exits 1 on `field-set`: the checker expects
  `[deliverable, claim-states, verified, deviations, lessons]` in order and the
  files carry only `[deliverable, lessons]` (rows 6, 9) or
  `[deliverable, deviations, lessons]` (rows 7, 8, 10). These five files are
  head-condensed excerpts of the real lane reports, not the reports the lanes
  emitted, so the refusal is a property of the input and not evidence about
  lane compliance. Unlike session 9 and 10, no row failed `trailing-content` and
  no row tripped the `claim-states` state-word false positive.
- **The placeholders check passes on a done-means script taken from
  `origin/main`.** Row 4 ran against the merged content of the file PR #947
  changed, extracted with `git show origin/main:<path>`. Session 10 recorded row
  4 as a harness error (exit 3) because the subject did not exist on the branch;
  extracting from `origin/main` is what makes the same class of row a real
  check run instead of a missing-subject report.
- **Decisions row count is unchanged at 5.** No new decision row was added this
  session, and row 5 exits 0 with 0 failures.

## Run receipts, 2026-08-28 (decisions rows 3-6 ratified)

Rico's rulings of 2026-08-28 ("yes to all") moved `docs/decisions.md` rows 3, 4,
5 and 6 from OPEN to RATIFIED, graduated round 27 of `docs/lane-contract.md`
into one gotcha-agent SME entry, and appended the row-3 ratification to
`docs/controller-contract.md` item 1.

| # | command | exit | last line |
|---|---------|------|-----------|
| 1 | `decisions/check.sh docs/decisions.md` | 0 | `ok: docs/decisions.md — 6 rows, 0 failures` |
| 2 | `bun run scripts/build-sme-indexes.ts` | 0 | `wrote docs/sme/gotcha-agent.md (57 entries)` |
| 3 | `ratchet-bound/check.sh docs/lane-contract.md` | 0 | `live=15 graduated=33 bound=15 source=default shape=heading` |
| 4 | `placeholders/check.sh docs/controller-contract.md docs/decisions.md docs/lane-contract.md` | 0 | `PASS: no unresolved placeholders` |

- **Row 1 first ran red on `retire-without-check`.** Row 5's Retires column was
  filled with `the OPENBRAIN_BACKUP_DRILL toggle`, and the check requires a
  Retires value to name a changed path. The brief said the Retires column stays
  as it was — empty — so the column was returned to empty and row 1 re-ran at
  exit 0. Announced, not silent.
- **Round 27 graduation takes live from 16 back to 15.** Row 3 reports
  `live=15 graduated=33` against the default rule value of 15, which is the
  state decisions row 6 was ratified to produce.

## Run receipts, 2026-08-28 (session-12 merge pass, PRs #956 and #957)

Every command below was run by the tracking-scribe lane in the root checkout on
`docs/pg-tests-session12`, with the exit read directly from the command rather
than through a pipeline.

| # | command | exit | last line |
|---|---------|------|-----------|
| 1 | `ratchet-bound/check.sh docs/lane-contract.md` (BEFORE round 42) | 0 | `live=15 graduated=33 bound=15 source=default shape=heading` |
| 2 | `ratchet-bound/check.sh docs/lane-contract.md` (AFTER round 42) | 1 | `live=16 graduated=33 bound=15 source=default shape=heading` |
| 3 | `placeholders/check.sh docs/lane-contract.md` | 0 | `PASS: no unresolved placeholders` |
| 4 | `decisions/check.sh docs/decisions.md` | 0 | `ok: docs/decisions.md — 6 rows, 0 failures` |
| 5 | `lane-report/check.sh .../reports/951-attempt1.md` | 0 | `lane report valid: 5 fields, all clauses passed` |
| 6 | `lane-report/check.sh .../reports/951-attempt2.md` | 0 | `lane report valid: 5 fields, all clauses passed` |
| 7 | `lane-report/check.sh .../reports/step1.md` | 0 | `lane report valid: 5 fields, all clauses passed` |
| 8 | `lane-report/check.sh .../reports/step2.md` | 0 | `lane report valid: 5 fields, all clauses passed` |
| 9 | `lane-report/check.sh .../reports/step3.md` | 0 | `lane report valid: 5 fields, all clauses passed` |
| 10 | `lane-report/check.sh .../reports/step4.md` | 0 | `lane report valid: 5 fields, all clauses passed` |
| 11 | `lane-report/check.sh .../reports/step5.md` | 0 | `lane report valid: 5 fields, all clauses passed` |
| 12 | `lane-report/check.sh .../reports/step6.md` | 0 | `lane report valid: 5 fields, all clauses passed` |
| 13 | `lane-report/check.sh .../reports/step7.md` | 0 | `lane report valid: 5 fields, all clauses passed` |
| 14 | `lane-report/check.sh .../reports/step8.md` | 0 | `lane report valid: 5 fields, all clauses passed` |
| 15 | `bun run scripts/build-sme-indexes.ts` | 0 | `wrote docs/sme/gotcha-agent.md (58 entries)` |
| 16 | `bun run scripts/sync-issues.ts` | 0 | `406 issues (108 open, 298 closed), 604 comments, 298 with a Resolution -> _plans/issues/` |
| 17 | `bun run scripts/stale-blockers.ts` | 0 | `35 open issue(s) reference only closed work — verify each against live state before closing.` |

## Pilot findings, session 12

- **Row 2 is the expected state, recorded rather than repaired.** Round 42 takes
  the Tightenings rounds from 15 to 16 against the default rule value of 15, so
  `ratchet-bound` exits 1 the moment a harvest lands. Graduating a round to
  restore the count is Rico's call (decisions row 6), not a scribe adjustment,
  so the failing exit stands in the record. Rows 1 and 2 exist as a pair for
  exactly this reason: the before run proves the failure is the harvest's doing
  and not inherited.
- **A piped `| tail` hides the exit of the command that produced it.** The first
  attempt at rows 1-4 read `rc=$?` after `check.sh ... | tail -3` and reported
  the ratchet AFTER run as exit 0 when the check had exited 1 — `$?` belonged to
  `tail`. Every row above was re-taken with the output captured into a variable
  and the exit read from the check itself. This is round 27's PIPESTATUS lesson
  surfacing in a new spelling.
- **The ten lane-report checks all passed, against the brief's expectation.**
  The brief predicted field-set refusals because these files are head-condensed
  excerpts rather than raw lane returns; the condensation preserved all five
  required fields, so every file validated. Recorded as written rather than
  reshaped to match the prediction.
- **`decisions/check.sh` reports 6 rows, 0 failures with no new row this
  session**, which is the state the brief called for.
- **`sync-issues.ts` rendered 298 Resolutions across 406 issues**, and the
  stale-blocker pass surfaced 35 candidates. Both are reported to the
  controller; nothing was closed.

## Run receipts, 2026-08-29 (session-13 merge pass, PRs #964, #963, #961)

Every command below was run by the tracking-scribe lane in the root checkout on
`docs/pg-tests-session13`, with the exit read directly from the command rather
than through a pipeline.

| # | command | exit | last line |
|---|---|---|---|
| 1 | `ratchet-bound/check.sh docs/lane-contract.md` (BEFORE round 43) | 1 | `live=16 graduated=33 bound=15 source=default shape=heading` |
| 2 | `ratchet-bound/check.sh docs/lane-contract.md` (AFTER round 43) | 1 | `live=17 graduated=33 bound=15 source=default shape=heading` |
| 3 | `placeholders/check.sh docs/lane-contract.md _DOCS/_handover/2026-08-28-pg-tests-session13.md scripts/done-means/878-program-complete.sh scripts/done-means/962-growth-scan-allowance.sh` | 1 | `FAIL: 2 unresolved placeholder hit(s)` |
| 4 | `decisions/check.sh docs/decisions.md` | 0 | `ok: docs/decisions.md — 6 rows, 0 failures` |
| 5 | `lane-report/check.sh .../reports/878-program-check.md` | 1 | `lane report invalid: 2 failure(s)` |
| 6 | `lane-report/check.sh .../reports/924-diagnosis.md` | 1 | `lane report invalid: 2 failure(s)` |
| 7 | `lane-report/check.sh .../reports/962-allowance.md` | 1 | `lane report invalid: 2 failure(s)` |
| 8 | `bun run scripts/build-sme-indexes.ts` | 0 | `wrote docs/sme/gotcha-agent.md (59 entries)` |
| 9 | `bun run scripts/sync-issues.ts` | 0 | `Now run: qmd update -c open-brain && qmd embed` |
| 10 | `bun run scripts/stale-blockers.ts` | 0 | `38 open issue(s) reference only closed work — verify each against live state before closing.` |

## Pilot findings, session 13

- **The ratchet AFTER run exiting 1 is the recorded state, not a defect.** Live
  rose 16 → 17 with round 43; graduation is Rico's call (decisions row 6), so
  the lane records the red exit and does not reduce the file to satisfy it.
- **Both placeholder hits are the same false positive.** Row 3's two hits are
  `docs/lane-contract.md:100` and
  `_DOCS/_handover/2026-08-28-pg-tests-session13.md:81`, and both are the
  literal quoted command form `aqmd in <repo>` — the documented shape of the
  command from #965, not an unfilled placeholder. The red exit is recorded as
  red rather than suppressed; the checker cannot distinguish a quoted command
  argument from a template slot. The lane-contract hit is the round 43 bullet
  this same run added, so the count moved 1 → 2 as a direct result of the
  harvest.
- **All three lane-report checks refused, against session 12's result.** Each
  failed `trailing-content` with 2 failures. These files are head-condensed
  excerpts of the lane returns, and the condensation collapsed the report onto
  lines the checker reads as content past the field block. Recorded as observed;
  the previous session's ten files passed the same check, so this is a property
  of this session's condensation, not a checker change.
- **`decisions/check.sh` reports 6 rows, 0 failures with no new row this
  session**, which is the state the brief called for.
- **`sync-issues.ts` rendered 300 Resolutions across 408 issues**, and the
  stale-blocker pass surfaced 38 candidates. Both are reported to the
  controller; nothing was closed.
