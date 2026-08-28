# Handover — #878 hard test-database program, session 12 (2026-08-28)

## State 0 — BASE
Read /Volumes/ThunderBolt/Development/_DOCS/HANDOVER-BASE.md in full
(183 lines). It is the standing contract for this session.
- Any question this document does not directly override → the rules layers
  answer it, nearest layer first.
- Anything neither the base nor this document covers → ask Rico before acting.
- Output discipline: minimum verbosity, only the context needed, output tokens
  low. If Rico wants more, he will ask.
- Layer 0.1: read open-brain/_DOCS/HANDOVER-RULES.md in full (402 lines on
  this branch). It overrides the base; this document overrides it. Rules 28-56
  bind: head never works, own clones, FIVE lanes, no `rm`, no `--no-verify`,
  manifest in the same commit, one rebase lane per PR, census by command, the
  authoring session drains, the done-check invocation verbatim, oxlint on the
  origin/main copy before cutting a lane, no `aqmd` in a clone, docs branches
  pushed from a clone, "floor +N" only for a suite with no manifest entry, the
  head re-runs every beta receipt it cites.
- Graph Mode v1.3-beta runs from the Development canon
  (docs/controller-contract.md, "Graph Mode v1.3-beta"): brief-pack every lane
  brief (`--max-tightenings 2`), ratchet-bound/decisions/placeholders at each
  merge pass appended to scripts/done-means/beta-receipts.md.

## State 1 — ORIENT
- `origin/main` is `fd70d4ec` (#949); session 11 merged #947, #948, #950, #949 — MERGED (`git log --oneline origin/main -1`)
- Manifest floor `MIN_TOTAL_LIVE_TESTCASES = 328`; every suite converted in session 11 already had an entry — MERGED (`scripts/assert-db-tests-ran.ts:518`)
- ONE `*.test.ts` file still self-skips on a database var: `src/tools/__tests__/append-session-event.test.ts` (2779 lines, 135 oxlint findings, unit describe at 86 with 61 its, live `dbDescribe` at 2381 with 8 its) — RUNNING (`git grep -l 'describe.skip\|skipIf' origin/main -- '*.test.ts'` → 5 hits; the other four are comment-only or `tests/enforcement.test.ts:301`, a lint-config guard)
- Split plan for that file: `_plans/878-append-session-event-split.md`, eight six-line lanes, helper module contents, ordering notes — WRITTEN (this document's PR; `rg -c '^## Lane'` → 8)
- Clause 2 of `scripts/done-means/878-pg-tests-require-database.sh` joins a wrapped import and resolves one relay hop (#945 closed by #947) — MERGED (`b88c4a0f`)
- `expectDefined` is defined seven times across lane helper modules — RUNNING (`rg -l "export function expectDefined" --glob '*.ts'` → 7; issue #951)
- ratchet-bound is RED: `live=16` over the rule value 15 after round 41; graduation is Rico's (decisions row 6) — RUNNING (`ratchet-bound/check.sh docs/lane-contract.md` → exit 1)
- #945 CLOSED; #951 #924 #915 #912 #937 #888 OPEN; #745 #739 are stale non-program PRs — RUNNING (`gh issue list --state open`, `gh pr list --state open`)
- Reusable, temp: `/Volumes/ThunderBolt/_tmp/open-brain/_scratch/session11/{lane,git,diag,plan,drain,scribe}.workflow.js`, `collect.sh <pr> [CHANGED_FILES]`, `common-rules.txt` R1-R9, `rebase-brief.template.txt`, `task-scribe.txt`, `task-drain.txt`; briefs are packed from a `task-<slug>.txt` and passed to the lane as a file path to Read — WRITTEN
- Graph mode: converted — RUNNING (`ls scripts/done-means/` has `878-*.sh`, `827-*.sh`)
- Drain: origin holds `main` plus two non-program heads; eleven clones detached at `fd70d4ec`, no stash, no extra worktree — RUNNING (`check-drained.sh .` → PASS on the root checkout)
Re-probe before dispatching anything (live state beats this doc):
- `git log --oneline origin/main -1` → expect fd70d4ec or later with this PR merged
- `gh pr list --state open --json number` → only #745, #739 once this PR merges
- `rg -n 'append_session_event create_if_missing' scripts/assert-db-tests-ran.ts` → line 40, minTests 8

## State 2 — LAND THE PAPERWORK
Branch: `docs/pg-tests-session12` from `origin/main` — cut it once THIS
document's PR merges; if the checkout is `main` or `docs/pg-tests-session11` is
merged, switch first, never work there.
Commit this handover: branch `docs/pg-tests-session11`, path
`_DOCS/_handover/2026-08-28-pg-tests-session12.md` with `_DOCS/HANDOVER-RULES.md`,
explicit-path staging, `git commit -F` message file. Done by the authoring session.
Tooling: `mkdir -p /Volumes/ThunderBolt/_tmp/open-brain/_scratch/session12; cp /Volumes/ThunderBolt/_tmp/open-brain/_scratch/session11/{lane,git,diag,plan,drain,scribe}.workflow.js /Volumes/ThunderBolt/_tmp/open-brain/_scratch/session11/{collect.sh,common-rules.txt,rebase-brief.template.txt,task-drain.txt} /Volumes/ThunderBolt/_tmp/open-brain/_scratch/session12/; perl -pi -e 's/session-11/session-12/g; s/session11/session12/g' /Volumes/ThunderBolt/_tmp/open-brain/_scratch/session12/*.workflow.js /Volumes/ThunderBolt/_tmp/open-brain/_scratch/session12/collect.sh /Volumes/ThunderBolt/_tmp/open-brain/_scratch/session12/common-rules.txt /Volumes/ThunderBolt/_tmp/open-brain/_scratch/session12/task-drain.txt` — every Workflow row then reads `session12 ...` (rule 50); `lane.workflow.js` SETUP line says main is fd70d4ec or later; `common-rules.txt` R5 floor reads 328.
Scribe: issue #878 — started: `gh issue comment 878 --body "Scribe, session 12: ..."`
Done-check: `git log -1 --stat`

## State 3 — append-session-event live suite (plan Lane 1), first and alone
Tier: T1 — shared test file; CI manifest changes
Deliverable: Lane 1 of `_plans/878-append-session-event-split.md` verbatim: the live describe at origin/main 2381 becomes `src/tools/__tests__/append-session-event.pg.test.ts` on `requireTestDatabaseUrl()`, the helper module `append-session-event-test-helpers.ts` created with the contents the plan lists, the original file trimmed; manifest entry `append_session_event create_if_missing (live Postgres)` verified at the JUnit count (exists at :40, minTests 8: floor unchanged unless JUnit disagrees, rule 55); one PR
Scope: the four files the plan's Lane 1 names; own clone
Must NOT: `--no-verify`; touch `src/tools/append-session-event.ts` or any migration; leave any file over 500 lines; run `aqmd search`, `aqmd up`, or bare `aqmd` in the clone (rule 51); run in parallel with States 4-10 (every one edits the same source file)
Record: PR, then #878 comment on merge
Done-check: `CHANGED_FILES="src/tools/__tests__/append-session-event.pg.test.ts" bash scripts/done-means/878-pg-tests-require-database.sh` → exit 0 (RED: fd70d4ec, `CHANGED_FILES="src/tools/__tests__/append-session-event.test.ts"` → clauses 1-3 FAIL)

## State 4 — plan Lanes 2-8, one state each, sequenced after State 3
Tier: T1 — shared test file per lane; no manifest change (unit files)
Deliverable: the seven unit files of `_plans/878-append-session-event-split.md` Lanes 2-8, each lane's six lines taken verbatim from the plan; one PR per lane, opened only after the previous lane's PR merges (one owner of `append-session-event.test.ts` at a time); Lane 8 retires the original file once empty
Scope: per lane, the files its plan block names; own clone
Must NOT: as State 3; two lanes on `append-session-event.test.ts` at once; a lane that has not first re-taken the census (`rg -n 'describe\(|^\s+it\('` plus `wc -l` on the file being split from, both falling after each lane)
Record: PR per lane, then #878 comment on merge
Done-check: per lane, the plan block's `Done-check:` line verbatim → exit 0 (RED: fd70d4ec for Lane 2; each later lane's RED is the merge sha of the lane before it)

## State 5 — WAYFINDER
Close: https://github.com/rodaddy/open-brain/issues/951 — one lane moves
`expectDefined` to `scripts/test-support/expect-defined.ts`, every lane helper
module imports it, `common-rules.txt` R7 points at it; runs in parallel with
State 3 (disjoint files: it must NOT touch the append-session-event helper
module, which State 3 creates importing the new util); done-check
`rg -l "export function expectDefined" --glob '*.ts' .` → exactly 1 (RED:
fd70d4ec → 7); tick the map checkbox in the same motion if one exists.

## State FINAL — WRAP
Invoke the handover-author skill; next handover passes the validator; `aqmd up`.

## HANDED-OVER UNKNOWNS
- decisions row 6 (`docs/decisions.md`): ratchet-bound is red at live=16; Rico picks graduate round 27, raise the rule value, or leave it red. Rows 3-5 still await him.
- #949 moved the SHARED_NAMESPACE_* set/restore into `scripts/test-support/shared-namespace-env.ts` to satisfy `node/no-process-env` under `server/**`; whether that isolation should instead flow through `parseServerConfig(environment)` is Rico's call.
- #745 and #739: two non-program PRs with red checks, open since before session 9; merge, rebase, or close is Rico's call.
- `_reports/` is gitignored (rule 54); whether the session records get tracked is Rico's call.
- Q1, since session 3: the tracking scribe runs as a Workflow lane on the root checkout's docs branch — Rico confirms that as the standing shape.
- Q2: `server/main.ts` reads `process.env` under the door override; moving them into `server/config.ts` is Rico's decision.
- Q5: `node/no-process-env` is scoped to `server/**`; 19 `src/` files still read env and retire at L6 — Rico confirms the scope.
- Q8: #888 Forge migration — Rico decides when planning starts and whether it displaces #878 work.
- #915: the self-hosted `check` runner's PostgreSQL 17 versus the stack's 18 is a runner change (Rico's); `scripts/local-clone.test.ts` asserts `>= 17` until then.
- #924: six tracing tests fail order-dependently in the root checkout only, so every docs-branch push runs from a clone (rule 53); the fix is unowned.
- #937 (aqmd allowlist) was filed from the `.qmd/index.sqlite` view; Rico says the index now lives in Postgres — close or keep is his call.
- Parked: dev#98 hook-env crossing checkpoint, `_DOCS/_parked/dev98-hook-env-crossing.md`; resume or drop is Rico's call.
- Sibling denial warn lines (`promote_shared_denied`, `adjacent_context_denied`, `citation_recall_denied`, `promote_entry_denied`) stay unpinned; no issue owns them yet.
