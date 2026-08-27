# Handoff — #750 standards, session 2 (2026-08-25)

## State 0 — BASE
Read /Volumes/ThunderBolt/Development/_DOCS/HANDOFF-BASE.md in full
(181 lines). It is the standing contract for this session.
- Any question this document does not directly override → the rules layers
  answer it, nearest layer first.
- Anything needed that neither the base nor this document covers → ask Rico
  before acting.
- Output discipline: minimum verbosity, only the context needed, output
  tokens low. If Rico wants more, he will ask.
- Layer 0.1: read open-brain/_DOCS/HANDOFF-RULES.md in full (73 lines). It
  overrides the base; this document overrides it.

## State 1 — ORIENT
- Enforcement floor lands lint+typecheck on staged content — MERGED (`d3df0fd`)
- The hook rejects a violating staged file by rule name — RUNNING (`git hook run pre-commit`)
- 17 enforcement tests prove each rule fires — RUNNING (`bun test tests/enforcement.test.ts`)
- Numeric rules sit at the tree's worst case, no slack — RUNNING (`bunx oxlint -c probe.json`)
- 71 source lint violations across 7 rules, 94 more in tests — RUNNING (#752)
- No `.prettierignore`; a bulk format would rewrite 1472 files — RUNNING (#753)
- Sprint branch carries 7 unmerged recall commits under 3 standards ones — WRITTEN (`git log origin/main..HEAD`)
- Program map, sessions 2-9+ — WRITTEN (`_plans/750-standards-sprint-map.md`)
- Graph mode: converted — RUNNING (`ls scripts/done-means/*.sh` → 61)
Re-probe before dispatching anything (live state beats this doc):
- `bun test tests/enforcement.test.ts` → expect 17 pass, 0 fail
- `bunx oxlint --deny-warnings src server` → expect exit 1, 165 total

## State 2 — LAND THE PAPERWORK
Branch: `sprint/standards-fmt` from `origin/main` — cut it if absent; if the
checkout is `main` or `sprint/standards-enforcement` is merged (PR pending),
switch first, never work there.
Retire: `none` — no merged branches, no worktrees (`git worktree list` → 1, the
repo itself).
Commit this handoff: branch `sprint/standards-fmt`, path
`_DOCS/_handoff/2026-08-25-standards-session-2.md`, explicit-path staging,
`git commit -F` message file.
Scribe: #750 — started: `gh issue comment 750 --body-file <file>`
Done-check: `git log -1 --stat`

## State 3 — Open the PR for session 1
Tier: T1 — 10 commits reach `main`, 7 of them unrelated pipeline fixes
Deliverable: PR for `sprint/standards-enforcement`, body naming BOTH groups
Scope: `gh pr create` only; no code changes
Must NOT: merge it; rebase or drop the 7 recall commits; open one PR per commit
Record: #750
Done-check: `gh pr view --json number,headRefName` → names the branch (RED: not yet run)

## State 4 — .prettierignore, before any --write
Tier: T1 — decides what 1472 files a later format touches
Deliverable: `.prettierignore` excluding build artifacts and generated files
Scope: `.prettierignore`, `package.json` format globs
Must NOT: run `prettier --write` anywhere; reformat generated `_DOCS/STANDARDS-*.md` or `docs/sme/*.md`
Record: #753
Done-check: `bunx prettier --check .` → lists only intended files (RED: not yet run)

## State 5 — Reformat code, one commit, no logic
Tier: T1 — touches every code file; a logic change hiding here is invisible
Deliverable: `bunx prettier --write` over the agreed code scope, single commit
Scope: the globs State 4 settled
Must NOT: edit logic; include markdown or generated files; split across commits
Record: #750
Done-check: `bun run test:isolated` → same result as before the reformat (RED: not yet run)

## State 6 — Source lint debt, per-rule lanes
Tier: T1 — 71 violations in production code, some may be real defects
Deliverable: per-rule lanes in #752 order, easiest first, each its own commit
Scope: `src/`, `server/` source files; NOT test files (94 separate)
Must NOT: disable a rule to pass; bulk-fix `no-non-null-assertion` without reading each
Record: #752
Done-check: `bunx oxlint --deny-warnings src server` → source count below 71 (RED: d3df0fd)

## State FINAL — WRAP
Invoke the handoff-author skill; next handoff passes the validator; `aqmd up`.

## HANDED-OVER UNKNOWNS
- Markdown in the formatter's scope is Rico's call, not settled here: 701 files
  including AGENTS.md and all of `_plans/`. Detail and the recommendation
  (code-only) are in #753.
- The 7 recall/pipeline commits under this branch were never PR'd. They are
  finished and verified work from the prior session, not this sprint's. State 3
  keeps them together rather than deciding for Rico whether to split.
- `bun run check` is WRITTEN but never executed end to end; it invokes
  `test:isolated`, which needs a live Postgres.
