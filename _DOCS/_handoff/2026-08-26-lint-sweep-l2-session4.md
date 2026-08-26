# Handoff — #780 lint sweep, the last seven files (2026-08-26)

## State 0 — BASE
Read /Volumes/ThunderBolt/Development/_DOCS/HANDOFF-BASE.md in full
(181 lines). It is the standing contract for this session.
- Any question this document does not directly override → the rules layers
  answer it, nearest layer first.
- Anything neither the base nor this document covers → ask Rico before acting.
- Output discipline: minimum verbosity, only the context needed, output tokens
  low. If Rico wants more, he will ask.
- Layer 0.1: read open-brain/_DOCS/HANDOFF-RULES.md in full (212 lines on
  `main`). It overrides the base; this document overrides it. Rules 28-32 bind
  this session: the head consolidates and never works (31), lanes run parallel
  in their own clones (32), at most FIVE in flight, each its own Workflow.

## State 1 — ORIENT
- `origin/main` is `923126d` (#835 memory-helpers) — MERGED (`git log --oneline origin/main -1`)
- Session 3 merged 15 PRs (#815-#824, #785, #828-#830, #832, #833, #835), each
  with a verify-lane receipt on the head sha — MERGED (`gh pr list --state merged`)
- `_DOCS/HANDOFF-RULES.md` on `main` is 212 lines, rules 28-32 live — MERGED
  (`git show origin/main:_DOCS/HANDOFF-RULES.md | wc -l`)
- #780 checklist comment `5427622744`: 46 of 54 ticked — RUNNING (`gh api
  repos/rodaddy/open-brain/issues/comments/5427622744 --jq .body | rg -c '^- \[x\]'`)
- SEVEN files remain, ONE complexity finding each at `923126d` — RUNNING
  (`./node_modules/.bin/oxlint --deny-warnings <file>`): `server/tools/context-pack-b*.ts`
  `fitDurableLaneSection` 14 (glob it, the design-lookup gate refuses the full
  name); `server/realtime/working-set.ts` method `append` 15;
  `server/maintenance/index.ts` `createMaintenanceRuntime` 11;
  `server/logging/sanitize.ts` `sanitizeValue` 11;
  `server/capture/liveness-observer.ts` `readCaptureLiveness` 12;
  `server/auth/middleware.ts` anonymous function 14;
  `server/application/index.ts` `createShadowApplication` 13
- An eighth unticked line reads `266 (1)` — a tick-script formatting artifact,
  not a file; do not dispatch it — RUNNING (same probe)
- Clones `lane-1`..`lane-11` under `/Volumes/ThunderBolt/_tmp/open-brain/_worktrees/`:
  all clean, on `main` or detached at `origin/main`; lane-11 holds this branch;
  no worktrees — RUNNING (`cd <clone> && git status -sb`; `git -C` is refused)
- Mac checkout `/Volumes/ThunderBolt/Development/open-brain` is DIRTY on
  `sprint/standards-fmt` (Rico's, on hold, 37 paths); lanes never work there —
  RUNNING (`cd /Volumes/ThunderBolt/Development/open-brain && git status -sb`)
- CI known flakes: #764 python-capture (4 hits), #787 lease-boundary, #760
  runner-environment exit 127, #834 ob-backfill wall-clock — RUNNING (`gh pr checks <n>`)
- Rest of the program: `_plans/server-hardening-ladder.md` wave 2 (L2b-2, L2c,
  L3-L6); not in this slice — MERGED
- Graph mode: converted — RUNNING (`ls scripts/done-means/` has
  `780-touched-files-lint-clean.sh`, `handoff-validates.sh`)
Re-probe before dispatching anything (live state beats this doc):
- `git log --oneline origin/main -1` → expect `923126d` or later with this PR merged
- `cd <clone> && ./node_modules/.bin/oxlint --deny-warnings server/logging/sanitize.ts` → expect 1 finding, complexity 11

## State 2 — LAND THE PAPERWORK
Branch: `docs/780-sweep-session4` from `origin/main` — cut it once THIS
document's PR merges; if the checkout is `main` or `docs/780-sweep-session3` is
merged, switch first, never work there.
Retire: `docs/780-sweep-session3` after its PR merges — `gh pr merge --squash
--delete-branch`, then `git branch -D` in lane-11. Worktrees: `none`.
Commit this handoff: branch `docs/780-sweep-session3`, path
`_DOCS/_handoff/2026-08-26-lint-sweep-l2-session4.md`, explicit-path staging,
`git commit -F` message file. Done by the authoring session.
Scribe: issue #780 — started: `gh issue comment 780 --body "Scribe, session 4: ..."`
Done-check: `git log -1 --stat`

## State 3 — Five one-file lanes, wave one
Tier: T1 — server files with live callers
Deliverable: five parallel lanes, ONE Workflow each, one file each brought to
the lint standard with a PR: `server/tools/context-pack-b*.ts`,
`server/realtime/working-set.ts`, `server/maintenance/index.ts`,
`server/logging/sanitize.ts`, `server/capture/liveness-observer.ts`. Reuse
first: `rg` for an existing helper before extracting a private one (rule 27)
Scope: one file per lane plus new helper/test files beside it; its own clone
Must NOT: two lanes share a file; disable comments; a hook baseline; touch `src/`
Record: each PR, then the #780 checklist tick
Done-check: `bash scripts/done-means/780-touched-files-lint-clean.sh` with `DONE_MEANS_780_FILES=<file>` → exit 0 (RED: 923126d, 1 finding each)

## State 4 — Collect wave one, then the last two files
Tier: T1 — `auth/middleware.ts` sits on the namespace-isolation boundary
Deliverable: one collector lane per State 3 PR as it lands (`bun
scripts/verify-lane.ts <pr>` from its own clone, CI triaged against #764/#787/
#760/#834, then `gh pr merge <n> --squash --delete-branch`), then two file lanes:
`server/auth/middleware.ts` and `server/application/index.ts`
Scope: those two files, their clones, the five open PRs
Must NOT: change auth behavior or edit its regression tests — extraction only;
merge without a receipt on the head sha; run a sixth lane
Record: each PR; auth lane also comments on #780 that behavior is identical
Done-check: `cd <clone> && ./node_modules/.bin/oxlint --deny-warnings server/auth/middleware.ts server/application/index.ts` → exit 0 (RED: 923126d, 14 and 13)

## State 5 — Re-tick the #780 checklist
Tier: T0 — one comment PATCH, reversible, derived from live oxlint
Deliverable: `bash /Volumes/ThunderBolt/_tmp/open-brain/_scratch/tick-780.sh` from
a clone detached at the new `origin/main`; the comment reflects live lint
Scope: comment `5427622744` on #780
Must NOT: hand-edit a tick; run before States 3-4 have merged
Record: #780 comment `5427622744`
Done-check: `gh api repos/rodaddy/open-brain/issues/comments/5427622744 --jq .body | rg -c '^- \[ \]'` → 1 (the `266` artifact only)

## State 6 — WAYFINDER QUOTA
Close: https://github.com/rodaddy/open-brain/issues/780 closes when
`./node_modules/.bin/oxlint --deny-warnings` over non-test `server/` exits 0;
run it as the closing receipt and tick the map checkbox in the same motion.
Also close #784 if Rico accepts resolved-by-observation (comment `5430102158`).

## State FINAL — WRAP
Invoke the handoff-author skill; next handoff passes the validator; `aqmd up`.

## HANDED-OVER UNKNOWNS
- Q1, new: `.claude/agents/tracking-scribe.md` writes ONLY to the root checkout,
  which is Rico's dirty on-hold branch. Session 3 recorded via issue and PR
  comments instead and never ran the file-writing scribe. Rule 30 and the agent's
  first law conflict while that checkout is parked — Rico's call.
- Decisions for Rico, open since session 1: test files under the full function
  rule (`_plans/server-hardening-ladder.md:79-81`); Python 50 vs TS 100
  (`_DOCS/STANDARDS-typescript.md:198-210`).
- Not started: #773 (Contract Parity two-dot diff), #774 (oxlint-tsgolint),
  #825 (L2b-2 env rewiring), #826 (`src/` twins), #827 (`tier_lane_denied` test).
- Filed session 3: #831 (`session_save` has no server-side pg test), #834
  (ob-backfill timing assertion).
- Reusable scripts live under `/Volumes/ThunderBolt/_tmp/open-brain/_scratch/`:
  `session3/collector.workflow.js` (args pr, clone, branch, ready, triage),
  `session3/file-lane.workflow.js` (args n, file, slug, word, notes), `tick-780.sh`
  (hardcodes lane-11). Temp has no persistence guarantee — re-create if gone.
