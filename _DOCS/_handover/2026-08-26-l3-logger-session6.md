# Handover — L3 one logger threaded, session 6 (2026-08-26)

## State 0 — BASE
Read /Volumes/ThunderBolt/Development/_DOCS/HANDOVER-BASE.md in full
(181 lines). It is the standing contract for this session.
- Any question this document does not directly override → the rules layers
  answer it, nearest layer first.
- Anything neither the base nor this document covers → ask Rico before acting.
- Output discipline: minimum verbosity, only the context needed, output tokens
  low. If Rico wants more, he will ask.
- Layer 0.1: read open-brain/_DOCS/HANDOVER-RULES.md in full (221 lines on
  `main`). It overrides the base; this document overrides it. Rules 28-33
  bind: head never works, own clones, at most FIVE lanes, whole suite before push.

## State 1 — ORIENT
- `origin/main` is `9a76d31` (#856); session 5 merged #846-#859, L2 complete — MERGED (`git log --oneline origin/main -1`)
- #825 CLOSED with the closure receipt (comment 5432486529); main CI run
  33024780513 at 9a76d31 success — RUNNING (`gh run view 33024780513`)
- `oxlint --deny-warnings --ignore-pattern '**/*.test.ts' server` → 0 with
  `node/no-process-env` armed for `server/**` — RUNNING (same command)
- Next rung is L3 (`_plans/server-hardening-ladder.md:198-234`), tracked in
  #860; the hard-failure half (62 swallowing catch sites) is #748 — RUNNING
- `server/main.ts:61` is the ONLY non-test importer of `server/logging/logger.ts`
  and injects `toolLogger` at `:173`; no decorator path exists in `server/` —
  RUNNING (`rg -l 'logging/logger' server --glob '!*.test.ts'`)
- Conformance of `server/logging/logger.ts` (153 lines) to
  `_DOCS/STANDARDS-observability.md` is UNVERIFIED (ladder says check first)
- Clones `lane-1`..`lane-11` under `/Volumes/ThunderBolt/_tmp/open-brain/_worktrees/`
  clean; lane-11 holds this branch; no worktrees — RUNNING (`git status -sb`)
- Mac checkout `/Volumes/ThunderBolt/Development/open-brain` is DIRTY on
  `sprint/standards-fmt` (Rico's, on hold); lanes never work there — RUNNING
- CI flakes open: #702, #764, #769, #787, #760, #834 — RUNNING
- `750-l2b2-lint-refuses-process-env.sh` needs `_githooks/install.sh` run in
  the clone first (hooksPath precondition) — RUNNING
- Reusable, temp: `/Volumes/ThunderBolt/_tmp/open-brain/_scratch/session5/{lane,recon,collector,rebase,triage}.workflow.js` — WRITTEN
- Rest of the program: #748, ladder L4-L6; #773, #774, #826, #827, #831, #841 — MERGED
- Graph mode: converted — RUNNING (`ls scripts/done-means/` has
  `750-l2b2-env-readers-take-config.sh`, `handover-validates.sh`)
Re-probe before dispatching anything (live state beats this doc):
- `git log --oneline origin/main -1` → expect 9a76d31 or later with this PR merged
- `cd <clone> && rg -l 'logging/logger' server --glob '!*.test.ts'` → expect exactly `server/main.ts`

## State 2 — LAND THE PAPERWORK
Branch: `docs/l3-session6` from `origin/main` — cut it once THIS document's
PR merges; if the checkout is `main` or `docs/l2b2-session5` is merged,
switch first, never work there.
Retire: `docs/l2b2-session5` (this document's PR) via `git branch -d`. Worktrees: `none`.
Commit this handover: branch `docs/l2b2-session5`, path `_DOCS/_handover/2026-08-26-l3-logger-session6.md`,
explicit-path staging, `git commit -F` message file. Done by the authoring session.
Scribe: issue #860 — started: `gh issue comment 860 --body "Scribe, session 6: ..."`
Done-check: `git log -1 --stat`

## State 3 — Conformance recon, read-only
Tier: T0 — reads only, output is one issue comment
Deliverable: #860 comment "Conformance": field by field from
`_DOCS/STANDARDS-observability.md:20-66`, what `server/logging/logger.ts` emits
and lacks; every `console.` call outside `server/logging/` with file:line
Scope: read `server/logging/`, `server/main.ts`, the standard; own clone
Must NOT: edit anything; propose designs beyond the gap list
Record: #860
Done-check: `gh issue view 860 --json comments --jq '.comments[].body' | rg -c '^Conformance'` → 1

## State 4 — Done-means check for L3, RED first
Tier: T1 — the check every later lane in this slice is judged by
Deliverable: `scripts/done-means/750-l3-logger-threaded.sh`, modelled on
`750-l2b2-env-readers-take-config.sh`: exactly one `createLogger(` call in
non-test `server/` (the composition root); zero `logging/logger` imports
outside `server/main.ts` and `server/logging/`; a decorator export exists in
`server/logging/decorate.ts`; a driver test proves a thrown error inside a
decorated function logs `stack` and the correlation id. No argv.
Scope: that script, its driver, its PR; own clone
Must NOT: edit `server/` code; assert absence only (rule 25)
Record: PR, then #860 comment with the RED receipt sha
Done-check: `bash scripts/done-means/750-l3-logger-threaded.sh` → exit 1 at 9a76d31 (RED: not yet run)

## State 5 — Decorator module
Tier: T1 — new shared module every handler will pass through
Deliverable: `server/logging/decorate.ts`: a function wrapper and a class-method
decorator logging entry, exit, and failure through the injected logger, failure
lines carrying `stack` and the `context.ts` correlation id; rethrows always;
unit tests. PR, after State 4.
Scope: `server/logging/decorate.ts`, its test; own clone
Must NOT: change the logger.ts envelope or sanitize.ts; touch `server/tools/`
Record: PR, then #860 comment
Done-check: `bash scripts/done-means/750-l3-logger-threaded.sh` → decorator clauses pass (RED: 9a76d31)

## State 6 — Thread it through the composition root
Tier: T1 — every tool handler invocation changes path
Deliverable: `server/main.ts` (`handlerLogger` at `:207`, tool registration)
wraps every registered handler with the State 5 decorator once, at the root;
no per-tool edits; existing tests unmodified and green. PR, after State 5.
Scope: `server/main.ts`, the registration helper it calls, their tests; own clone
Must NOT: edit individual tool files; alter any handler's output or error shape
Record: PR, then #860 comment
Done-check: `bash scripts/done-means/750-l3-logger-threaded.sh` → exit 0; `bun run test:isolated` → 0 fail (RED: 9a76d31)

## State 7 — Ladder status
Tier: T0 — one prose file
Deliverable: `_plans/server-hardening-ladder.md` L3 status line "L3 MERGED" with PR numbers
Scope: that file; own clone
Must NOT: edit other rungs
Record: PR, then #860 comment
Done-check: `rg -n 'L3 MERGED' _plans/server-hardening-ladder.md` → 1 match

## State 8 — WAYFINDER QUOTA
Close: https://github.com/rodaddy/open-brain/issues/860 closes when the State 4
script exits 0 on `origin/main` with State 6 merged; post that receipt as the
closing comment and tick the map checkbox in the same motion.

## State FINAL — WRAP
Invoke the handover-author skill; next handover passes the validator; `aqmd up`.

## HANDED-OVER UNKNOWNS
- Q1, since session 3: `.claude/agents/tracking-scribe.md` writes ONLY to the
  root checkout (Rico's dirty branch); sessions 3-5 scribed via comments — Rico's call.
- Q2: `server/main.ts` reads `process.env` under the door override; moving them into `server/config.ts` is Rico's decision.
- Q3: `_plans/750-standards-sprint-map.md` exists only on `sprint/standards-fmt`; no map tick possible.
- Q5: `node/no-process-env` is scoped to `server/**`; 19 `src/` files still read env and retire at L6 — Rico confirms the scope.
- `src/shared-namespace.ts` twin recorded on #826 (third pair); #784 closes only if Rico accepts resolved-by-observation.
- Since session 1: test files under the function rule (`_plans/server-hardening-ladder.md:79-81`); Python 50 vs TS 100 (`_DOCS/STANDARDS-typescript.md:198-210`).
