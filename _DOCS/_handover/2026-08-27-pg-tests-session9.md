# Handover — #878 hard test-database program, session 9 (2026-08-27)

## State 0 — BASE
Read /Volumes/ThunderBolt/Development/_DOCS/HANDOVER-BASE.md in full
(181 lines). It is the standing contract for this session.
- Any question this document does not directly override → the rules layers
  answer it, nearest layer first.
- Anything neither the base nor this document covers → ask Rico before acting.
- Output discipline: minimum verbosity, only the context needed, output tokens
  low. If Rico wants more, he will ask.
- Layer 0.1: read open-brain/_DOCS/HANDOVER-RULES.md in full (318 lines on
  this branch). It overrides the base; this document overrides it. Rules 28-46
  bind: head never works, own clones, FIVE lanes, no `rm`, no `--no-verify`,
  manifest in the same commit, one rebase lane per PR, census by command.

## State 1 — ORIENT
- `origin/main` is `692900a2` (#919); session 8 merged #893-#919 — MERGED (`git log --oneline origin/main -1`)
- Every `*.test.ts` on main under 500 lines that guarded on a database var now
  requires it; manifest floor `MIN_TOTAL_LIVE_TESTCASES = 265` — MERGED (#919)
- 15 files over 500 lines still carry `describe.skip`/`dbDescribe`; the sized
  list is the session-8 scribe comment on #878 — RUNNING (`git grep -l 'describe.skip\|skipIf' origin/main -- '*.test.ts'`)
- `bun run test:isolated` supplies `OPENBRAIN_TEST_DATABASE_URL`,
  `OPENBRAIN_LOCAL_CLONE_TEST_DATABASE_URL`, `OPENBRAIN_SCRATCH_ADMIN_URL`;
  helpers for all three in `scripts/test-support/require-test-database.ts` — MERGED (#910 #918, #904 closed)
- Program check `scripts/done-means/878-pg-tests-require-database.sh` accepts
  the three vars; `CHANGED_FILES` may name any `*.test.ts` — MERGED (#893 #918)
- #889 lease race CLOSED (#899); #912 drop time and #915 runner PG 17 OPEN,
  runner-side; #916 wall-clock test OPEN — RUNNING (`gh issue list --state open`)
- #888 Forge migration is a planning item, not a build order — RUNNING (`gh issue view 888`)
- Lane-7 `stash@{0}` (superseded by #873) and lane-8 `stash@{0}` (superseded by
  #906-#908) await Rico's drop — RUNNING (`git -C <clone> stash list`)
- Mac checkout `/Volumes/ThunderBolt/Development/open-brain` is DIRTY on
  `sprint/standards-fmt` (Rico's); lanes never work there — RUNNING
- Reusable, temp: `/Volumes/ThunderBolt/_tmp/open-brain/_scratch/session7/{lane,recon,git}.workflow.js`, `collect.sh` — WRITTEN
- Graph mode: converted — RUNNING (`ls scripts/done-means/` has `878-*.sh`)
Re-probe before dispatching anything (live state beats this doc):
- `git log --oneline origin/main -1` → expect 692900a2 or later with this PR merged
- `gh pr list --state open --json number` → only #892, #745, #739 (not this program)
- `rg -n 'MIN_TOTAL_LIVE_TESTCASES = ' scripts/assert-db-tests-ran.ts` → 265

## State 2 — LAND THE PAPERWORK
Branch: `docs/pg-tests-session9` from `origin/main` — cut it once THIS
document's PR merges; if the checkout is `main` or `docs/pg-tests-session8` is
merged, switch first, never work there.
Retire: `docs/pg-tests-session8` (this document's PR); lane clones 1-6, 9, 10
sit on merged `chore/878-*` / `feat/904-*` branches (`git switch --detach
origin/main` then `git branch -d`); lane-6 is detached already. Worktrees:
`none`.
Commit this handover: branch `docs/pg-tests-session8`, path
`_DOCS/_handover/2026-08-27-pg-tests-session9.md` with `_DOCS/HANDOVER-RULES.md`,
explicit-path staging, `git commit -F` message file. Done by the authoring session.
Scribe: issue #878 — started: `gh issue comment 878 --body "Scribe, session 9: ..."`
Done-check: `git log -1 --stat`

## State 3 — get-entry: split, then hard-fail
Tier: T1 — shared test file; CI manifest changes
Deliverable: `src/tools/__tests__/get-entry.test.ts` (506 lines) split by subject into files each under 500 lines, every live suite plain `describe` ending `(live Postgres)` on `requireTestDatabaseUrl()`, whole files lint-clean, manifest entries at emitted counts, floor +N in the same commit; one PR
Scope: that file and its split siblings, `scripts/assert-db-tests-ran.ts`; own clone
Must NOT: `--no-verify`; change the tool under test; leave any file over 500 lines; carry a suite name that does not end `(live Postgres)`
Record: PR, then #878 comment on merge
Done-check: `CHANGED_FILES="<the split files>" bash scripts/done-means/878-pg-tests-require-database.sh` → exit 0 (RED: not yet run; the pre-edit run on the original file)

## State 4 — 026_maintenance_queue (520 lines), as State 3
Tier: T1 — as State 3
Deliverable: `src/db/migrations/026_maintenance_queue.test.ts` split and converted as in State 3; one PR, rebased after State 3 merges (rule 43)
Scope: as State 3
Must NOT: as State 3; touch `src/db/migrations/*.ts` sources
Record: PR, then #878 comment on merge
Done-check: `CHANGED_FILES="<the split files>" bash scripts/done-means/878-pg-tests-require-database.sh` → exit 0 (RED: not yet run)

## State 5 — tier-lane (528 lines), as State 3
Tier: T1 — as State 3
Deliverable: `src/tools/__tests__/tier-lane.test.ts` split and converted; one PR, rebased after State 4 merges
Scope: as State 3
Must NOT: as State 3
Record: PR, then #878 comment on merge
Done-check: `CHANGED_FILES="<the split files>" bash scripts/done-means/878-pg-tests-require-database.sh` → exit 0 (RED: not yet run)

## State 6 — search-brain-fts-language.pg (552 lines), as State 3
Tier: T1 — as State 3
Deliverable: `src/tools/__tests__/search-brain-fts-language.pg.test.ts` split and converted; one PR, rebased after State 5 merges
Scope: as State 3
Must NOT: as State 3
Record: PR, then #878 comment on merge
Done-check: `CHANGED_FILES="<the split files>" bash scripts/done-means/878-pg-tests-require-database.sh` → exit 0 (RED: not yet run)

## State 7 — ingest-conversation-facts.pg (609) and promote-lane-shared (619)
Tier: T1 — as State 3
Deliverable: `src/tools/__tests__/ingest-conversation-facts.pg.test.ts` and `scripts/promote-lane-shared.test.ts` split and converted, one lane and one PR each, merged in that order after State 6
Scope: as State 3, one file per lane
Must NOT: as State 3
Record: PR, then #878 comment on merge
Done-check: `CHANGED_FILES="<the split files>" bash scripts/done-means/878-pg-tests-require-database.sh` → exit 0 (RED: not yet run)

## State 8 — WAYFINDER QUOTA
Close: https://github.com/rodaddy/open-brain/issues/916 — a lane rewrites the
`scripts/ob-backfill*` sanitize scan assertion to growth shape (two sizes,
ratio) instead of 1000ms wall clock, with a done-means script under
`scripts/done-means/`, RED shown against the current assertion on a slowed
input; tick the map checkbox in the same motion.

## State FINAL — WRAP
Invoke the handover-author skill; next handover passes the validator; `aqmd up`.

## HANDED-OVER UNKNOWNS
- Nine files over 600 lines stay on #878 after this slice (append-session-event 2779, search-brain-relational-retrieval 1095, sdk-protocol.pg 847, lane-upsert 838, graph-derivation-handler.live 770, backup-restore-live 766, agent-context-pack-durable-lane 725, embedding-repair.pg 698, source-sync.pg 675); append-session-event needs its own plan before a lane.
- Q1, since session 3: `.claude/agents/tracking-scribe.md` writes ONLY to the root checkout (Rico's dirty branch); sessions 3-8 scribed via comments — Rico's call.
- Q2: `server/main.ts` reads `process.env` under the door override; moving them into `server/config.ts` is Rico's decision.
- Q5: `node/no-process-env` is scoped to `server/**`; 19 `src/` files still read env and retire at L6 — Rico confirms the scope.
- Q7: lane-7 and lane-8 `stash@{0}` are superseded; dropping them is Rico's, not a lane's.
- Q8: #888 Forge migration — Rico decides when planning starts and whether it displaces #878 work.
- #915: the self-hosted `check` runner's PostgreSQL 17 versus the stack's 18 is a runner change (Rico's); `scripts/local-clone.test.ts` asserts `>= 17` until then.
