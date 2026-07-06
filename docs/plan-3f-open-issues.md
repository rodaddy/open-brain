# Plan 3F: Open Issues Local Completion Controller

Updated: 2026-07-06.

## Critical Read

Live GitHub and Project 8 state are the source of truth. Older roadmap
snapshots and untracked sidecar plans are historical evidence only.

Current live state as of 2026-07-06 11:35 EDT during the #224 local-validation
phase:

- Open PRs: 0.
- Open issues: 8.
  - #247 `Design DreamEngine decomposition for oversized Open Brain entries`
  - #224 `Define client-owned promotion and relegation lifecycle for realtime memory`
  - #223 `Add NATS and JetStream foundation for realtime Open Brain transport`
  - #222 `Add scoped hot working set for realtime agent sessions`
  - #221 `Add recovery WAL for interrupted realtime agent sessions`
  - #167 `Retire legacy collab namespace (99.4% mirrored to shared-kb, frozen)`
  - #137 `Optional: controlled remote qmd deep-lookup wrapper`
  - #118 `roadmap: file references for Privilege Isolation / closed-brain deployments`
- #192 is closed by PR #246; its DreamEngine decomposition follow-up is #247.
- #229 is closed by PR #249; merge commit
  `e4fc7def43735163e1e0d4997ace5ce510494f4d`. It is historical context only,
  not active Plan 3F work.
- PR #250 for the local-only #223 NATS/JetStream foundation is merged as
  `aba24c0beb1b6164dfe6270a535f3ed117646229`. It is historical context only.
  #223 remains open for the later runtime/deploy slice.
- #204 is closed. Do not continue stale #204 worktrees for this run.

Critical correction: the active Plan 3F surface is the 8 open issues above and
0 open PRs. Closed issues and merged PRs may explain predecessor state, but they
must not occupy worker lanes or be counted as remaining work.

## Operating Boundary

- Mode: local implementation and validation only.
- No core01 deploy, live DB migration, hosted NATS setup, or downstream rollout
  without explicit Rico approval.
- Use one focused branch/worktree per issue under
  `/Volumes/ThunderBolt/_tmp/open-brain`.
- Keep Project 8 current before work starts, during review, and after
  validation/merge.
- Use `pre-merge-gauntlet` for every non-trivial PR. Do not fake a review gate
  if worker/review tooling is unavailable.
- Merge only after local validation, PR CI, critical self-review, downstream
  classification, review findings/fixes, and fix verification are complete.

## Plan 3F Parallel Branch Matrix

This matrix is the controller plan for the remaining open issues. Every issue
gets at least one worker/subagent. More workers are allowed only when the work
splits into disjoint files or review lanes.

| Issue | Branch | Temp worktree | Workers | Local target | Deploy allowed | Closure rule |
| --- | --- | --- | ---: | --- | --- | --- |
| #223 NATS/JetStream runtime slice | `feat/223-nats-jetstream-runtime` | `/Volumes/ThunderBolt/_tmp/open-brain/issue-223-nats-jetstream-runtime` | 1 implementation + 1 runtime/review sidecar | Later runtime implementation only after local-only #224/#222/#221 sequencing or explicit controller decision | No | Do not close #223 from the merged foundation PR; closing requires real runtime/deploy tests or explicit issue narrowing |
| #222 scoped hot working set | `feat/222-scoped-hot-working-set` | `/Volumes/ThunderBolt/_tmp/open-brain/issue-222-scoped-hot-working-set` | 1 implementation + 1 test/review sidecar | Exact-scope working-set contract, pack inclusion, denial tests | No | Close only with code/tests proving cross-scope isolation and TTL/budget behavior |
| #221 recovery WAL | `feat/221-recovery-wal` | `/Volumes/ThunderBolt/_tmp/open-brain/issue-221-recovery-wal` | 1 implementation + 1 adversarial/test sidecar | Quarantined recovery evidence contract, restart transitions, exclusion from normal recall | No | Close only with tests proving WAL evidence cannot leak into durable/search paths |
| #224 promotion/relegation lifecycle | `feat/224-promotion-lifecycle` | `/Volumes/ThunderBolt/_tmp/open-brain/issue-224-promotion-lifecycle` | 1 implementation + 1 domain/review sidecar | Explicit promote/relegate/discard/nominate workflow for candidate memory | No | Close only with tests proving no implicit durable/shared-kb promotion |
| #247 DreamEngine decomposition | `feat/247-dream-decomposition` | `/Volumes/ThunderBolt/_tmp/open-brain/issue-247-dream-decomposition` | 1 implementation + 1 dry-run/adversarial sidecar | Dry-run proposals for oversized entries with linked replacements | No | Close only with dry-run-by-default tests and no mutation without approval |
| #137 optional qmd deep lookup | `feat/137-optional-qmd-lookup` | `/Volumes/ThunderBolt/_tmp/open-brain/issue-137-optional-qmd-lookup` | 1 implementation/doc worker | Optional deep lookup wrapper or explicit no-op docs/tests proving qmd absence is non-fatal | No | Close only after Hermes/Open Brain recall paths are documented/tested to avoid a hard qmd dependency |
| #118 Privilege Isolation source refs | `plan/118-privilege-isolation-split` or `feat/118-source-refs-slice` | `/Volumes/ThunderBolt/_tmp/open-brain/issue-118-privilege-isolation` | 1 planning worker first, implementation workers only after split | Either split into child issues or implement one real tested source-ref slice | No | Do not close docs-only unless issue is converted to parent roadmap with child issues |
| #167 legacy collab retirement | `release/167-retire-collab` | `/Volumes/ThunderBolt/_tmp/open-brain/issue-167-retire-collab` | 1 release-planning worker only | Release/deploy checklist and preflight evidence, no mutation | Explicit approval required | Blocked for local-only; cannot close without live backup/migration/deploy/canary |

## Controller Execution Rules

1. Treat PR #250 as merged historical context. Do not reopen its branch as
   active work. #223 remains open for a future runtime/deploy slice.
2. Create each worktree from fresh `origin/main` unless the issue intentionally
   builds on a merged predecessor. If a predecessor is not merged, the dependent
   branch may only inspect it or stack with an explicit note in Plan 3F.
3. Move Project 8 before dispatch: `Status: In Progress`, `Review Gate: Not
   Started`, `Validation: Not Started`, and `Next Action` naming the worker and
   branch.
4. Workers may implement only their issue's owned boundary and must report
   files changed, validation run, blockers, and whether downstream rollout
   applies.
5. Controller runs critical-mode on each branch before PR. A branch that cannot
   state its owning boundary and tests is not PR-ready.
6. Every non-trivial PR runs `pre-merge-gauntlet`: critical receipt, initial
   swarm, cross-model review, all findings fixed or explicitly waived on the PR,
   fix-verification, then merge. No auto-merge.
7. Deploy remains optional and separate. Local completion can merge code/docs
   that are explicitly inactive or gated, but live core01 changes require a
   release plan and Rico approval.

## Open Issue Execution Order

### 1. #223 NATS/JetStream runtime follow-up

Owning boundary:
Runtime transport implementation and release/deploy gate for realtime Open
Brain memory RPC, with HTTP/MCP retained as fallback.

Current implementation branch:
None active. The local-only foundation branch is merged.

Local status:

- PR #250 merged as `aba24c0beb1b6164dfe6270a535f3ed117646229` with gauntlet
  clean, CI passed, and deploy skipped.
- The merged local-only slice adds `docs/nats-jetstream-foundation.md` and
  advisory planned `get_contract().realtime_transport.nats_jetstream` metadata.
  It does not make NATS runtime-available.
- #223 remains open for the later runtime/deploy slice. No core01 NATS
  install/config, live JetStream stream creation, launchd change, or Hermes
  runtime switch has been performed or authorized.
- Downstream rollout classification: hosted deploy, mcp2cli refresh,
  rtech-mcps handoff, rtech-hermes changes, Hermes live rollout, and canaries
  remain deferred to an approved release/deploy phase.

Future runtime/deploy work:

- Implement and test an actual NATS transport when a runtime slice is approved.
- Add live NATS parity tests and HTTP fallback tests.
- Run the release/deploy gate before any core01 install/config, live stream
  creation, launchd change, or Hermes runtime switch.

Deferred:
core01 install/config, hosted canary, and making NATS the default Hermes path.

### 2. #222 scoped hot working set

Owning boundary:
Exact-scope working-set contract and budget/TTL model, excluded from durable
recall.

Required local work:

- Define exact scope key and `working_set` shape.
- Include working-set items in `agent_context_pack` only on exact-scope match.
- Label working-set content as working context, not durable memory.
- Add cross-scope denial tests.
- Document or implement dropped/expired/trimmed counters.

### 3. #221 recovery WAL

Owning boundary:
Recovery evidence tier for interrupted sessions, separate from durable memory.

Required local work:

- Define WAL/index contract and recovery statuses/actions.
- Keep recovery content out of ordinary `search_all`, `brain_answer`, and
  shared-kb paths.
- Add contract-level restart/recovery transition tests.
- Mark recovery content as unreviewed/quarantined in context-pack output.

### 4. #224 promotion/relegation lifecycle

Owning boundary:
Explicit client actions for moving candidate memory into durable memory or
shared-kb nomination.

Active branch:
`feat/224-promotion-lifecycle` in
`/Volumes/ThunderBolt/_tmp/open-brain/issue-224-promotion-lifecycle`.

Local status:

- Pre-PR blocker fixes are applied for server-side lifecycle metadata
  validation, candidate events not auto-tiering into durable thoughts,
  `scan_namespace`/DreamEngine explicit nomination semantics, Python lifecycle
  call-shape tests, and v15 contract/hash alignment.
- Project 8 marks #224 `In Progress`, Review Gate `Zero Known Issues`, and
  Validation `Local Passed` for the pre-PR blocker pass.
- Local validation passed:
  - `bunx tsc --noEmit`
  - focused lifecycle/contract/tiering/scan/promoter tests: `210 pass`, `20`
    DB-gated skips, `0 fail`
  - full `bun test`: `1078 pass`, `51` DB/migration/live skips, `0 fail`
  - focused Python tests: `120 passed`
  - full Python pytest: `197 passed`, `5 skipped`
  - `uv run mypy src/openbrain_memory`
  - `uv run ruff check src tests`
  - `git diff --check`
- Residual local risk: DB-backed/live Postgres suites are still skipped without
  `OPENBRAIN_TEST_DATABASE_URL`; CI `db-integration` must supply that gate after
  PR. No core01 deploy is in scope.

Completed local work:

- Defined promote/relegate/discard/nominate actions.
- Distinguished working context, recovery evidence, candidate memory, durable
  memory, and shared-kb nomination in the contract/docs.
- Added tests showing lifecycle candidates remain explicit candidate events
  instead of automatic durable/shared-kb writes.
- Proved shared-kb nomination requires explicit nomination metadata.

Next local work:

- Complete critical self-review, commit/push, open PR, and run the
  pre-merge-gauntlet before any merge decision.

### 5. #247 DreamEngine decomposition

Owning boundary:
DreamEngine dry-run proposal workflow for oversized entries.

Required local work:

- Detect oversized entries by source family.
- Produce smaller linked replacement proposals in dry-run output.
- Require explicit approval before archive/promote/demote/tier mutation or
  replacement writes.
- Preserve namespace-safe provenance.
- Add tests proving dry-run-by-default.

### 6. #137 optional qmd deep lookup

Owning boundary:
Optional deep-lookup escape hatch, not the Open Brain/Hermes memory contract.

Required local work:

- Keep qmd lookup optional and non-fatal.
- Document trusted host and identity assumptions.
- Prove Hermes startup, recall, writes, current memory, and repo facts do not
  depend on qmd availability.

### 7. #118 Privilege Isolation source refs

Critical correction:
This issue is not closable with docs-only while its acceptance criteria require
source-ref storage, retrieval filters, server-side matter isolation, answer
citations, and leakage tests.

Allowed paths:

- Implement a real first source-ref slice with tests; or
- Convert #118 into a parent roadmap issue with child issues for schema,
  ingestion, retrieval filters, answer citations, and audit logs.

### 8. #167 legacy collab retirement

Status:
Blocked for local-only work.

Reason:
Remaining work includes live DB backup, migration dry-run/execute/reconcile,
release deploy, and downstream canary. Do not touch in the local run without
explicit release/deploy approval.

## Worker Dispatch Plan

- Controller lane: owns live issue/PR/board state, branch integration, PR body,
  review receipts, merge decisions, and this Plan 3F file.
- #224 active lane: controller prepares PR from
  `feat/224-promotion-lifecycle`, includes the critical self-review receipt,
  pushes the branch, opens the PR, then runs the required pre-merge-gauntlet.
- Parallel implementation lanes after #224 PR is opened or parked clean:
  dispatch workers for #222, #221, and #247 first because they have local
  testable owning boundaries and no live deploy requirement.
- Planning/disposition lanes: dispatch #137 and #118 workers after the realtime
  lanes are not blocked. #137 must prove qmd is optional; #118 must split or
  implement a real source-ref slice.
- Release-only lane: #167 is a planning/preflight worker only until Rico
  explicitly approves live backup/migration/deploy/canary work.

## Per-Issue Loop

1. Refresh live issue, Project 8 item, current `origin/main`, and dirty state.
2. Add the issue to Project 8 if missing.
3. Move the item to `In Progress`, `Review Gate: Not Started`, and
   `Validation: Not Started`; write an exact `Next Action`.
4. Create a clean worktree from `origin/main`.
5. Identify the owning boundary before editing.
6. Implement the smallest correct owned change.
7. Run focused tests and typecheck; run full suites when shared behavior is
   touched.
8. Commit, push, and open a PR with validation evidence, critical self-review,
   downstream classification, and no-deploy note.
9. Run pre-merge-gauntlet, fix findings, and run fix verification.
10. Merge and close only when acceptance criteria are actually satisfied.
11. Update Project 8 and this plan immediately after each merge/closure.

## Stop Conditions

Stop only for:

- Live deploy, core01 mutation, DB migration, or destructive cleanup requiring
  explicit approval.
- Missing review-gauntlet capability that prevents honest PR readiness.
- Acceptance criteria that cannot be met locally and must be split or waived.
- Validation failure that cannot be diagnosed without unavailable external
  state.
