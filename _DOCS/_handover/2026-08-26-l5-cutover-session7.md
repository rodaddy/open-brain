# Handover — L3 closed, L5 cutover, session 7 (2026-08-26)

## State 0 — BASE
Read /Volumes/ThunderBolt/Development/_DOCS/HANDOVER-BASE.md in full
(181 lines). It is the standing contract for this session.
- Any question this document does not directly override → the rules layers
  answer it, nearest layer first.
- Anything neither the base nor this document covers → ask Rico before acting.
- Output discipline: minimum verbosity, only the context needed, output tokens
  low. If Rico wants more, he will ask.
- Layer 0.1: read open-brain/_DOCS/HANDOVER-RULES.md in full (235 lines on
  `main`). It overrides the base; this document overrides it. Rules 28-35
  bind: head never works, own clones, FIVE lanes, whole suite, no `rm`, #868 first.

## State 1 — ORIENT
- `origin/main` is `80733a0` (#869); session 6 merged #856-#869 — MERGED (`git log --oneline origin/main -1`)
- L3 States 3-6 landed: #863 gate, #865 `server/logging/decorate.ts`, #867
  `installToolLogging` at `server/main.ts:137`; `750-l3-logger-threaded.sh`
  → exit 0, all five clauses PASS on `e50b8f3` — RUNNING (that script)
- L3 residual: the four `src/logger` importers in `server/observability/`
  receive it from `server/main.ts:553` — MERGED (#869 80733a0; whole suite 3933/0)
- #860 is OPEN; its closure receipt (State 6) is this session's first close — RUNNING (`gh issue view 860`)
- L5 census at `e50b8f3`: 50 import sites, 27 modules (ladder command,
  `_plans/server-hardening-ladder.md:17-18`); rows in #864 — RUNNING
- L5 shared-namespace owner change is WRITTEN, uncommitted: lane-7 clone
  `stash@{0}` and `/Volumes/ThunderBolt/_tmp/open-brain/_scratch/session5/lane-7-l5-shared-namespace-owner.patch`;
  blocked by `server/config.test.ts` (#868, rule 35) — RUNNING (`git -C <lane-7> stash list`)
- #748 census: 69 catch sites, 22 lose the error (comment on #748) — MERGED
- Clones `lane-1`..`lane-11` under `/Volumes/ThunderBolt/_tmp/open-brain/_worktrees/`;
  lane-11 holds this branch; no worktrees — RUNNING (`git status -sb`)
- Mac checkout `/Volumes/ThunderBolt/Development/open-brain` is DIRTY on
  `sprint/standards-fmt` (Rico's, on hold); lanes never work there — RUNNING
- CI flakes open: #702, #764, #769, #787, #760, #834 — RUNNING (`gh issue view`)
- Reusable, temp: `/Volumes/ThunderBolt/_tmp/open-brain/_scratch/session5/{lane,recon,collector,rebase,triage}.workflow.js` — WRITTEN
- Rest of the program: #748 (hard-failure helper), #864 rows, ladder L6 — MERGED
- Graph mode: converted — RUNNING (`ls scripts/done-means/` has `750-l3-*.sh`)
Re-probe before dispatching anything (live state beats this doc):
- `git log --oneline origin/main -1` → expect 80733a0 or later with this PR merged
- `cd <clone> && rg -c "src/logger" server --glob '!*.test.ts'` → expect 0

## State 2 — LAND THE PAPERWORK
Branch: `docs/l5-session7` from `origin/main` — cut it once THIS document's
PR merges; if the checkout is `main` or `docs/l3-session6` is merged,
switch first, never work there.
Retire: `docs/l3-session6` (this document's PR) via `git branch -d`. Worktrees: `none`.
Commit this handover: branch `docs/l3-session6`, path `_DOCS/_handover/2026-08-26-l5-cutover-session7.md`,
explicit-path staging, `git commit -F` message file. Done by the authoring session.
Scribe: issue #864 — started: `gh issue comment 864 --body "Scribe, session 7: ..."`
Done-check: `git log -1 --stat`

## State 3 — Split server/config.test.ts (#868)
Tier: T1 — shared test file every config-group change must touch
Deliverable: `server/config.test.ts` split into files under 500 code lines;
`withEnv` replaced by an env-object helper passed to the reader; no test
reads `process.env`; same pass count
Scope: `server/config*.test.ts`, one new helper under `server/config/`; own clone
Must NOT: change `server/config.ts` or `.oxlintrc.json`; drop a test
Record: PR, then #868 closing comment
Done-check: `oxlint --deny-warnings server/config*.test.ts` → 0 (RED: e50b8f3, max-lines + 6x no-process-env)

## State 4 — Land the shared-namespace owner change
Tier: T1 — config group gains two fields; `contracts/` composes the names
Deliverable: apply the lane-7 patch (State 1) onto a branch from post-#868
`origin/main`, fix the `:901` count assertion, add the env-group test; PR
Scope: the seven patched files plus the split config tests; own clone
Must NOT: switch any importer; edit `src/shared-namespace.ts`
Record: PR, then #864 comment
Done-check: `rg -c 'export function isLegacySharedNamespace' server/tools/shared-namespace.ts` → 1 (RED: e50b8f3)

## State 5 — Switch the eight shared-namespace importers
Tier: T1 — eight tool modules change import path and receive names
Deliverable: zero `src/shared-namespace` imports in non-test `server/`; each
importer takes `names` from its deps (#850 pattern); whole suite green
Scope: the eight importers named in #864 and their tests; own clone, after State 4
Must NOT: touch `src/`; add a `process.env` read or a default names fallback
Record: PR, then #864 table row → MERGED
Done-check: `rg -c 'src/shared-namespace' server --glob '!*.test.ts'` → 0 (RED: e50b8f3 → 8)

## State 6 — WAYFINDER QUOTA
Close: https://github.com/rodaddy/open-brain/issues/860 — post the State 1
`750-l3-logger-threaded.sh` receipt (exit 0 on `origin/main`, sha named) as the
closing comment, set `_plans/server-hardening-ladder.md:3` to "L3 MERGED" with
#863/#865/#867/#869 in the same PR, then `gh issue close 860`; tick the map checkbox
in the same motion.

## State FINAL — WRAP
Invoke the handover-author skill; next handover passes the validator; `aqmd up`.

## HANDED-OVER UNKNOWNS
- Q1, since session 3: `.claude/agents/tracking-scribe.md` writes ONLY to the
  root checkout (Rico's dirty branch); sessions 3-6 scribed via comments — Rico's call.
- Q2: `server/main.ts` reads `process.env` under the door override; moving them into `server/config.ts` is Rico's decision.
- Q3: `_plans/750-standards-sprint-map.md` exists only on `sprint/standards-fmt`; no map tick possible.
- Q5: `node/no-process-env` is scoped to `server/**`; 19 `src/` files still read env and retire at L6 — Rico confirms the scope.
- Q6: #868 fixes `server/config.test.ts` by splitting; the alternative, a
  test-file exemption for `node/no-process-env`, reopens the #825 rung — Rico rules if the split proves too costly.
- `src/shared-namespace.ts` twin recorded on #826 (third pair); #784 closes only if Rico accepts resolved-by-observation.
- Since session 1: test files under the function rule (`_plans/server-hardening-ladder.md:79-81`); Python 50 vs TS 100 (`_DOCS/STANDARDS-typescript.md:198-210`).
