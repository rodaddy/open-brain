# Handover — #878 hard test-database program, session 8 (2026-08-27)

## State 0 — BASE
Read /Volumes/ThunderBolt/Development/_DOCS/HANDOVER-BASE.md in full
(181 lines). It is the standing contract for this session.
- Any question this document does not directly override → the rules layers
  answer it, nearest layer first.
- Anything neither the base nor this document covers → ask Rico before acting.
- Output discipline: minimum verbosity, only the context needed, output tokens
  low. If Rico wants more, he will ask.
- Layer 0.1: read open-brain/_DOCS/HANDOVER-RULES.md in full (292 lines on
  this branch). It overrides the base; this document overrides it. Rules 28-42
  bind: head never works, own clones, FIVE lanes, no `rm`, no `--no-verify`,
  manifest in the same commit, hooksPath on every clone.

## State 1 — ORIENT
- `origin/main` is `23239ba6` (#890); session 7 merged #871-#890 — MERGED (`git log --oneline origin/main -1`)
- L5 cutover done: 0 `src/shared-namespace` importers in non-test `server/`;
  #860 and #868 CLOSED with receipts; ladder line 3 reads "L3 MERGED" — MERGED (#871 #873 #875-#877)
- #878 ruling (Rico, 2026-08-26): every pg test requires a real database, skip
  is a HARD FAILURE, no lint exemption for tests; pattern
  `requireTestDatabaseUrl()` in `scripts/test-support/require-test-database.ts` — MERGED (#879)
- #878 census at `aa878c4f`: 37 `*.test.ts` files still `describe.skip`; the
  list by size is the session-7 scribe comment on #878 — RUNNING (`git grep -c "describe.skip" origin/main -- '*.test.ts'`)
- Program check `scripts/done-means/878-pg-tests-require-database.sh` — MERGED (#882)
- `_githooks/pre-push` runs `bun run test:isolated` (#881); all eleven clones
  have `core.hooksPath=_githooks` — RUNNING (`git -C <clone> config core.hooksPath`)
- #764 python-capture flake CLOSED: committed fixture, done-means
  `scripts/done-means/764-real-transcript-test-selects-operator-turns.sh` — MERGED (#890 23239ba6)
- #889 maintenance lease race (`server/maintenance/maintenance.pg.test.ts:335-353`) OPEN — RUNNING (`gh issue view 889`)
- #888 Forge migration is a planning item, not a build order — RUNNING (`gh issue view 888`)
- Lane-8 clone `stash@{0}` + `_scratch/session7/lane-8-878-b2-src-tools-a.patch`:
  bulk-set-tier/decompose-entry/list-stale converted, 25 pre-existing lint findings — WRITTEN
- Reusable, temp: `/Volumes/ThunderBolt/_tmp/open-brain/_scratch/session7/{lane,recon}.workflow.js`, `collect.sh` — WRITTEN
- Mac checkout `/Volumes/ThunderBolt/Development/open-brain` is DIRTY on `sprint/standards-fmt` (Rico's); lanes never work there — RUNNING
- Graph mode: converted — RUNNING (`ls scripts/done-means/` has `878-*.sh`)
Re-probe before dispatching anything (live state beats this doc):
- `git log --oneline origin/main -1` → expect 23239ba6 or later with this PR merged
- `gh pr list --state open --json number,headRefName` → only #745 and #739 (not this program)
- `git -C /Volumes/ThunderBolt/_tmp/open-brain/_worktrees/lane-3 config core.hooksPath` → `_githooks`

## State 2 — LAND THE PAPERWORK
Branch: `docs/pg-tests-session8` from `origin/main` — cut it once THIS
document's PR merges; if the checkout is `main` or `docs/l5-session7` is
merged, switch first, never work there.
Retire: `docs/l5-session7` (this document's PR); in lane-11
`verify-lane/pr-824-*`, `pr-836-*`, `pr-845-*`, `pr-861-*`, `pr-870-*`
(merged PRs, `git branch -D`); lane-1 `fix/880-*`, lane-2 `fix/764-*`, lane-3..6,9 `chore/878-b1-*`
`chore/878-b2-src-tools-b` (merged, `git branch -d` after `git checkout main`
in that clone). Worktrees: `none`.
Commit this handover: branch `docs/l5-session7`, path
`_DOCS/_handover/2026-08-27-pg-tests-session8.md` with `_DOCS/HANDOVER-RULES.md`,
explicit-path staging, `git commit -F` message file. Done by the authoring session.
Scribe: issue #878 — started: `gh issue comment 878 --body "Scribe, session 8: ..."`
Done-check: `git log -1 --stat`

## State 3 — Batch A: five migration tests hard-fail (one file per lane)
Tier: T1 — shared test files; CI manifest changes with each
Deliverable: `src/db/migrations/{025_normalize_legacy_development_lanes,027_source_registry,028_maintenance_jobs_lease_expired_compat,029_maintenance_jobs_terminal_category,031_source_sync_runs_running_only_unique}.test.ts` use `requireTestDatabaseUrl()`, plain `describe`, whole file lint-clean, manifest updated; one PR each
Scope: the one file, `scripts/assert-db-tests-ran.ts`; own clone per lane
Must NOT: `--no-verify`; touch `src/db/migrations/*.ts` sources; convert a guard keyed on any env other than `OPENBRAIN_TEST_DATABASE_URL` (report it)
Record: PR, then #878 comment per merge
Done-check: `CHANGED_FILES=<file> bash scripts/done-means/878-pg-tests-require-database.sh` → exit 0 (RED: not yet run; the pre-edit run on the file)

## State 4 — Batch B: 032, reinforcement-and-said-at, 001_init, promote-shared, ingest-raw-turn
Tier: T1 — same blast radius as State 3
Deliverable: `src/db/migrations/{032_raw_turns,reinforcement-and-said-at,001_init}.test.ts`, `src/tools/__tests__/{promote-shared,ingest-raw-turn}.test.ts` converted as in State 3; one PR each
Scope: the one file, `scripts/assert-db-tests-ran.ts`; own clone per lane, after State 3 lanes merge (manifest conflicts)
Must NOT: as State 3; split a file that lands over 500 lines (report, it goes to the split batch)
Record: PR, then #878 comment per merge
Done-check: `CHANGED_FILES=<file> bash scripts/done-means/878-pg-tests-require-database.sh` → exit 0 (RED: not yet run; the pre-edit run on the file)

## State 5 — Batch C: contracts, scripts, live tests under 500 lines
Tier: T1 — `contracts/server-tool-parity.test.ts` composes tool deps itself (rule 33)
Deliverable: `contracts/server-tool-parity.test.ts`, `scripts/{local-clone,retire-collab-migration}.test.ts`, `src/maintenance-sweep.live.test.ts`, `src/tools/__tests__/session-wrap-postgres.test.ts` converted; one PR each
Scope: the one file, `scripts/assert-db-tests-ran.ts`; own clone per lane
Must NOT: as State 3; a `*.live.test.ts` gated on an embedding or NATS env is reported with the env name, not converted
Record: PR, then #878 comment per merge
Done-check: `CHANGED_FILES=<file> bash scripts/done-means/878-pg-tests-require-database.sh` → exit 0 (RED: not yet run; the pre-edit run on the file)

## State 6 — Batch D: the lane-8 three plus the remaining live tests
Tier: T1 — the three carry 25 pre-existing lint findings each lane must clear whole (rule 25)
Deliverable: `src/tools/__tests__/{bulk-set-tier,decompose-entry,list-stale}.pg.test.ts` from `_scratch/session7/lane-8-878-b2-src-tools-a.patch` (one file per lane, lint-clean), then `namespace-isolation-matrix-live`, `agent-context-pack-guidance-repo-facts-live`, `src/graph-derivation.live.test.ts`; one PR each
Scope: the one file, `scripts/assert-db-tests-ran.ts`; own clone per lane
Must NOT: as State 5; carry the lane-8 stash as a whole commit
Record: PR, then #878 comment per merge; lane-8 `stash@{0}` dropped by Rico once the three merge
Done-check: `CHANGED_FILES=<file> bash scripts/done-means/878-pg-tests-require-database.sh` → exit 0 (RED: not yet run; the pre-edit run on the file)

## State 7 — WAYFINDER QUOTA
Close: https://github.com/rodaddy/open-brain/issues/889 — a lane reads
`server/maintenance/` and names which side owns the `runOnce()` contract
(file:line), lands the fix with a 20-run done-means script under
`scripts/done-means/`, RED shown on `aa878c4f` if reproducible; tick the map
checkbox in the same motion.

## State FINAL — WRAP
Invoke the handover-author skill; next handover passes the validator; `aqmd up`.

## HANDED-OVER UNKNOWNS
- `878-pg-tests-require-database.sh` discovers `*.pg.test.ts` only; whether `CHANGED_FILES` bypasses that filter for the `*.test.ts` and `*.live.test.ts` files in States 3-6 is UNVERIFIED — the first lane proves it or widens the check first (own T1 lane).
- Sixteen files over 500 lines (list on #878) need a split lane each before conversion; not sliced here.
- Q1, since session 3: `.claude/agents/tracking-scribe.md` writes ONLY to the root checkout (Rico's dirty branch); sessions 3-7 scribed via comments — Rico's call.
- Q2: `server/main.ts` reads `process.env` under the door override; moving them into `server/config.ts` is Rico's decision.
- Q3: `_plans/750-standards-sprint-map.md` exists only on `sprint/standards-fmt`; no map tick possible.
- Q5: `node/no-process-env` is scoped to `server/**`; 19 `src/` files still read env and retire at L6 — Rico confirms the scope.
- Q7: lane-7 `stash@{0}` (`chore/l2b2-l5-shared-namespace-owner`) is superseded by #873; dropping it is Rico's, not a lane's.
- Q8: #888 Forge migration — Rico decides when planning starts and whether it displaces #878 work.
- `src/shared-namespace.ts` twin recorded on #826 (third pair); #784 closes only if Rico accepts resolved-by-observation.
