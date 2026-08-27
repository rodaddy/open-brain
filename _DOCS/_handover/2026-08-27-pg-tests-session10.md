# Handover — #878 hard test-database program, session 10 (2026-08-27)

## State 0 — BASE
Read /Volumes/ThunderBolt/Development/_DOCS/HANDOVER-BASE.md in full
(183 lines). It is the standing contract for this session.
- Any question this document does not directly override → the rules layers
  answer it, nearest layer first.
- Anything neither the base nor this document covers → ask Rico before acting.
- Output discipline: minimum verbosity, only the context needed, output tokens
  low. If Rico wants more, he will ask.
- Layer 0.1: read open-brain/_DOCS/HANDOVER-RULES.md in full (356 lines on
  this branch). It overrides the base; this document overrides it. Rules 28-50
  bind: head never works, own clones, FIVE lanes, no `rm`, no `--no-verify`,
  manifest in the same commit, one rebase lane per PR, census by command, the
  authoring session drains, the done-check invocation verbatim, oxlint on the
  origin/main copy before cutting a lane.
- Graph Mode v1.3-beta runs from the Development canon
  (docs/controller-contract.md, "Graph Mode v1.3-beta"): brief-pack every lane
  brief (`--max-tightenings 2` was session 9's knob; decisions row 3 holds
  Rico's ruling on it), lane-report/check.sh on every five-field report,
  ratchet-bound/decisions/placeholders at each merge pass appended to
  scripts/done-means/beta-receipts.md.

## State 1 — ORIENT
- `origin/main` is `fa82bdf5` (#935); session 9 merged #929-#935 — MERGED (`git log --oneline origin/main -1`)
- Manifest floor `MIN_TOTAL_LIVE_TESTCASES = 285` — MERGED (#935)
- Nine `*.test.ts` files over 600 lines still self-skip on a database var; the sized list is the session-9 scribe comment on #878 — RUNNING (`git grep -l 'describe.skip\|skipIf\|dbDescribe' origin/main -- '*.test.ts'`: 13 hits, nine live, three comment-only, `tests/enforcement.test.ts:301` guards lint config, not a database var)
- Every session-10 subject fails the program check at `fa82bdf5` (clauses 1-3) and carries oxlint findings on origin/main: graph-derivation-handler.live 8, source-sync.pg 15, embedding-repair.pg 23, backup-restore-live 28, agent-context-pack-durable-lane 35 — RUNNING (`./node_modules/.bin/oxlint --deny-warnings <file>` in a clone)
- `bun run test:isolated` supplies the three database vars; helpers in `scripts/test-support/require-test-database.ts` — MERGED (#910 #918)
- Program check `scripts/done-means/878-pg-tests-require-database.sh`: `CHANGED_FILES` names any `*.test.ts`; bare discovery matches only `*.pg.test.ts` — MERGED (#918; rule 48)
- #916 CLOSED (#934); #912 #915 OPEN, runner-side; #827 OPEN (State 8) — RUNNING (`gh issue list --state open`)
- Reusable, temp: `/Volumes/ThunderBolt/_tmp/open-brain/_scratch/session9/{lane,git,drain,scribe}.workflow.js`, `collect.sh` (derives CHANGED_FILES from the PR), `common-rules.txt` R1-R9 — WRITTEN
- Graph mode: converted — RUNNING (`ls scripts/done-means/` has `878-*.sh`)
- Drain: origin holds `main` plus open-PR heads; eleven clones detached at `fa82bdf5`, no stash, no extra worktree; ten clones and the root checkout carry a generated `.qmd/index.yml` edit — UNVERIFIED as drained (`check-drained.sh .` exits 1 on that file until the loop in HANDED-OVER UNKNOWNS runs)
- Round 39, two SME entries, decisions rows 3-4, session-9 beta receipts: harvest commit on `docs/pg-tests-session9` — WRITTEN (this document's PR)
Re-probe before dispatching anything (live state beats this doc):
- `git log --oneline origin/main -1` → expect fa82bdf5 or later with this PR merged
- `gh pr list --state open --json number` → only #745, #739 (not this program)
- `rg -n 'MIN_TOTAL_LIVE_TESTCASES = ' scripts/assert-db-tests-ran.ts` → 285

## State 2 — LAND THE PAPERWORK
Branch: `docs/pg-tests-session10` from `origin/main` — cut it once THIS
document's PR merges; if the checkout is `main` or `docs/pg-tests-session9` is
merged, switch first, never work there.
Commit this handover: branch `docs/pg-tests-session9`, path
`_DOCS/_handover/2026-08-27-pg-tests-session10.md` with `_DOCS/HANDOVER-RULES.md`,
explicit-path staging, `git commit -F` message file. Done by the authoring session.
Tooling: `mkdir -p /Volumes/ThunderBolt/_tmp/open-brain/_scratch/session10; cp /Volumes/ThunderBolt/_tmp/open-brain/_scratch/session9/{lane,git,drain,scribe}.workflow.js /Volumes/ThunderBolt/_tmp/open-brain/_scratch/session9/{collect.sh,common-rules.txt} /Volumes/ThunderBolt/_tmp/open-brain/_scratch/session10/; perl -pi -e 's/session-9/session-10/g; s/session9/session10/g' /Volumes/ThunderBolt/_tmp/open-brain/_scratch/session10/*.workflow.js /Volumes/ThunderBolt/_tmp/open-brain/_scratch/session10/collect.sh` — every Workflow row then reads `session10 ...` (rule 50); a row showing another session's tag is fixed before dispatch.
Scribe: issue #878 — started: `gh issue comment 878 --body "Scribe, session 10: ..."`
Done-check: `git log -1 --stat`

## State 3 — graph-derivation-handler.live (770 lines, 8 findings): split, then hard-fail
Tier: T1 — shared test file; CI manifest changes
Deliverable: `src/graph-derivation-handler.live.test.ts` split by subject into files each under 500 lines, every live suite plain `describe` ending `(live Postgres)` on `requireTestDatabaseUrl()`, whole files lint-clean by the R7-R9 patterns only (`expectDefined` guard, `it` bodies hoisted to module-scope functions, `as unknown as T`, helpers take `pool` and create none), manifest entries at emitted counts, floor +N in the same commit; one PR
Scope: that file and its split siblings, `scripts/assert-db-tests-ran.ts`; own clone
Must NOT: `--no-verify`; change the code under test; leave any file over 500 lines; carry a suite name that does not end `(live Postgres)`
Record: PR, then #878 comment on merge
Done-check: `CHANGED_FILES="<the split files>" bash scripts/done-means/878-pg-tests-require-database.sh` → exit 0 (RED: fa82bdf5, clauses 1-3 FAIL on the original file)

## State 4 — source-sync.pg (675 lines, 15 findings), as State 3
Tier: T1 — as State 3
Deliverable: `src/source-sync.pg.test.ts` split and converted as in State 3; one PR, rebased after State 3 merges (rule 43)
Scope: as State 3
Must NOT: as State 3; touch `src/source-sync.ts`
Record: PR, then #878 comment on merge
Done-check: `CHANGED_FILES="<the split files>" bash scripts/done-means/878-pg-tests-require-database.sh` → exit 0 (RED: fa82bdf5)

## State 5 — embedding-repair.pg (698 lines, 23 findings), as State 3
Tier: T1 — as State 3
Deliverable: `src/embedding-repair.pg.test.ts` split and converted; one PR, rebased after State 4 merges
Scope: as State 3
Must NOT: as State 3; touch `src/embedding-repair.ts`
Record: PR, then #878 comment on merge
Done-check: `CHANGED_FILES="<the split files>" bash scripts/done-means/878-pg-tests-require-database.sh` → exit 0 (RED: fa82bdf5)

## State 6 — backup-restore-live (766 lines, 28 findings), as State 3
Tier: T1 — as State 3
Deliverable: `scripts/__tests__/backup-restore-live.test.ts` split and converted; one PR, rebased after State 5 merges
Scope: as State 3
Must NOT: as State 3; touch `scripts/backup-*.ts` sources
Record: PR, then #878 comment on merge
Done-check: `CHANGED_FILES="<the split files>" bash scripts/done-means/878-pg-tests-require-database.sh` → exit 0 (RED: fa82bdf5)

## State 7 — agent-context-pack-durable-lane (725 lines, 35 findings), as State 3
Tier: T1 — as State 3
Deliverable: `src/tools/__tests__/agent-context-pack-durable-lane.test.ts` split and converted; one PR, rebased after State 6 merges; plan a phase-2 lint lane on the same clone (session 9's 026 precedent, rule 49)
Scope: as State 3
Must NOT: as State 3
Record: PR, then #878 comment on merge
Done-check: `CHANGED_FILES="<the split files>" bash scripts/done-means/878-pg-tests-require-database.sh` → exit 0 (RED: fa82bdf5)

## State 8 — WAYFINDER
Close: https://github.com/rodaddy/open-brain/issues/827 — a lane adds a test
that drives `tier_lane` to a namespace denial and asserts the
`tier_lane_denied` warn line (event name and fields), with a done-means script
under `scripts/done-means/`, RED shown by swapping `authorizeTierLane` for the
shared `authorize`; sibling tools are reported in an #827 comment, not widened
into the lane; tick the map checkbox in the same motion.

## State FINAL — WRAP
Invoke the handover-author skill; next handover passes the validator; `aqmd up`.

## HANDED-OVER UNKNOWNS
- `.qmd/index.yml`: every `aqmd up` rewrites its three `models:` lines to `https://llama-swap.rodaddy.live/v1#...`; the git guard refuses `git checkout --`, so ten clones and the root checkout read dirty and `check-drained.sh` fails — Rico runs `for n in 1 2 4 5 6 7 8 9 10 11; do git -C /Volumes/ThunderBolt/_tmp/open-brain/_worktrees/lane-$n checkout -- .qmd/index.yml; done` plus the same in the root checkout, or rules on committing the fleet endpoints / ignoring the file.
- Four files over 800 lines stay on #878 after this slice (append-session-event 2779, search-brain-relational-retrieval 1095, sdk-protocol.pg 847, lane-upsert 838); append-session-event needs its own plan before a lane.
- decisions rows 3-4 (`docs/decisions.md`) need Rico: brief-pack's `--max-tightenings 2` knob; lane-report/check.sh's `CI` false positive and the RESULTS-block rebase reports.
- Q1, since session 3: `.claude/agents/tracking-scribe.md` writes ONLY to the root checkout; session 9 ran it as a Workflow lane on the root checkout's clean docs branch — Rico confirms that as the standing shape.
- Q2: `server/main.ts` reads `process.env` under the door override; moving them into `server/config.ts` is Rico's decision.
- Q5: `node/no-process-env` is scoped to `server/**`; 19 `src/` files still read env and retire at L6 — Rico confirms the scope.
- Q8: #888 Forge migration — Rico decides when planning starts and whether it displaces #878 work.
- #915: the self-hosted `check` runner's PostgreSQL 17 versus the stack's 18 is a runner change (Rico's); `scripts/local-clone.test.ts` asserts `>= 17` until then.
- Parked: dev#98 hook-env crossing checkpoint, `_DOCS/_parked/dev98-hook-env-crossing.md`; resume or drop is Rico's call.
- The drain lane reported `check-drained.sh` exit 0 from lane-3; the head's run from the root exits 1 on the `.qmd/index.yml` edits — a lane's PASS claim is PROPOSED until the head re-runs it (HANDOVER-BASE §1).
