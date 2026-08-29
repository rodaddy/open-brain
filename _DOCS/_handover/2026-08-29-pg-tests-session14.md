# Handover — #924 tracing-order fix after the #878 program close, session 14 (2026-08-29)

## State 0 — BASE
Read /Volumes/ThunderBolt/Development/_DOCS/HANDOVER-BASE.md in full
(183 lines). It is the standing contract for this session.
- Any question this document does not directly override → the rules layers
  answer it, nearest layer first.
- Anything neither the base nor this document covers → ask Rico before acting.
- Output discipline: minimum verbosity, only the context needed, output tokens
  low. If Rico wants more, he will ask.
- Layer 0.1: read open-brain/_DOCS/HANDOVER-RULES.md in full (477 lines on
  this branch). It overrides the base; this document overrides it. Rules 28-64
  bind; 62-64 are session 13's: a done-means grep anchors on the formatter's
  output and a check's log path uses `OPENBRAIN_SCRATCH`, `aqmd in <repo>` is
  broken in clones (#965) so a clone brief names the Read route on
  `docs/decisions/*.md`, a red check with its rerun spent gets a rule-45 fix
  lane and the blocked PR rebases onto it from a clean clone.
- Graph Mode v1.3-beta runs from the Development canon
  (docs/controller-contract.md, "Graph Mode v1.3-beta"): brief-pack every lane
  brief (`--max-tightenings 2`), ratchet-bound/decisions/placeholders at each
  merge pass appended to scripts/done-means/beta-receipts.md.

## State 1 — ORIENT
- `origin/main` is `163cf268` (#963); session 13 merged #964 (issue 962, growth-scan allowance), #963 (`scripts/done-means/878-program-complete.sh`), #961 (the session-13 handover) — MERGED (`git log --oneline origin/main -1`)
- Issue 878 CLOSED with receipts on `163cf268`: program check exit 0, full isolated suite 4010 pass 0 fail across 289 files, no-variable run exit 1 with `test_database_required`, `scripts/assert-db-tests-ran.test.ts` 16 pass and kept — RUNNING (receipt lane logs `_scratch/session13/878-full-suite.log`, `878-novar.log`; head re-ran the check in the root)
- Issue 962 CLOSED: `GROWTH_SCAN_ALLOWANCE_MS = 30_000` on both growth scans, #964's own check job green on the runner — MERGED (`bcdb019a`)
- #924 diagnosed, not fixed: `scripts/__tests__/bulk-import.test.ts:17` `mock.module("../../src/logger.ts", ...)` is process-wide in bun; the pair `bun run test:isolated scripts/__tests__/bulk-import.test.ts server/observability/langfuse-tracing.test.ts` exits 1 in the root checkout (SyntaxError, `setLogContextReader` missing from the stub) and 0 in a clone on the same tree; why the checkouts differ is open — RUNNING (head re-ran both; #924 comment)
- `scripts/__tests__/bulk-import.test.ts` is lint-dirty on origin/main: 39 oxlint findings (35 `no-non-null-assertion`, 2 `max-lines-per-function`, 1 `no-unused-vars`, 1 `max-lines`), 1052 lines, 10 describes, 59 its — so the pre-commit gate refuses any edit until it splits (rules 25, 49, 58); `addLogSink` is `src/logger.ts:249`; the required pattern is at `src/observability/observability.test.ts:19-25` — RUNNING (`./node_modules/.bin/oxlint --deny-warnings scripts/__tests__/bulk-import.test.ts` → 39)
- #965 filed: `aqmd in <repo>` from a lane clone scopes on the clone since #960 (`_ob/bin/aqmd:750-763`); Development-owned — WRITTEN (issue)
- Manifest floor `MIN_TOTAL_LIVE_TESTCASES = 332` at `scripts/assert-db-tests-ran.ts:520` — MERGED (#957)
- No open PR; open issues include #924 #965 #937 #915 #912 #888 #864 #841 #831 #826 #787 #784 — RUNNING (`gh pr list --state open`, `gh issue list --state open`)
- Reusable, temp: `/Volumes/ThunderBolt/_tmp/open-brain/_scratch/session13/{lane,step,git,diag,plan,drain,scribe}.workflow.js`, `collect.sh <pr> [CHANGED_FILES]`, `common-rules.txt`, `task-*.txt` briefs, `reports/` — WRITTEN
- Graph mode: converted — RUNNING (`ls scripts/done-means/` has `878-program-complete.sh`, `962-growth-scan-allowance.sh`, `handover-validates.sh`)
- Drain: eleven clones detached at `163cf268`, no local branch but main, no stash, eight `.qmd/index.yml` drift patches under `_archive/session13/`, origin holds `main` plus this docs branch — RUNNING (`check-drained.sh` → PASS on the root checkout)
Re-probe before dispatching anything (live state beats this doc):
- `git log --oneline origin/main -1` → expect 163cf268 or later with this PR merged
- `gh pr list --state open --json number` → empty once this PR merges
- `bun run test:isolated scripts/__tests__/bulk-import.test.ts server/observability/langfuse-tracing.test.ts` in the root checkout → exit 1 (the RED this session fixes)

## State 2 — LAND THE PAPERWORK
Branch: `fix/924-tracing-order` from `origin/main` — cut it once THIS
document's PR merges; if the checkout is `main` or `docs/pg-tests-session13` is
merged, switch first, never work there.
Commit this handover: branch `docs/pg-tests-session13`, path
`_DOCS/_handover/2026-08-29-pg-tests-session14.md` with `_DOCS/HANDOVER-RULES.md`,
explicit-path staging, `git commit -F` message file. Done by the authoring session.
Tooling: `mkdir -p /Volumes/ThunderBolt/_tmp/open-brain/_scratch/session14; cp /Volumes/ThunderBolt/_tmp/open-brain/_scratch/session13/{lane,step,git,diag,plan,drain,scribe}.workflow.js /Volumes/ThunderBolt/_tmp/open-brain/_scratch/session13/{collect.sh,common-rules.txt,rebase-brief.template.txt,task-drain.txt,task-scribe13.txt} /Volumes/ThunderBolt/_tmp/open-brain/_scratch/session14/; perl -pi -e 's/session-13/session-14/g; s/session13/session14/g' /Volumes/ThunderBolt/_tmp/open-brain/_scratch/session14/*.workflow.js /Volumes/ThunderBolt/_tmp/open-brain/_scratch/session14/collect.sh /Volumes/ThunderBolt/_tmp/open-brain/_scratch/session14/common-rules.txt /Volumes/ThunderBolt/_tmp/open-brain/_scratch/session14/task-drain.txt` — every Workflow row then reads `session14 ...` (rule 50); the `lane.workflow.js` SETUP line says main is 163cf268 or later; clone briefs name the Read route on `docs/decisions/*.md` (rule 63).
Scribe: issue #924 — started: `gh issue comment 924 --body "Scribe, session 14: ..."`
Done-check: `git log -1 --stat`

## State 3 — #924 fix: split bulk-import.test.ts and observe the logger through a sink
Tier: T1 — shared test infrastructure; the pre-push hook on the root checkout depends on it
Deliverable: the rule-58 shape (plan file `_plans/924-bulk-import-split.md` first, then sequenced step lanes in ONE clone, nothing committed until the last step, head snapshot after each step per rule 59): a helper module `scripts/__tests__/bulk-import-test-helpers.ts` holding the pg mock and an `addLogSink` collector in place of the `mock.module("../../src/logger.ts", ...)` at :17, the ten describes moved into lint-clean sibling `*.test.ts` files (500 code lines each, `it` bodies hoisted, `expectDefined` from `scripts/test-support/expect-defined.ts` for the 35 non-null assertions), the original deleted, plus `scripts/done-means/924-no-logger-module-mock.sh` (clause 1: zero code-line `mock.module(` on a `logger` specifier in tracked `*.test.ts`; clause 2: the two-file pair with `server/observability/langfuse-tracing.test.ts` exits 0 from the checkout it runs in); one landing PR
Scope: that test file, its new siblings and helper, the new check, own clone; the check proven with a deliberate miss (rule 40); it is a unit file, so `scripts/assert-db-tests-ran.ts` is untouched (rule 60)
Must NOT: touch `src/logger.ts`, `server/observability/`, or any other test; retire an assertion to fit a rule value (rule 26); `--no-verify`; `aqmd` bare in the clone (rule 51)
Record: #924 comment before the first step (the rule-58 deviation), PR, then #924 comment on merge
Done-check: `bash scripts/done-means/924-no-logger-module-mock.sh` → exit 0 in the clone AND in the root checkout at the merged sha; then `bun run test:isolated` (no path) in the root checkout → 0 fail; the pair itself exits 1 in the root at 163cf268 today (RED: not yet run)

## State 4 — WAYFINDER
Close: https://github.com/rodaddy/open-brain/issues/924 — after State 3 merges,
the head posts the root-checkout full-suite count and the pair's exit 0 as the
closing comment, then closes it; if the full suite still fails in the root,
the remaining failing test names go on #924 and it stays open.

## State FINAL — WRAP
Invoke the handover-author skill; next handover passes the validator; `aqmd up`.

## HANDED-OVER UNKNOWNS
- #965: whether `aqmd in <repo>` should resolve the named catalogue card regardless of cwd is Rico's (Development `_ob/bin/aqmd`); until then rule 63's Read route.
- #924: why the same pair passes in a clone and fails in the root checkout is not established (root's nested `node_modules/node_modules`, 136 entries, is the only difference found); State 3 removes the mock regardless.
- ratchet-bound: round 43 takes live from 16 to 17 over the rule value 15; graduating a round or raising the value is Rico's (decisions row 6).
- placeholders/check.sh flags the quoted command form `aqmd in <repo>` at `docs/lane-contract.md:100` and in the session-13 handover as unfilled placeholders (recorded red in beta-receipts.md); whether the checker should exempt backtick-quoted commands is a Development canon question.
- beta lane-report/check.sh refused all three session-13 head-condensed reports (trailing content); session 12's ten passed; the schema reconciliation stays a decisions-pass item (controller-contract item 2).
- #937 (aqmd allowlist, Development catalogue card) close or keep is Rico's call.
- #915: the self-hosted `check` runner's PostgreSQL 17 versus the stack's 18 is a runner change (Rico's); #962's rising scan times (5152 → 7637 ms in one day) may be the same runner question.
- #912: retire-collab-migration intermittent in the full isolated run; unowned.
- #888 Forge migration — Rico decides when planning starts.
- `_reports/` is gitignored (rule 54); whether the session records get tracked is Rico's call.
- Q1, since session 3: the tracking scribe runs as a Workflow lane on the root checkout's docs branch — Rico confirms that as the standing shape.
- Q2: `server/main.ts` reads `process.env` under the door override; moving them into `server/config.ts` is Rico's decision.
- Q5: `node/no-process-env` is scoped to `server/**`; 19 `src/` files still read env and retire at L6 — Rico confirms the scope.
- Parked: dev#98 hook-env crossing checkpoint, `_DOCS/_parked/dev98-hook-env-crossing.md`; resume or drop is Rico's call.
- Sibling denial warn lines (`promote_shared_denied`, `adjacent_context_denied`, `citation_recall_denied`, `promote_entry_denied`) stay unpinned; no issue owns them yet.
