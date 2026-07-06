# Plan 3F: Open Issues Local Completion Controller

Updated: 2026-07-06.

## Critical Read

Live GitHub and Project 8 state are the source of truth. Older roadmap
snapshots and untracked sidecar plans are historical evidence only.

Current live state as of 2026-07-06 during the #223 review-fix phase:

- Open PRs: 1.
  - #250 `feat(#223): define NATS JetStream foundation`
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
- #204 is closed. Do not continue stale #204 worktrees for this run.

Critical correction: the active Plan 3F surface is the 8 open issues above plus
PR #250. Closed issues may explain predecessor state, but they must not occupy
worker lanes or be counted as remaining work.

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
| #223 NATS/JetStream foundation | `feat/223-nats-jetstream-foundation` | `/Volumes/ThunderBolt/_tmp/open-brain/issue-223-nats-jetstream-foundation` | 1 controller + 2 review lanes | Finish PR #250 gauntlet and merge local foundation only | No | Do not close #223 unless issue is explicitly narrowed; current PR is `Refs #223` |
| #222 scoped hot working set | `feat/222-scoped-hot-working-set` | `/Volumes/ThunderBolt/_tmp/open-brain/issue-222-scoped-hot-working-set` | 1 implementation + 1 test/review sidecar | Exact-scope working-set contract, pack inclusion, denial tests | No | Close only with code/tests proving cross-scope isolation and TTL/budget behavior |
| #221 recovery WAL | `feat/221-recovery-wal` | `/Volumes/ThunderBolt/_tmp/open-brain/issue-221-recovery-wal` | 1 implementation + 1 adversarial/test sidecar | Quarantined recovery evidence contract, restart transitions, exclusion from normal recall | No | Close only with tests proving WAL evidence cannot leak into durable/search paths |
| #224 promotion/relegation lifecycle | `feat/224-promotion-lifecycle` | `/Volumes/ThunderBolt/_tmp/open-brain/issue-224-promotion-lifecycle` | 1 implementation + 1 domain/review sidecar | Explicit promote/relegate/discard/nominate workflow for candidate memory | No | Close only with tests proving no implicit durable/shared-kb promotion |
| #247 DreamEngine decomposition | `feat/247-dream-decomposition` | `/Volumes/ThunderBolt/_tmp/open-brain/issue-247-dream-decomposition` | 1 implementation + 1 dry-run/adversarial sidecar | Dry-run proposals for oversized entries with linked replacements | No | Close only with dry-run-by-default tests and no mutation without approval |
| #137 optional qmd deep lookup | `feat/137-optional-qmd-lookup` | `/Volumes/ThunderBolt/_tmp/open-brain/issue-137-optional-qmd-lookup` | 1 implementation/doc worker | Optional deep lookup wrapper or explicit no-op docs/tests proving qmd absence is non-fatal | No | Close only after Hermes/Open Brain recall paths are documented/tested to avoid a hard qmd dependency |
| #118 Privilege Isolation source refs | `plan/118-privilege-isolation-split` or `feat/118-source-refs-slice` | `/Volumes/ThunderBolt/_tmp/open-brain/issue-118-privilege-isolation` | 1 planning worker first, implementation workers only after split | Either split into child issues or implement one real tested source-ref slice | No | Do not close docs-only unless issue is converted to parent roadmap with child issues |
| #167 legacy collab retirement | `release/167-retire-collab` | `/Volumes/ThunderBolt/_tmp/open-brain/issue-167-retire-collab` | 1 release-planning worker only | Release/deploy checklist and preflight evidence, no mutation | Explicit approval required | Blocked for local-only; cannot close without live backup/migration/deploy/canary |

## Controller Execution Rules

1. Finish or explicitly park #250 before merging other branches that depend on
   its contract shape. It may remain open while workers start on independent
   issue branches, but the controller must keep its dirty state isolated.
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

### 1. #223 NATS/JetStream foundation

Owning boundary:
Local transport contract and bridge design for realtime Open Brain memory RPC,
with HTTP/MCP retained as fallback.

Current implementation branch:
`feat/223-nats-jetstream-foundation`.

Local status:

- In review via PR #250. Project 8 marks #223/PR #250 in review. CI passed on
  head `dcef94d`, then Claude cross-review found that planned-only NATS
  metadata should not churn the required fail-closed contract version/hash.
  Local fix keeps the required Open Brain memory contract at v14, treats
  `realtime_transport.nats_jetstream` as advisory planned metadata outside the
  required schema hash, and keeps the Python package pinned to the same server
  contract snapshot. Focused validation passed: `uv run pytest -q
  tests/test_contract.py tests/test_client.py` (`70 pass`), `uv run mypy
  src/openbrain_memory`, `uv run ruff check src tests`, and `git diff --check`.
- Local-only slice adds `docs/nats-jetstream-foundation.md` and advisory planned
  `get_contract().realtime_transport.nats_jetstream` metadata. It does not
  bump the package artifact version, required contract version, schema hash, or
  required `openbrain-memory` minimum compatibility because NATS is not runtime
  available in this slice.
- No core01 NATS install/config, live JetStream stream creation, launchd change,
  or Hermes runtime switch is in scope for this branch.
- Local validation passed after the review-fix commit: `bun test
  src/contract.test.ts` (`6 pass`), `bunx tsc --noEmit`, full `bun test`
  (`1072 pass, 50 skip, 0 fail`), focused Python contract/client pytest (`70
  pass`), full Python pytest (`193 pass, 5 skip`), `uv run mypy
  src/openbrain_memory`, `uv run ruff check src tests`, PR body validator, and
  `git diff --check`.
- Downstream rollout classification: no deploy in this PR. Required-memory
  fail-closed version/hash remains v14; planned NATS metadata is advisory and
  not runtime available. Hosted deploy, mcp2cli refresh, rtech-mcps handoff,
  rtech-hermes changes, Hermes live rollout, and canaries remain deferred to an
  approved release/deploy phase.
- Initial review findings being fixed:
  HIGH: do not raise required Python client compatibility for a planned-only
  transport; MEDIUM: do not auto-close #223 without the runtime/client slice;
  MEDIUM: split bridge/requester credential permissions and prevent broad NATS
  credentials; MEDIUM: forbid raw request/query/context persistence in
  JetStream; MEDIUM: define the future Python transport interface and fallback
  gate; LOW: remove misleading runtime capability advertisement; LOW: add
  rollback and clean stale plan wording.

Required local work:

- Document core01 NATS/JetStream config plan: ports, monitoring, storage path,
  auth boundary, streams, retention, and rollback.
- Define request/reply subjects and envelope contract, starting with
  `agent_context_pack`.
- Add local TypeScript/Python contract metadata only where it is testable
  without a live NATS server.
- Document Hermes opt-in and HTTP fallback.
- Add contract/fixture tests when code is introduced.

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

Required local work:

- Define promote/relegate/discard/nominate actions.
- Distinguish working context, recovery evidence, candidate memory, durable
  memory, and shared-kb nomination.
- Add fixture showing a user correction becomes a candidate negative example,
  not an immediate durable rule.
- Prove shared-kb nomination requires explicit promotion workflow.

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
- #223 active lane: controller finishes the Python contract transition fix on
  PR #250, reruns focused Python validation, reruns gauntlet fix-verification,
  updates the PR, and only then considers merge.
- Parallel implementation lanes after #250 is parked or clean: dispatch workers
  for #222, #221, #224, and #247 first because they have local testable owning
  boundaries and no live deploy requirement.
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
