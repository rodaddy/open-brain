# Handoff — #780 lint sweep, collect nine and dispatch five (2026-08-26)

## State 0 — BASE
Read /Volumes/ThunderBolt/Development/_DOCS/HANDOFF-BASE.md in full
(181 lines). It is the standing contract for this session.
- Any question this document does not directly override → the rules layers
  answer it, nearest layer first.
- Anything neither the base nor this document covers → ask Rico before acting.
- Output discipline: minimum verbosity, only the context needed, output tokens
  low. If Rico wants more, he will ask.
- Layer 0.1: read open-brain/_DOCS/HANDOFF-RULES.md in full (208 lines, on
  `origin/docs/780-sweep-paperwork-2` until PR #785 merges — `git show
  origin/docs/780-sweep-paperwork-2:_DOCS/HANDOFF-RULES.md`; `main` still has
  147). It overrides the base; this document overrides it. New rules 28-32 bind
  this session: the head consolidates and never works (31), lanes run parallel
  in their own clones (32), at most FIVE in flight, each its own Workflow (3).

## State 1 — ORIENT
- `origin/main` is `40628c9` (#814 server-identity) — MERGED (`git log --oneline origin/main -1`)
- Nine lane PRs open, uncollected: #815 list-recent, #816 get-entry, #817
  context-pack-repo-facts, #818 worker-proxy, #819 tier-lane, #820 reporting,
  #821 people, #822 promotion-shared, #823 session-lifecycle — RUNNING (`gh pr list`)
- PR #785 is a DRAFT: rules 28-32 plus lane-contract rounds 36-38 — RUNNING (`gh pr list`)
- #780 checklist comment `5427622744`: 32 of 54 ticked — RUNNING (`gh api repos/:owner/:repo/issues/comments/5427622744`)
- CI fires again on lane PRs (run 33004537250); `python-capture` fails as the known #764 flake — RUNNING (`gh pr checks 823`)
- Clones `lane-1`..`lane-11` under `/Volumes/ThunderBolt/_tmp/open-brain/_worktrees/`;
  lane-1..9 hold the nine PR branches, lane-10 free, lane-11 this handoff —
  RUNNING (`git -C <clone> branch --show-current`)
- Rest of the program: `_plans/server-hardening-ladder.md` (L2b-2, L2c, L3-L6)
  and the #780 checklist tail — MERGED
- Graph mode: converted — RUNNING (`ls scripts/done-means/` has
  `780-touched-files-lint-clean.sh`, `handoff-validates.sh`)
Re-probe before dispatching anything (live state beats this doc):
- `gh pr list --state open --json number,headRefName,isDraft` → expect the nine plus #785
- `cd <lane-10> && ./node_modules/.bin/oxlint --deny-warnings server/transport/health.ts` → expect 1 finding (complexity 21)

## State 2 — LAND THE PAPERWORK
Branch: `docs/780-sweep-session3` from `origin/main` — cut it if absent; if the
checkout is `main` or `docs/780-handoff-session3` is merged (PR #824), switch
first, never work there.
Retire: the nine `chore/780-lint-*` branches (`list-recent`, `get-entry`,
`context-pack-repo-facts`, `worker-proxy`, `tier-lane`, `reporting`, `people`,
`promotion-shared`, `session-lifecycle`) as each PR merges — `gh pr merge --squash
--delete-branch`, then `git branch -D` in the owning clone — and
`docs/780-sweep-paperwork-2` once #785 merges. Worktrees: `none`.
Commit this handoff: branch `docs/780-handoff-session3`, path
`_DOCS/_handoff/2026-08-26-lint-sweep-l2-session3.md`, explicit-path staging,
`git commit -F` message file. Done by the authoring session as PR #824.
Scribe: issue #780 — started: `gh issue comment 780 --body "Scribe, session 3: ..."`
Done-check: `git log -1 --stat`

## State 3 — Collect and merge #815 #816 #817 #818 #819
Tier: T1 — five server tool files; callers could break
Deliverable: five collector lanes, ONE Workflow each: `bun scripts/verify-lane.ts <pr>`
from its own clone, CI triaged against the known flakes (#764 python-capture,
#787 lease-boundary, runner-environment exit 127), harvest line confirmed, then
`gh pr merge <n> --squash --delete-branch`
Scope: one PR per lane; the lane's own clone; no source edits
Must NOT: merge without a receipt on the head SHA; edit a lane's diff; run a sixth lane
Record: each PR, then the #780 checklist tick
Done-check: `cd <clone> && ./node_modules/.bin/oxlint --deny-warnings <file>` → exit 0 per merged file (RED: 40628c9, findings per the checklist)

## State 4 — Collect and merge #820 #821 #822 #823, and land #785
Tier: T1 — three tool files, the shared promotion helpers, and the rules layer
Deliverable: four collector lanes as in State 3, plus one lane running
`bun scripts/verify-lane.ts 785`, `gh pr ready 785`, merge. #822 unifies three
helpers across `promotion.ts` and `promote-entry.ts`, so it merges LAST
Scope: PRs #820 #821 #822 #823 #785; their clones
Must NOT: merge #822 before the other three (shared owner, rule 32); rewrite #785's text
Record: each PR; #785 also comments on #780 that rules 28-32 are now on `main`
Done-check: `git show origin/main:_DOCS/HANDOFF-RULES.md | wc -l` → 208 (RED: 40628c9, 147 lines)

## State 5 — Re-tick the #780 checklist
Tier: T0 — one comment PATCH, reversible, derived from live oxlint
Deliverable: `bash /Volumes/ThunderBolt/_tmp/open-brain/_scratch/tick-780.sh` from
a clone detached at the new `origin/main`; the comment reflects live lint
Scope: comment `5427622744` on #780
Must NOT: hand-edit a tick; run before States 3-4 have merged
Record: #780 comment `5427622744`
Done-check: `gh api repos/:owner/:repo/issues/comments/5427622744 --jq .body | rg -c '^- \[x\]'` → 41+

## State 6 — Wave of five one-finding file lanes
Tier: T1 — server files with live callers
Deliverable: five parallel lanes, ONE Workflow each, one file each to the lint
standard with a PR: `server/transport/health.ts`, `server/tools/source-registry.ts`,
`server/tools/session-save-load.ts`, `server/tools/repo-facts.ts`,
`server/tools/memory-helpers.ts`. Reuse first: `rg` for an existing helper before
extracting a private one (rule 27)
Scope: one file per lane plus new helper/test files beside it; its own clone
Must NOT: two lanes share a file; disable comments; a hook baseline; `src/`
Record: each PR, then the #780 tick
Done-check: `bash scripts/done-means/780-touched-files-lint-clean.sh` with `DONE_MEANS_780_FILES=<file>` → exit 0 (RED: 40628c9, 1 finding each)

## State 7 — WAYFINDER QUOTA
Close: https://github.com/rodaddy/open-brain/issues/780 closes only when every
checklist file is ticked and `oxlint --deny-warnings` on non-test `server/`
exits 0; this session ticks in the same motion as each merge (State 5).
Also close #784 if Rico accepts resolved-by-observation (comment `5430102158`).

## State FINAL — WRAP
Invoke the handoff-author skill; next handoff passes the validator; `aqmd up`.

## HANDED-OVER UNKNOWNS
- The standing scribe (rule 30) did NOT run in session 2; the head carried receipts
  inline and compacted twice. Start `.claude/agents/tracking-scribe.md` at State 2.
- #784 CI starvation looks resolved live, cause never found — comment `5430102158`.
- Decisions for Rico, open since session 1: test files under the full function rule
  (`_plans/server-hardening-ladder.md:79-81`); Python 50 vs TS 100
  (`_DOCS/STANDARDS-typescript.md:198-210`).
- Wave 2 of one-finding files, queued not briefed: `server/tools/ingest-raw-turn.ts`,
  `server/tools/context-pack-b*.ts` (glob it; the design-lookup gate refuses the
  full name), `server/realtime/working-set.ts`, `server/maintenance/index.ts`,
  `server/logging/sanitize.ts` — and the seven below them on the #780 checklist.
- #773 (Contract Parity two-dot diff), #774 (oxlint-tsgolint) filed, not started.
- L2b-2 env rewiring: reads inventoried at
  `/Volumes/ThunderBolt/_tmp/open-brain/_scratch/server-env-lint-audit.md`.
- `src/` twins duplicate `server/` logic (citation-recall, agent-context-pack-repo-facts);
  out of #780 scope, ladder archive rung (rule 9: the edge is circular).
- `clone-20260825` carries `stash@{0}` (the #779 wiring half, already merged) —
  reported per GIT_STANDARDS, not dropped by an agent.
