# Handover — #878 hard test-database program, session 11 (2026-08-27)

## State 0 — BASE
Read /Volumes/ThunderBolt/Development/_DOCS/HANDOVER-BASE.md in full
(183 lines). It is the standing contract for this session.
- Any question this document does not directly override → the rules layers
  answer it, nearest layer first.
- Anything neither the base nor this document covers → ask Rico before acting.
- Output discipline: minimum verbosity, only the context needed, output tokens
  low. If Rico wants more, he will ask.
- Layer 0.1: read open-brain/_DOCS/HANDOVER-RULES.md in full (389 lines on
  this branch). It overrides the base; this document overrides it. Rules 28-54
  bind: head never works, own clones, FIVE lanes, no `rm`, no `--no-verify`,
  manifest in the same commit, one rebase lane per PR, census by command, the
  authoring session drains, the done-check invocation verbatim, oxlint on the
  origin/main copy before cutting a lane, no `aqmd` in a clone, one CI rerun
  for an untouched-file timing failure, docs branches pushed from a clone.
- Graph Mode v1.3-beta runs from the Development canon
  (docs/controller-contract.md, "Graph Mode v1.3-beta"): brief-pack every lane
  brief (`--max-tightenings 2`; decisions row 3), lane-report/check.sh on every
  five-field report, ratchet-bound/decisions/placeholders at each merge pass
  appended to scripts/done-means/beta-receipts.md.

## State 1 — ORIENT
- `origin/main` is `4e1f0f2c` (#944); session 10 merged #939-#944 — MERGED (`git log --oneline origin/main -1`)
- Manifest floor `MIN_TOTAL_LIVE_TESTCASES = 328` — MERGED (`scripts/assert-db-tests-ran.ts:518` on origin/main)
- Four `*.test.ts` files still self-skip on a database var, each with a `const dbDescribe = DB_URL ? describe : describe.skip;` line and oxlint findings on origin/main: `src/tools/__tests__/lane-upsert.test.ts` 838 lines, 33 findings, unit describe at 53, live at 763; `src/tools/__tests__/search-brain-relational-retrieval.test.ts` 1095, 8, fixture code 1-535, unit describe 536, live 826; `server/application/sdk-protocol.pg.test.ts` 847, 16, dbDescribe at 96 and 426; `src/tools/__tests__/append-session-event.test.ts` 2779, 135, unit describe 86 with 60 its, live 2391 — RUNNING (`rg -l 'describe\.skip|skipIf|dbDescribe' --glob '*.test.ts'` in a clone at 4e1f0f2c: 8 files, the other four comment-only or `tests/enforcement.test.ts:301`, a lint-config guard)
- Program check `scripts/done-means/878-pg-tests-require-database.sh`: `CHANGED_FILES` names any `*.test.ts`; clause 2 rejects a prettier-wrapped or module-relayed helper import (#945) — MERGED (rule 48; round 40)
- The backup drill runs on every `bun run test:isolated` and pre-push, about 5 s — MERGED (#944; decisions row 5 awaits Rico)
- #827 #938 CLOSED; #945 #924 #915 #912 #937 OPEN — RUNNING (`gh issue list --state open`)
- Reusable, temp: `/Volumes/ThunderBolt/_tmp/open-brain/_scratch/session10/{lane,git,diag,drain,scribe}.workflow.js`, `collect.sh <pr> [CHANGED_FILES]`, `common-rules.txt` R1-R9, `rebase-brief.template.txt`, `task-scribe.txt`, `task-drain.txt` — WRITTEN
- Graph mode: converted — RUNNING (`ls scripts/done-means/` has `878-*.sh`, `827-*.sh`)
- Drain: origin holds `main`, `docs/pg-tests-session9` (#936), and two non-program heads; eleven clones detached at `4e1f0f2c`, no stash, no extra worktree, every `test/878-*` and `test/827-*` branch deleted; `check-drained.sh` ignores the tracked `.qmd/index.yml` since Development `a4190023` and passes every clone — RUNNING (`check-drained.sh .` fails on the root checkout's untracked draft only)
- Root checkout carries one untracked agent draft, `scripts/done-means/qmd-root-only-gate-fires.sh` — WRITTEN (`git status --short`; keep or drop is Rico's)
- Round 40, two SME entries, decisions row 5, session-10 beta receipts: `690b67de` on `docs/pg-tests-session10`, stacked on `docs/pg-tests-session9` — WRITTEN (this document's PR)
Re-probe before dispatching anything (live state beats this doc):
- `git log --oneline origin/main -1` → expect 4e1f0f2c or later with this PR merged
- `gh pr list --state open --json number` → only #745, #739 once #936 and this PR merge
- `rg -n 'MIN_TOTAL_LIVE_TESTCASES = ' scripts/assert-db-tests-ran.ts` → 328

## State 2 — LAND THE PAPERWORK
Branch: `docs/pg-tests-session11` from `origin/main` — cut it once THIS
document's PR merges; if the checkout is `main` or `docs/pg-tests-session10` is
merged, switch first, never work there.
Commit this handover: branch `docs/pg-tests-session10`, path
`_DOCS/_handover/2026-08-27-pg-tests-session11.md` with `_DOCS/HANDOVER-RULES.md`,
explicit-path staging, `git commit -F` message file. Done by the authoring session.
Tooling: `mkdir -p /Volumes/ThunderBolt/_tmp/open-brain/_scratch/session11; cp /Volumes/ThunderBolt/_tmp/open-brain/_scratch/session10/{lane,git,diag,drain,scribe}.workflow.js /Volumes/ThunderBolt/_tmp/open-brain/_scratch/session10/{collect.sh,common-rules.txt,rebase-brief.template.txt} /Volumes/ThunderBolt/_tmp/open-brain/_scratch/session11/; perl -pi -e 's/session-10/session-11/g; s/session10/session11/g' /Volumes/ThunderBolt/_tmp/open-brain/_scratch/session11/*.workflow.js /Volumes/ThunderBolt/_tmp/open-brain/_scratch/session11/collect.sh /Volumes/ThunderBolt/_tmp/open-brain/_scratch/session11/common-rules.txt` — every Workflow row then reads `session11 ...` (rule 50); `common-rules.txt` R5 floor reads 328.
Scribe: issue #878 — started: `gh issue comment 878 --body "Scribe, session 11: ..."`
Done-check: `git log -1 --stat`

## State 3 — lane-upsert (838 lines, 33 findings): split, then hard-fail
Tier: T1 — shared test file; CI manifest changes
Deliverable: `src/tools/__tests__/lane-upsert.test.ts` split by subject: the live describe (line 763) becomes `lane-upsert.pg.test.ts` as a plain `describe` ending `(live Postgres)` on `requireTestDatabaseUrl()`; the unit describe (53-760) split into files each under 500 lines; shared helpers in `lane-upsert-test-helpers.ts`; whole files lint-clean by the R7-R9 patterns only; manifest entry at the emitted count, floor +N in the same commit; one PR
Scope: that file and its split siblings, `scripts/assert-db-tests-ran.ts`; own clone
Must NOT: `--no-verify`; touch `src/tools/lane-upsert.ts`; leave any file over 500 lines; a two-specifier or wrapped require import (#945: one helper per import line); run `aqmd search`, `aqmd up`, or bare `aqmd` in the clone (rule 51)
Record: PR, then #878 comment on merge
Done-check: `CHANGED_FILES="<the split files>" bash scripts/done-means/878-pg-tests-require-database.sh` → exit 0 (RED: 4e1f0f2c, clauses 1-3 FAIL on the original file)

## State 4 — search-brain-relational-retrieval (1095 lines, 8 findings), as State 3
Tier: T1 — as State 3
Deliverable: fixture code (1-535) to `search-brain-relational-retrieval-fixture.ts`, unit describe (536) and live describe (826) each in its own file under 500 lines, converted as in State 3; one PR, rebased after State 3 merges (rule 43)
Scope: as State 3
Must NOT: as State 3; touch `src/tools/search-brain.ts`
Record: PR, then #878 comment on merge
Done-check: `CHANGED_FILES="<the split files>" bash scripts/done-means/878-pg-tests-require-database.sh` → exit 0 (RED: 4e1f0f2c)

## State 5 — sdk-protocol.pg (847 lines, 16 findings), as State 3
Tier: T1 — as State 3
Deliverable: `server/application/sdk-protocol.pg.test.ts` split at its two dbDescribe blocks (96, 426) into two live files under 500 lines plus a helper module, converted as in State 3; one PR, rebased after State 4 merges
Scope: as State 3, under `server/application/`
Must NOT: as State 3; touch `server/application/sdk-protocol.ts` or any `server/` source
Record: PR, then #878 comment on merge
Done-check: `CHANGED_FILES="<the split files>" bash scripts/done-means/878-pg-tests-require-database.sh` → exit 0 (RED: 4e1f0f2c)

## State 6 — append-session-event split plan (2779 lines, 135 findings)
Tier: T0 — one plan file, no code, nothing reads it yet
Deliverable: `_plans/878-append-session-event-split.md`: the 60 unit its grouped by subject into named files each under 500 lines, block boundaries taken with `awk 'NR>=A && NR<=B'` (not from a brief), the helpers each group needs, the live describe (2391) as `append-session-event.pg.test.ts`, and one lane per file in the six-line shape for session 12
Scope: that plan file; a read-only clone
Must NOT: edit any test or source file; open a PR
Record: #878 comment with the plan path and file count
Done-check: `rg -c '^## Lane' _plans/878-append-session-event-split.md` → the number of planned files, every one with a `Done-check:` line

## State 7 — WAYFINDER
Close: https://github.com/rodaddy/open-brain/issues/945 — a lane makes clause 2
of `scripts/done-means/878-pg-tests-require-database.sh` judge the demand, not
the line shape: a prettier-wrapped multi-specifier import and a helper reached
through a sibling module both pass when the file calls the helper; RED shown
on a fixture file with the wrapped import (#944's phase-3 receipt); GREEN is
that fixture passing AND `CHANGED_FILES="scripts/__tests__/backup-restore-live.test.ts
scripts/__tests__/backup-restore-live-refusals.test.ts" bash scripts/done-means/878-pg-tests-require-database.sh`
still exit 0; tick the map checkbox in the same motion.

## State FINAL — WRAP
Invoke the handover-author skill; next handover passes the validator; `aqmd up`.

## HANDED-OVER UNKNOWNS
- `docs/pg-tests-session10` (#946) is stacked on `docs/pg-tests-session9` (#936); both done-means now fail only on the root checkout's untracked `scripts/done-means/qmd-root-only-gate-fires.sh` — keep or drop it, and merge #936 first or #946 alone, are Rico's calls.
- decisions rows 3-5 (`docs/decisions.md`) need Rico: brief-pack's `--max-tightenings 2` knob; lane-report/check.sh's `CI` false positive and RESULTS-block rebase reports; the backup drill running on every isolated run.
- `_reports/` is gitignored (rule 54); whether the session records get tracked is Rico's call.
- Q1, since session 3: the tracking scribe runs as a Workflow lane on the root checkout's docs branch — Rico confirms that as the standing shape.
- Q2: `server/main.ts` reads `process.env` under the door override; moving them into `server/config.ts` is Rico's decision.
- Q5: `node/no-process-env` is scoped to `server/**`; 19 `src/` files still read env and retire at L6 — Rico confirms the scope.
- Q8: #888 Forge migration — Rico decides when planning starts and whether it displaces #878 work.
- #915: the self-hosted `check` runner's PostgreSQL 17 versus the stack's 18 is a runner change (Rico's); `scripts/local-clone.test.ts` asserts `>= 17` until then.
- #924: six tracing tests fail order-dependently in the root checkout only, so every docs-branch push runs from a clone (rule 53); the fix is unowned.
- Parked: dev#98 hook-env crossing checkpoint, `_DOCS/_parked/dev98-hook-env-crossing.md`; resume or drop is Rico's call.
- #937 (aqmd allowlist) was filed from the `.qmd/index.sqlite` view; Rico says the index now lives in Postgres — close or keep is his call.
- Sibling denial warn lines (`promote_shared_denied`, `adjacent_context_denied`, `citation_recall_denied`, `promote_entry_denied`) stay unpinned; reported on #827's closing comment, no issue owns them yet.
