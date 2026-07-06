# Plan 3F: Open Issues Local Completion Controller

Updated: 2026-07-06.

## Critical Read

Live GitHub and Project 8 state are the source of truth. Older roadmap
snapshots and untracked sidecar plans are historical evidence only.

Confirmed live state when this plan was created:

- Open PRs: 0.
- Open issues: 9.
  - #247 `Design DreamEngine decomposition for oversized Open Brain entries`
  - #229 `Operational hardening for realtime first-write lanes (follow-up to #228)`
  - #224 `Define client-owned promotion and relegation lifecycle for realtime memory`
  - #223 `Add NATS and JetStream foundation for realtime Open Brain transport`
  - #222 `Add scoped hot working set for realtime agent sessions`
  - #221 `Add recovery WAL for interrupted realtime agent sessions`
  - #167 `Retire legacy collab namespace (99.4% mirrored to shared-kb, frozen)`
  - #137 `Optional: controlled remote qmd deep-lookup wrapper`
  - #118 `roadmap: file references for Privilege Isolation / closed-brain deployments`
- #192 is closed by PR #246; its DreamEngine decomposition follow-up is #247.
- #204 is closed. Do not continue stale #204 worktrees for this run.

Critical correction: issue sequence and closure order are not identical. The
realtime epic sequencing starts with #223, but the best local closure move is
#229 first because it has concrete named defects, direct tests, and no required
core01 deploy.

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

## Issue Order

### 1. #229 first-write lane hardening

Owning boundary:
`append_session_event.create_if_missing` lane creation and lane lifecycle
metadata.

Required local work:

- F6: make lane-create + event-insert atomic, or add the smallest helper needed
  to make that boundary atomic.
- F8: implement first-write lane embedding parity with `lane_upsert`, unless
  source inspection proves non-embedding is intentional and tested.
- F7: add idle-lane TTL/reaper only if it is small at the lane lifecycle
  boundary. If it expands into scheduler/ops design, split it and do not close
  #229 without narrowing the issue on GitHub.

Verification:

- Focused transaction rollback/no-orphan-lane test.
- Focused embedding parity or documented divergence test.
- Existing append-session-event/lane tests.
- `bunx tsc --noEmit`.
- Full `bun test` if shared DB/tool helpers are touched.

### 2. #223 NATS/JetStream foundation

Owning boundary:
Local transport contract and bridge design for realtime Open Brain memory RPC,
with HTTP/MCP retained as fallback.

Required local work:

- Document core01 NATS/JetStream config plan: ports, monitoring, storage path,
  auth boundary, streams, retention, and rollback.
- Define request/reply subjects and envelope contract, starting with
  `agent_context_pack`.
- Add local TypeScript/Python stubs only if they are testable without a live
  NATS server.
- Document Hermes opt-in and HTTP fallback.
- Add contract/fixture tests when code is introduced.

Deferred:
core01 install/config, hosted canary, and making NATS the default Hermes path.

### 3. #222 scoped hot working set

Owning boundary:
Exact-scope working-set contract and budget/TTL model, excluded from durable
recall.

Required local work:

- Define exact scope key and `working_set` shape.
- Include working-set items in `agent_context_pack` only on exact-scope match.
- Label working-set content as working context, not durable memory.
- Add cross-scope denial tests.
- Document or implement dropped/expired/trimmed counters.

### 4. #221 recovery WAL

Owning boundary:
Recovery evidence tier for interrupted sessions, separate from durable memory.

Required local work:

- Define WAL/index contract and recovery statuses/actions.
- Keep recovery content out of ordinary `search_all`, `brain_answer`, and
  shared-kb paths.
- Add contract-level restart/recovery transition tests.
- Mark recovery content as unreviewed/quarantined in context-pack output.

### 5. #224 promotion/relegation lifecycle

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

### 6. #247 DreamEngine decomposition

Owning boundary:
DreamEngine dry-run proposal workflow for oversized entries.

Required local work:

- Detect oversized entries by source family.
- Produce smaller linked replacement proposals in dry-run output.
- Require explicit approval before archive/promote/demote/tier mutation or
  replacement writes.
- Preserve namespace-safe provenance.
- Add tests proving dry-run-by-default.

### 7. #137 optional qmd deep lookup

Owning boundary:
Optional deep-lookup escape hatch, not the Open Brain/Hermes memory contract.

Required local work:

- Keep qmd lookup optional and non-fatal.
- Document trusted host and identity assumptions.
- Prove Hermes startup, recall, writes, current memory, and repo facts do not
  depend on qmd availability.

### 8. #118 Privilege Isolation source refs

Critical correction:
This issue is not closable with docs-only while its acceptance criteria require
source-ref storage, retrieval filters, server-side matter isolation, answer
citations, and leakage tests.

Allowed paths:

- Implement a real first source-ref slice with tests; or
- Convert #118 into a parent roadmap issue with child issues for schema,
  ingestion, retrieval filters, answer citations, and audit logs.

### 9. #167 legacy collab retirement

Status:
Blocked for local-only work.

Reason:
Remaining work includes live DB backup, migration dry-run/execute/reconcile,
release deploy, and downstream canary. Do not touch in the local run without
explicit release/deploy approval.

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
