# Handoff — L2b-2 env rewiring, session 5 (2026-08-26)

## State 0 — BASE
Read /Volumes/ThunderBolt/Development/_DOCS/HANDOFF-BASE.md in full
(181 lines). It is the standing contract for this session.
- Any question this document does not directly override → the rules layers
  answer it, nearest layer first.
- Anything neither the base nor this document covers → ask Rico before acting.
- Output discipline: minimum verbosity, only the context needed, output tokens
  low. If Rico wants more, he will ask.
- Layer 0.1: read open-brain/_DOCS/HANDOFF-RULES.md in full (212 lines on
  `main`). It overrides the base; this document overrides it. Rules 28-32 bind:
  head never works, own clones, at most FIVE lanes, `declare T1` first.

## State 1 — ORIENT
- `origin/main` is `3995531` (#844); session 4 merged #836-#840, #842-#844
  with receipts — MERGED (`git log --oneline origin/main -1`)
- #780 CLOSED: `oxlint --deny-warnings --ignore-pattern '**/*.test.ts' server`
  → 0 diagnostics, 136 files at 3995531 — RUNNING (same command)
- Next rung is L2b-2 (#825): `_plans/server-hardening-ladder.md:97-193`. Its
  enforcement is `no-process-env` in `.oxlintrc.json`, override allowing ONLY
  `server/config.ts` and `server/main.ts` — MERGED
- Live `process.env` code readers outside those two files at 3995531 — RUNNING
  (`rg -n 'process\.env' server --glob '!*.test.ts'`, prose excluded):
  `server/tools/search-engine.ts:124-125`, `server/tools/shared-namespace.ts:37,45,52`,
  and default parameters at `server/tools/search-all.ts:124`, `server/observability/trace-config.ts:33`
- `config.search.embeddingTimeoutMs` exists (`server/config/env-groups.ts:227`);
  L2b-1a (#779) wired four readers via `MemoryToolDependencies`: copy it — MERGED
- Clones `lane-1`..`lane-11` under `/Volumes/ThunderBolt/_tmp/open-brain/_worktrees/`
  all clean on `main` or detached at `origin/main`; lane-11 holds this branch;
  no extra worktrees — RUNNING (`cd <clone> && git status -sb`)
- Mac checkout `/Volumes/ThunderBolt/Development/open-brain` is DIRTY on
  `sprint/standards-fmt` (Rico's, on hold); lanes never work there — RUNNING
- CI flakes: #764 python-capture, #787 lease-boundary, #760 exit 127, #834 ob-backfill — RUNNING
- Reusable, temp: `/Volumes/ThunderBolt/_tmp/open-brain/_scratch/session3/{file-lane,collector}.workflow.js` — WRITTEN
- Rest of the program: ladder L2c, L3-L6; #773, #774, #826, #827, #831, #841 — MERGED
- Graph mode: converted — RUNNING (`ls scripts/done-means/` has
  `750-l2b1-tool-readers-take-config.sh`, `handoff-validates.sh`)
Re-probe before dispatching anything (live state beats this doc):
- `git log --oneline origin/main -1` → expect 3995531 or later with this PR merged
- `cd <clone> && rg -n 'process\.env' server/tools/search-engine.ts server/tools/shared-namespace.ts` → expect 5 code lines

## State 2 — LAND THE PAPERWORK
Branch: `docs/l2b2-session5` from `origin/main` — cut it once THIS document's
PR merges; if the checkout is `main` or `docs/780-sweep-session4` is merged,
switch first, never work there.
Retire: `docs/780-sweep-session4` via `gh pr merge --squash --delete-branch`. Worktrees: `none`.
Commit this handoff: branch `docs/780-sweep-session4`, path
`_DOCS/_handoff/2026-08-26-l2b2-env-rewiring-session5.md`, explicit-path
staging, `git commit -F` message file. Done by the authoring session.
Scribe: issue #825 — started: `gh issue comment 825 --body "Scribe, session 5: ..."`
Done-check: `git log -1 --stat`

## State 3 — Done-means check for L2b-2, RED first
Tier: T1 — the check every later lane in this slice is judged by
Deliverable: `scripts/done-means/750-l2b2-env-readers-take-config.sh`, modelled
on `750-l2b1-tool-readers-take-config.sh`: ABSENCE of `process.env` in the four
State 1 reader files AND ARRIVAL (composition root passes each value); no argv
Scope: that one script and its PR; own clone
Must NOT: edit any `server/` file; assert absence only (rule 25)
Record: PR, then #825 comment with the RED receipt sha
Done-check: `bash scripts/done-means/750-l2b2-env-readers-take-config.sh` → exit 1 at 3995531 (RED: not yet run)

## State 4 — search-engine.ts timeouts
Tier: T1 — search path with live callers
Deliverable: `server/tools/search-engine.ts:124-125` read
`config.search.embeddingTimeoutMs` via dependencies; the composition root that
builds `MemoryToolDependencies` passes it (two halves, rule 25). PR.
Scope: `server/tools/search-engine.ts`, the composition root, their tests; own clone
Must NOT: change the default or precedence of the two names; disable comments
Record: PR, then #825 comment
Done-check: `bash scripts/done-means/750-l2b2-env-readers-take-config.sh` → this file's block passes (RED: 3995531)

## State 5 — shared-namespace.ts dynamic reads
Tier: T1 — namespace isolation seam; every caller's resolved namespace identical
Deliverable: `server/tools/shared-namespace.ts:37,45,52` take env/config from
callers instead of `process.env[name]`; the composition root passes it;
regression tests unmodified and green. PR, sequenced after State 4 (rule 32).
Scope: that file, its callers (`rg -l shared-namespace server`), the composition root; own clone
Must NOT: change any default, trim rule, or fallback name; touch State 4 files
Record: PR, then #825 comment stating resolution is identical and how proved
Done-check: `bash scripts/done-means/750-l2b2-env-readers-take-config.sh` → this file's block passes (RED: 3995531)

## State 6 — default-parameter readers
Tier: T1 — `search-all.ts` and `trace-config.ts` default `env = process.env`
Deliverable: default removed, every caller passes the value explicitly
(`rg -n 'searchAll\(|readMcpTracingConfig' server`); one PR per file, after State 5
Scope: those two files and their callers; own clone each
Must NOT: change what either reader returns for the same input; touch State 4/5 files
Record: PR each, then #825 comment
Done-check: `bash scripts/done-means/750-l2b2-env-readers-take-config.sh` → exit 0 (RED: 3995531)

## State 7 — Enforce: no-process-env
Tier: T1 — lint config, every future commit pays it
Deliverable: `no-process-env` in `.oxlintrc.json`, override ONLY `server/config.ts`
and `server/main.ts`; pre-commit refuses a new read (throwaway file, RED then
GREEN, per `750-precommit-lint-gate-fires.sh`); ladder L2 status "L2b MERGED"
Scope: `.oxlintrc.json`, the ladder file, a State 3 script addition; own clone
Must NOT: widen the override; touch `server/` code
Record: PR, then #825 comment
Done-check: `./node_modules/.bin/oxlint --deny-warnings --ignore-pattern '**/*.test.ts' server` → exit 0 with the rule on (RED: 3995531)

## State 8 — WAYFINDER QUOTA
Close: https://github.com/rodaddy/open-brain/issues/825 closes when the State 3
script exits 0 on `origin/main` with State 7 merged; post that receipt as the
closing comment and tick the map checkbox in the same motion.

## State FINAL — WRAP
Invoke the handoff-author skill; next handoff passes the validator; `aqmd up`.

## HANDED-OVER UNKNOWNS
- Q1, since session 3: `.claude/agents/tracking-scribe.md` writes ONLY to the
  root checkout (Rico's dirty branch); sessions 3-4 scribed via comments — Rico's call.
- Q2, new: `server/main.ts:379,429,430,526` read `process.env`; the ladder
  override sanctions `main.ts`, #825 lists them as work; left — Rico decides.
- Q3, new: `_plans/750-standards-sprint-map.md` exists only on Rico's
  `sprint/standards-fmt` (d9a6b2a), no #780 line; no map tick was possible.
- #784 (CI silence, comment `5430102158`): close only if Rico accepts resolved-by-observation.
- Since session 1: test files under the function rule (`_plans/server-hardening-ladder.md:79-81`);
  Python 50 vs TS 100 (`_DOCS/STANDARDS-typescript.md:198-210`).
