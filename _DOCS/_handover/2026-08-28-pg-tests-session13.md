# Handover — #878 hard test-database program, session 13 (2026-08-28)

## State 0 — BASE
Read /Volumes/ThunderBolt/Development/_DOCS/HANDOVER-BASE.md in full
(183 lines). It is the standing contract for this session.
- Any question this document does not directly override → the rules layers
  answer it, nearest layer first.
- Anything neither the base nor this document covers → ask Rico before acting.
- Output discipline: minimum verbosity, only the context needed, output tokens
  low. If Rico wants more, he will ask.
- Layer 0.1: read open-brain/_DOCS/HANDOVER-RULES.md in full (453 lines on
  this branch). It overrides the base; this document overrides it. Rules 28-61
  bind; 58-61 are session 12's: a lint-dirty file splits as sequenced steps in
  one clone and one landing commit, the head snapshots an uncommitted
  multi-step tree, the 878 check's two forms, the text gate scans Bash too.
- Graph Mode v1.3-beta runs from the Development canon
  (docs/controller-contract.md, "Graph Mode v1.3-beta"): brief-pack every lane
  brief (`--max-tightenings 2`), ratchet-bound/decisions/placeholders at each
  merge pass appended to scripts/done-means/beta-receipts.md.

## State 1 — ORIENT
- `origin/main` is `3a44eece` (#960); session 12 merged #956 (issue 951, one `expectDefined` util), #957 (append-session-event split, nine files, original retired), #958 (this handover, rules 58-61), #959 (qmd model pins to the fleet llama-swap) and #960 (repo-local `.qmd/` retired) — MERGED (`git log --oneline origin/main -1`)
- `.qmd/` is untracked and gitignored; aqmd resolves this repo from the Development catalogue `/Volumes/ThunderBolt/Development/.qmd/index.yml` (open-brain card at :2879); `scripts/done-means/qmd-repo-config-retired.sh` judges it; a branch cut from a main older than `3a44eece` restores `.qmd/index.yml` on switch and re-scopes aqmd to an empty config — MERGED (#960) / RUNNING (`aqmd search` and `aqmd up` from the root → exit 0)
- No `*.test.ts` on origin/main self-skips on a database var: the four `describe.skip|skipIf` hits are comment-only plus `tests/enforcement.test.ts:301`, a lint-config guard — RUNNING (`git grep -l 'describe.skip\|skipIf' origin/main -- '*.test.ts'` → 4; each read)
- Zero code-line `process.env.OPENBRAIN_TEST_DATABASE_URL` reads outside `scripts/test-support/` — RUNNING (`git grep -n 'process.env.OPENBRAIN_TEST_DATABASE_URL' origin/main -- '*.test.ts' | rg -v 'scripts/test-support/' | rg -v ':\s*(//|\*)'` → 0 lines); the #878 plan's literal done-means (`rg -l 'OPENBRAIN_TEST_DATABASE_URL' --glob '*.test.ts'` → 0) still lists 34 files because comments and header docs name the variable
- Manifest: `append_session_event create_if_missing (live Postgres)` at `scripts/assert-db-tests-ran.ts:40` minTests 8, `MIN_TOTAL_LIVE_TESTCASES = 332` at :520 — MERGED (#957)
- Head re-ran on origin/main f93a16a0: `CHANGED_FILES=src/tools/__tests__/append-session-event.pg.test.ts bash scripts/done-means/878-pg-tests-require-database.sh` → exit 0, clauses 1-4 PASS — RUNNING
- `_plans/878-append-session-event-split.md` is executed and stays as the record; its Lane 2-8 done-checks were replaced per rule 60 — MERGED (#952) / RUNNING (#957)
- #951 CLOSED; #937 #924 #915 #912 #888 #878 OPEN; no open PR — RUNNING (`gh issue list --state open`, `gh pr list --state open`)
- Development `wip/2026-08-27` is merged into Development `origin/main` (`9698cc3d`) — RUNNING (`git -C /Volumes/ThunderBolt/Development merge-base --is-ancestor wip/2026-08-27 origin/main` → exit 0)
- Reusable, temp: `/Volumes/ThunderBolt/_tmp/open-brain/_scratch/session12/{lane,step,git,diag,plan,drain,scribe}.workflow.js` (`step.workflow.js` is the no-commit step lane, `lane.workflow.js` takes `setupExisting`), `collect.sh <pr> [CHANGED_FILES]`, `common-rules.txt` R1-R9 (R7 points at the util), `task-*.txt` briefs, `snap-step6/`, `snap-step7/` — WRITTEN
- Graph mode: converted — RUNNING (`ls scripts/done-means/` has `878-*.sh`, `951-*.sh`, `827-*.sh`)
- Drain: origin holds `main` plus this docs branch; lane-11 detached at `3a44eece`, ten clones at `f93a16a0`, no stash (lane-11 qmd drift archived as `_archive/session12/lane-11-qmd-index-drift.patch`), no extra worktree — RUNNING (`check-drained.sh` → PASS on the root checkout)
Re-probe before dispatching anything (live state beats this doc):
- `git log --oneline origin/main -1` → expect 3a44eece or later with this PR merged
- `gh pr list --state open --json number` → empty once this PR merges
- `rg -n 'MIN_TOTAL_LIVE_TESTCASES =' scripts/assert-db-tests-ran.ts` → 332

## State 2 — LAND THE PAPERWORK
Branch: `docs/pg-tests-session13` from `origin/main` — cut it once THIS
document's PR merges; if the checkout is `main` or `docs/pg-tests-session12` is
merged, switch first, never work there.
Commit this handover: branch `docs/pg-tests-session12`, path
`_DOCS/_handover/2026-08-28-pg-tests-session13.md` with `_DOCS/HANDOVER-RULES.md`,
explicit-path staging, `git commit -F` message file. Done by the authoring session.
Tooling: `mkdir -p /Volumes/ThunderBolt/_tmp/open-brain/_scratch/session13; cp /Volumes/ThunderBolt/_tmp/open-brain/_scratch/session12/{lane,step,git,diag,plan,drain,scribe}.workflow.js /Volumes/ThunderBolt/_tmp/open-brain/_scratch/session12/{collect.sh,common-rules.txt,rebase-brief.template.txt,task-drain.txt,task-scribe12.txt} /Volumes/ThunderBolt/_tmp/open-brain/_scratch/session13/; perl -pi -e 's/session-12/session-13/g; s/session12/session13/g' /Volumes/ThunderBolt/_tmp/open-brain/_scratch/session13/*.workflow.js /Volumes/ThunderBolt/_tmp/open-brain/_scratch/session13/collect.sh /Volumes/ThunderBolt/_tmp/open-brain/_scratch/session13/common-rules.txt /Volumes/ThunderBolt/_tmp/open-brain/_scratch/session13/task-drain.txt` — every Workflow row then reads `session13 ...` (rule 50); the `lane.workflow.js` SETUP line says main is f93a16a0 or later; `common-rules.txt` R5 floor reads 332.
Scribe: issue #878 — started: `gh issue comment 878 --body "Scribe, session 13: ..."`
Done-check: `git log -1 --stat`

## State 3 — #878 program done-means, executable
Tier: T1 — a new `scripts/done-means/` check; CI-adjacent
Deliverable: `scripts/done-means/878-program-complete.sh` (bare path, no argv) that exits 0 only when (a) no `*.test.ts` outside `scripts/test-support/` has a code-line `process.env.OPENBRAIN_TEST_DATABASE_URL` read, (b) no `*.test.ts` selects `describe.skip`/`skipIf`/`dbDescribe` on a database variable (`tests/enforcement.test.ts` lint-config guard allowlisted by path with the reason in a comment), (c) `scripts/test-support/require-test-database.ts` throws `test_database_required` when the variable is unset (run one pg file without it, expect non-zero); proven with a deliberate miss (rule 40); one PR
Scope: the new script; own clone
Must NOT: touch any test file or the manifest; `--no-verify`; run `aqmd` in the clone (rule 51)
Record: PR, then #878 comment on merge
Done-check: `bash scripts/done-means/878-program-complete.sh` → exit 0 on origin/main, exit 1 on a scratch copy with one `describe.skip` restored (RED: not yet run)

## State 4 — #924 order-dependent tracing tests, diagnosis
Tier: T0 — read-only diagnosis, no edit
Deliverable: a #924 comment naming the shared state the six tracing tests leak through (module-scope singleton, env var, or sink registration), with the minimal two-file `bun test` order that reproduces it in the root checkout and the passing order in a clone, and the owning file:line
Scope: read-only over `server/observability/`, `src/`, and the six test files named on #924; the root checkout for the repro run
Must NOT: edit any file; propose a fix in the comment beyond naming the owning seam
Record: #924 comment
Done-check: `gh issue view 924 --comments | rg -c 'session 13'` → 1

## State 5 — WAYFINDER
Close: https://github.com/rodaddy/open-brain/issues/878 — after State 3 merges
and its check exits 0 on origin/main, the head posts the three plan done-means
receipts (the new check, `bun run test:isolated` green on origin/main, the
no-variable run's `test_database_required`) and the decision on
`scripts/assert-db-tests-ran.test.ts` (it is the anti-skip manifest's own
test, not redundant with the helper; keep) as the closing comment, then
closes it; tick the map checkbox in the same motion if one exists.

## State FINAL — WRAP
Invoke the handover-author skill; next handover passes the validator; `aqmd up`.

## HANDED-OVER UNKNOWNS
- ratchet-bound: round 42 takes live from 15 to 16 over the rule value 15 (decisions row 6 graduated round 27 for 15); graduating another round or raising the value is Rico's.
- #937 (aqmd allowlist) now points at the Development catalogue card (`/Volumes/ThunderBolt/Development/.qmd/index.yml:2879` lists no `_DOCS/_handover/` or `docs/sme/entries/` pattern); the regen line is on the issue; close or keep is Rico's call.
- `aqmd research` reads `<repo>/.qmd/references.yml` (`_ob/bin/aqmd:378`); since #960 this repo declares no prior-art clones. The old file is at `58bf1b2a` and `_archive/session12/qmd-references.yml`; where a repo declares references under one store is Rico's call.
- `_DOCS/STANDARDS-repo-search.md:139` (generated, source-hash 1f45b7a4503e) still says keep `.qmd/index.yml` tracked, and the AGENTS.md sync banner names `sqlite3 .qmd/index.sqlite`; both regenerate from Development `_DOCS/`, Rico's repo.
- #915: the self-hosted `check` runner's PostgreSQL 17 versus the stack's 18 is a runner change (Rico's); `scripts/local-clone.test.ts` asserts `>= 17` until then.
- #912: retire-collab-migration intermittent in the full isolated run; unowned.
- #888 Forge migration — Rico decides when planning starts.
- `_reports/` is gitignored (rule 54); whether the session records get tracked is Rico's call.
- Q1, since session 3: the tracking scribe runs as a Workflow lane on the root checkout's docs branch — Rico confirms that as the standing shape.
- Q2: `server/main.ts` reads `process.env` under the door override; moving them into `server/config.ts` is Rico's decision.
- Q5: `node/no-process-env` is scoped to `server/**`; 19 `src/` files still read env and retire at L6 — Rico confirms the scope.
- #949 moved SHARED_NAMESPACE_* set/restore into `scripts/test-support/shared-namespace-env.ts`; whether that isolation should flow through `parseServerConfig(environment)` is Rico's call.
- Parked: dev#98 hook-env crossing checkpoint, `_DOCS/_parked/dev98-hook-env-crossing.md`; resume or drop is Rico's call.
- Sibling denial warn lines (`promote_shared_denied`, `adjacent_context_denied`, `citation_recall_denied`, `promote_entry_denied`) stay unpinned; no issue owns them yet.
- `src/tools/__tests__/append-session-event-lane-creation.test.ts` is 533 physical lines and passes oxlint's 500 code-line rule; whether R6's "500 lines total" wording should read code lines is Rico's.
