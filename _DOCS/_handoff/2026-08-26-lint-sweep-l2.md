# Handoff — #780 lint sweep, one file per lane, feeding L2 (2026-08-26)

## State 0 — BASE
Read /Volumes/ThunderBolt/Development/_DOCS/HANDOFF-BASE.md in full
(181 lines). It is the standing contract for this session.
- Any question this document does not directly override → the rules layers
  answer it, nearest layer first.
- Anything needed that neither the base nor this document covers → ask Rico
  before acting.
- Output discipline: minimum verbosity, only the context needed, output
  tokens low. If Rico wants more, he will ask.
- Layer 0.1: read open-brain/_DOCS/HANDOFF-RULES.md in full (141 lines). It
  overrides the base; this document overrides it. Rules 22-26 are new.
- Every lane runs in the clone `/Volumes/ThunderBolt/_tmp/open-brain/_scratch/clone-20260825`
  (rule 17); the Mac checkout is dirty on `sprint/standards-fmt` (Rico's, on
  hold). Lanes are sequential: the clone is one checkout, and each file's
  fix lands before the next file starts (ruling on #780).

## State 1 — ORIENT
- `origin/main` is `49ecfbe` = PR #778, L2a: 23 env names typed on
  `ServerConfig` (`server/config/env-groups.ts`) — MERGED (`git rev-parse --short origin/main`)
- PR #779 (L2b-1a, head `1d0b9b2`) is a DRAFT with a BLOCK verdict: two P1s,
  both the missing composition-root half (`server/main.ts:168` never passes
  `ftsCorpusConfig` / `natsRuntimeBoundary` / `recoveryWalPath` into
  `registerMemoryTools`). The wiring half is in the clone's `stash@{0}` and
  `/Volumes/ThunderBolt/_tmp/open-brain/_archive/l2b1/blocked-wiring-half.patch` — WRITTEN (`gh pr view 779 --comments`)
- Issue #780 holds Rico's ruling (one file per lane, fully to standard) and
  the 142-finding per-file checklist in sweep order — RUNNING (`gh issue view 780 --comments`)
- Lane 1 (`server/main.ts`, branch `chore/780-lint-main-ts`, adds the generic
  check `scripts/done-means/780-touched-files-lint-clean.sh`) and a docs lane
  (`docs/ladder-status-l2a`: ladder status, #780 ruling in the decisions
  file, baseline re-measure) were dispatched by the authoring session; their
  PRs: docs lane is PR #781 (open, docs-only, baseline check green at its
  head); lane 1 is PR #782 (open, `chore/780-lint-main-ts`) — UNVERIFIED (`gh pr checks 782`)
- `scripts/done-means/750-server-baseline-holds.sh` is red on main (100
  files, 12 `process.env` mentions) until the docs lane merges — RUNNING
- `./node_modules/.bin/oxlint --deny-warnings <file>` at `49ecfbe`:
  `server/main.ts` 3, `server/tools/search-brain.ts` 2,
  `server/tools/search-all.ts` 5, `server/tools/search-engine.ts` 9 (incl.
  `max-lines`), `server/observability/langfuse-tracing.ts` 8 (incl.
  `max-lines`) — RUNNING (list verbatim on #780)
- Rest of the program: `_plans/server-hardening-ladder.md` (L2b-2, L2c, L2d,
  L3-L6) and the #780 checklist below `search-all.ts` — MERGED
- Graph mode: converted — RUNNING (`ls scripts/done-means/*.sh | wc -l` → 67)
Re-probe before dispatching anything (live state beats this doc):
- `gh pr list --state open --json number,headRefName,isDraft` → expect #779 draft, plus lane 1 / docs PRs if they landed
- `cd /Volumes/ThunderBolt/_tmp/open-brain/_scratch/clone-20260825 && git status --short --branch && git worktree list && git stash list` → expect clean tree, one worktree at most, `stash@{0}` = l2b1 wiring half
- `cd /Volumes/ThunderBolt/_tmp/open-brain/_scratch/clone-20260825 && ./node_modules/.bin/oxlint --deny-warnings server/main.ts` → exit 0 once lane 1 merged, else 3 findings

## State 2 — LAND THE PAPERWORK
Branch: `docs/780-sweep-paperwork` from `origin/main` — cut it if absent; if the checkout
is `main` or `docs/handoff-780-sweep` is merged (PR #TBD), switch first, never work there.
Retire: `docs/handoff-rules-19-21` (PR #767), `fix/no-local-inference-defaults`
(PR #766), `fix/recall-serves-durable-memory` (PR #765) in the clone —
`git branch -D` (squash-merged); `chore/780-lint-main-ts` and
`docs/ladder-status-l2a` once their PRs merge; worktree
`/Volumes/ThunderBolt/_tmp/open-brain/_worktrees/docs-ladder-status` if present — `git worktree remove`.
Commit this handoff: branch `docs/780-sweep-paperwork`, path `_DOCS/_handoff/2026-08-26-lint-sweep-l2.md` plus `_DOCS/HANDOFF-RULES.md` (rules 22-26), explicit-path
staging, `git commit -F` message file. The authoring session opened this as a PR on `docs/780-sweep-paperwork` (done-means `scripts/done-means/handoff-validates.sh`); merge it in State 3 with the others, then cut a fresh `docs/780-sweep-paperwork-2` for this session's own paperwork.
Scribe: issue #780 — started: `gh issue comment 780 --body "Ruling (Rico, 2026-08-26): O1 ..."`
Done-check: `git log -1 --stat`

## State 3 — Collect lane 1 (main.ts) and the docs lane
Tier: T1 — shared startup code and the plan files every later lane reads
Deliverable: both PRs merged: Light review, `bun scripts/verify-lane.ts <pr>` receipt, Tightenings harvest, `gh pr merge --squash --delete-branch`; or re-cut smaller if absent or failing. Docs PR is #781 (`8395395`): before merging, replace the `UNVERIFIED` ruling quote in `_plans/server-rewrite-decisions.md` with Rico's verbatim text from the third comment on #780
Scope: PRs #782 (`chore/780-lint-main-ts`), #781 (`docs/ladder-status-l2a`), #783 (this handoff); `docs/lane-contract.md` for the harvest
Must NOT: merge without a receipt on the final head; re-review a fixer commit; touch `#779`
Record: each PR, then tick `server/main.ts` on the #780 checklist comment
Done-check: `cd <clone> && ./node_modules/.bin/oxlint --deny-warnings server/main.ts` → exit 0 and `bash scripts/done-means/750-server-baseline-holds.sh` → exit 0 (RED: 49ecfbe, 3 findings / baseline FAIL)

## State 4 — Lane 2: server/tools/search-brain.ts to standard
Tier: T1 — the search tool every client calls; behavior must not move
Deliverable: PR from `origin/main`, branch `chore/780-lint-search-brain`, `registerSearchBrainTool` (142 lines) and its handler (complexity 18) extracted into named helpers; existing tests unmodified and green; no disable comments
Scope: `server/tools/search-brain.ts` and new helper/test files beside it
Must NOT: touch other files' findings, `process.env` reads, or `src/`
Record: the PR, then tick on #780
Done-check: `bash scripts/done-means/780-touched-files-lint-clean.sh` → exit 0 (RED: 49ecfbe with `DONE_MEANS_780_FILES=server/tools/search-brain.ts`, 2 findings)

## State 5 — #779 fixer: land the composition-root half
Tier: T1 — changes what value four tools receive at startup
Deliverable: `feat/l2b1-inject-config-into-tool-readers` rebased onto main, ONE commit applying `stash@{0}` (main.ts:168 passes `ftsCorpusConfig: config.fts.corpusConfig`, `recoveryWalPath: config.recovery.walPath`, `natsRuntimeBoundary: natsBoundary`; `search-brain.ts:178` passes `dependencies.ftsCorpusConfig`; drop the dead `searchEmbeddingTimeoutMs` field), done-means gains an ARRIVAL clause per value and a test that registers the tools with `OPENBRAIN_FTS_CONFIG=german` and reads `german` back; then receipt, harvest (round 36: the two-halves lesson, #779 review comment), un-draft, merge
Scope: `server/main.ts`, `server/tools/search-brain.ts`, `server/tools/types.ts`, `scripts/done-means/750-l2b1-tool-readers-take-config.sh`, one new test file
Must NOT: re-parse env; add a `?? default` for a value main.ts should pass; touch `search-all.ts` / `search-engine.ts`
Record: PR #779, then tick `realtime-stores`, `operator-doctor`, `fts-config` on #780 are N/A (already clean) — note on #780
Done-check: `bash scripts/done-means/750-l2b1-tool-readers-take-config.sh` → exit 0 with the arrival clauses (RED: not yet run — 1d0b9b2 passes the absence-only version)

## State 6 — Lane 3: server/tools/search-all.ts to standard
Tier: T1 — federated search path; behavior must not move
Deliverable: PR from `origin/main`, branch `chore/780-lint-search-all`, options objects for `searchQmdInternal`/`searchQmd` (5 params), `registerSearchAllTool` (203 lines) and its handler (complexity 19, 142 lines) extracted; tests unmodified and green
Scope: `server/tools/search-all.ts` and new helper/test files beside it
Must NOT: touch `search-engine.ts` (next handoff: its L4 split), `process.env` reads, `src/`
Record: the PR, then tick on #780
Done-check: `bash scripts/done-means/780-touched-files-lint-clean.sh` → exit 0 (RED: 49ecfbe with `DONE_MEANS_780_FILES=server/tools/search-all.ts`, 5 findings)

## State 7 — WAYFINDER QUOTA
Close: https://github.com/rodaddy/open-brain/issues/780 closes only when every checklist file is ticked and `oxlint --deny-warnings` on non-test `server/` exits 0; this session ticks its files in the same motion as each merge.

## State FINAL — WRAP
Invoke the handoff-author skill; next handoff passes the validator; `aqmd up`.

## HANDED-OVER UNKNOWNS
- Lane 1 and the docs lane may have finished, failed, or died with the authoring session; State 1 re-probe decides whether State 3 collects or re-cuts.
- Decision for Rico: whether test files carry the full 100-line function rule (2800 test findings) — `_plans/server-hardening-ladder.md:79-81`.
- Decision for Rico: Python function rule 50 vs TypeScript 100 (`_DOCS/STANDARDS-typescript.md:198-210` still says 50) — open question in the #772 PR body.
- #773 (Contract Parity two-dot diff) and #774 (switch-exhaustiveness needs oxlint-tsgolint) are filed, not started.
- `search-engine.ts` (9 findings, `max-lines`) and `langfuse-tracing.ts` (8, `max-lines`) are the next handoff: each is its L4 split pulled forward, split along `_plans/463-server-rewrite-charter.md` seams.
