# Open Issues And PRs Roadmap Takeover

Updated: 2026-07-06 by Codex after Fable handoff.

## Current Controller State

Updated after the 2026-07-06 #204 merge and #176 local implementation pass.

- Open PRs: 0
- Merged in this controller batch:
  - #231 merged as `c9888cc584fe68b5ff91906d56ef26c7fb40afef`;
    post-merge `/codex-deep` smoke on #234 succeeded.
  - #233 merged as `9653cf86d0ff770eb929915c61d11ce5f0f499fc`.
  - #234 merged as `a16398c4d344f2c57ea0d508f998fcd05cbe8e07`;
    issue #165 closed at `2026-07-06T00:47:00Z`.
  - #235 merged as `2a8fd986154d7b5dc11fb0c2d690288d35530a50`.
  - #237 merged as `fefb4659f8d181e465fac584d25a57e11e672ac2`.
  - #238 merged as `ee0a7c8dc02313c4bc3bdf6a387742265a11f0a4`.
  - #239 merged as `d6389962e5b2650d9e53dbdb7d75a30b004600fa`.
  - #243 merged as `3b8e47ac5d4b3b614fdd26f5609242b73204f928`;
    issue #204 closed at `2026-07-06T01:54:16Z`.
- Prior deploy-control PR:
  - #240 is merged. Production deploy is optional/deferred and only allowed via
    the release SOP path, not automatic `main` pushes. Merge commit:
    `b12e33e22b8b97c5322ef43ea3831752652c4eeb`.
- Open issues: 11
  - #229, #224, #223, #222, #221, #192, #176, #167, #166, #137, #118.
  - #167 remains open after #237 because live backup/dry-run/execute/reconcile,
    release deploy, and downstream canary are still gated.
- Project 8 updated on 2026-07-05:
  - PR items #233, #235, #237, #238, and #239 moved to `Done` with merge
    commits in `Next Action`.
  - PR #234 and issue #165 moved to `Blocked`, with the blocker recorded as the
    missing local `workflow` OAuth scope.
- Project 8 updated on 2026-07-06:
  - #234/#165 are merged/closed; #165 is no longer open.
  - #204 moved to `Done` by merge/closure automation and `Next Action` records
    PR #243 merge commit `3b8e47ac5d4b3b614fdd26f5609242b73204f928`.
  - #176 is `In Progress`, Validation `Local Passed`, and Review Gate
    `Not Started` until PR open.
- No production deploy was performed during this batch.

## Live Inventory Correction

Updated after Rico correction on 2026-07-05.

The prior handoff status was incomplete. Live GitHub state before opening the
#236 fix PR was:

- Open PRs: 6
  - #231 `Replace Claude review workflow with Codex` - checks green, merge gate
    still requires explicit Rico approval.
  - #233 `fix(logger): 1MB rolling file sink as an app config standard (#193)` -
    checks green, issue still open.
  - #234 `ci(#165): ephemeral pgvector DB-integration job with anti-skip guard` -
    checks green, issue still open.
  - #235 `fix: rename n8n role -> ob-admin break-glass admin identity (#168)` -
    checks green, issue still open.
  - #237 `feat(#167): retire legacy collab namespace + deploy-gated migration` -
    checks green, issue still open.
  - #238 `Fix openbrain-memory package contract` - checks green, issue #177
    still open.
- Open issues: 17
  - #236 is new relative to the roadmap HTML and must be inserted as a security
    interrupt: `ob-backfill.ts: raw transcript importer writes to OB with no
    secret redaction`.
  - Roadmap issues still open: #229, #224, #223, #222, #221, #204, #193, #192,
    #177, #176, #168, #167, #166, #165, #137, #118.

Controller correction:

- Green checks are not completion.
- Do not mark the roadmap complete until PRs are merged or explicitly held,
  linked issues are closed or explicitly dispositioned, downstream rollout gates
  are classified, and the live open issue/PR count is reconciled.
- Treat #236 as a Phase 0/Phase 4 security interrupt before additional
  client/contract feature work because it can persist secrets into Open Brain.

Post-interrupt update on 2026-07-05:

- Opened PR #239 for issue #236:
  https://github.com/rodaddy/open-brain/pull/239
- Head: `d8fb934`
  (`fix/236-ob-backfill-redaction`).
- Open PRs are now 7 until #239 or another open PR is merged/closed.
- Open issues remain 17 until linked issue #236 is closed after merge.
- PR #239 CI for `d8fb934`: `check`, `python-package`, `validate`,
  `GitGuardian Security Checks`, and `claude-review` passed; deploy skipped by
  workflow.
- PR #239 local validation:
  - `bun test src/sharing.test.ts scripts/ob-backfill.test.ts` -> 59 pass.
  - `bunx tsc --noEmit` -> passed.
  - `git diff --check` -> passed.
  - `bun test` -> 986 pass, 38 skip, 0 fail.
  - `ggshield secret scan commit-range HEAD~1...HEAD` -> no secrets found.
- PR #239 gauntlet status: Phases 1-4 complete. Claude/Opus final pass found no
  blocker/high/medium findings. One LOW decision-rationale behavior change was
  acknowledged as intentional in the PR receipt:
  https://github.com/rodaddy/open-brain/pull/239#issuecomment-4886800246
- PR #239 is not merged. Do not close #236 or mark roadmap complete until merge
  and issue closure/disposition are verified.

Deploy optionality update on 2026-07-05:

- Opened PR #240:
  https://github.com/rodaddy/open-brain/pull/240
- Branch: `fix/optional-release-deploy`.
- Head/check state must be verified live before merge; do not rely on this file
  as the current SHA source of truth.
- Open PRs are now 8 until #240 or another open PR is merged/closed.
- Open issues remain 17.
- PR #240 changes deploy policy so `main` pushes validate but do not deploy.
  Production deploy is allowed only from a `v*` tag whose target commit is
  reachable from `origin/main`, or manual `workflow_dispatch` from the current
  `origin/main` tip with `deploy_core01=true`.
- PR #240 adds `docs/local-release-deploy-sop.md` and updates `README.md` so
  local full testing, release-candidate creation, and core01 deploy verification
  are a separate release phase after PR merges.
- PR #240 completed the pre-merge-gauntlet on this branch: initial swarm,
  Claude cross-review, fixes, and focused fix-verification all reached zero
  known material findings. Live checks must still be re-read for the current
  head immediately before merge.
- Project 8 item for #240 is current:
  - Status: `In Review`
  - Validation: follow live PR checks for the current head.
  - Review Gate: `Zero Known Issues` after gauntlet/fix-verification passes;
    re-read Project 8 before merge.
  - Component/Surface: `Deploy/Canary`
  - Phase: `P6 Deploy/Canary Follow-On`
  - Owner: `codex`
  - Next Action: await Rico approval to merge PR #240; after merge, cut a
    versioned release candidate and deploy via `v*` tag or manual dispatch only
    after the local release gate.
- PR #240 is not merged. Do not deploy hosted Open Brain from this PR; use it to
  make deploy optional and document the release gate.

Active source plan:
`specs/open-issues-and-prs-completion-roadmap.html`

## Current Operating Mode

- Follow the roadmap as-is.
- Keep Pony/minimal-correct mode active.
- Use `pre-merge-gauntlet` for every non-trivial PR.
- Merge gauntlet-clean PRs through GitHub only; do not deploy hosted Open Brain
  without explicit Rico approval and the release SOP gate.
- Use `/Volumes/ThunderBolt/_tmp/open-brain` for temp worktrees and build/install
  proofs.
- Current session is single-controller for implementation. Standard subagent
  tooling was exposed after tool discovery; use it only for required
  pre-merge-gauntlet review lanes. No CSV/head-down workers.

## Roadmap Progress

### Phase 1: PR #231 review workflow

Status: verified, not merged.

- PR #231 checks are green.
- Posted `/codex-deep` with `pre-merge-gauntlet` intent:
  https://github.com/rodaddy/open-brain/pull/231#issuecomment-4885081698
- Limitation: `.github/workflows/codex-review.yml` is not on default `main`, so
  the issue-comment trigger cannot enqueue until the workflow exists on `main`.
- Stop gate: do not merge without explicit approval.

### Phase 2: #165 CI DB integration, #193 rolling log cap

Status: verified locally and by PR checks, not merged.

- PR #234 (#165) local checks passed:
  - `bun run typecheck`
  - `bun test` -> 969 pass, 38 skip, 0 fail
- PR #234 CI db-integration log proved live Postgres coverage:
  17 live-Postgres testcases across 5 required suites, 0 skipped/failed/errored.
- PR #233 (#193) local checks passed:
  - `bun run typecheck`
  - `bun test` -> 976 pass, 38 skip, 0 fail

### Phase 3: #168 -> #166 -> #167 namespace/auth cleanup

Status: verified locally and by PR checks, not merged.

- PR #235 (#168) local checks passed:
  - `bun run typecheck`
  - `bun test` -> 984 pass, 38 skip, 0 fail
- PR #237 (#167) local checks passed:
  - `bun run typecheck`
  - `bun test` -> 973 pass, 46 skip, 0 fail
- Deploy/migration gates remain documented on the PRs.

### Phase 4: #177 installable package, #204 resolver, #176 structured rejection

Status: #177 is done via merged PR #238. #204 is done via merged PR #243.
#176 is the active local-only slice.

Current #176 worktree:
`/Volumes/ThunderBolt/_tmp/open-brain/issue-176-structured-rejection`

Current #176 branch:
`feat/176-structured-rejection` from `origin/main` at
`3b8e47ac5d4b3b614fdd26f5609242b73204f928`.

Owning boundary:
The share-candidate rejection classifier/result contract, with the public
`get_contract` manifest and `python/openbrain-memory` snapshot as downstream
contract mirrors. The response/log/DB safety invariant is that no offending
secret or private content is echoed.

Current #204 state:

1. Done locally: implemented read-only `resolve_entry(id, namespace?)`.
2. Done locally: registered the tool in `src/tools/index.ts`.
3. Done locally: bumped the public contract to
   `2026-07-05.memory-tools.v12` and added `resolve_entry` schema/capability
   metadata.
4. Done locally: updated `python/openbrain-memory` constants/help and added the
   `OpenBrainClient.resolve_entry()` wrapper.
5. Done locally: resolver tests cover readable found rows, admin-only archived
   rows, non-admin archived non-disclosure, no-readable-family roles, explicit
   unreadable namespaces, and `namespace: "all"` for global admin reads.
6. Validation passed locally:
   - `bun test src/tools/__tests__/resolve-entry.test.ts src/contract.test.ts`
     -> 12 pass.
   - `bunx tsc --noEmit` -> passed.
   - `bun test` -> 1040 pass, 46 skip, 0 fail.
   - `cd python/openbrain-memory && uv run pytest -q` -> 193 pass, 5 skip.
   - `cd python/openbrain-memory && uv run mypy src/openbrain_memory` ->
     passed.
   - `cd python/openbrain-memory && uv run ruff check src tests` -> passed.
   - `git diff --check` -> passed.
7. PR #243 opened:
   https://github.com/rodaddy/open-brain/pull/243
8. Pre-merge-gauntlet Phase 2 initial swarm found and local fixes addressed:
   - P2: non-admin archived UUID resolution disclosed source/namespace
     metadata; fixed by limiting archived resolution to admin/ob-admin and
     adding non-admin non-disclosure tests.
   - P2: `openbrain-memory` min compatible version remained `0.1.0` after a
     required wrapper/contract change; fixed by bumping package version and
     manifest floor/range to `0.1.2`.
   - P3: Python wrapper dispatch test omitted `resolve_entry`; fixed by adding
     it to the wrapper-name dispatch regression.
9. PR #243 fix receipt posted:
   https://github.com/rodaddy/open-brain/pull/243#issuecomment-4888294598
10. CI passed on amended head `ddc8bb611979fd93e28d3e40989fab163e30589e`:
    `check`, `db-integration`, `python-package`, PR body `validate`, and
    GitGuardian passed; `deploy` skipped as expected for local-only PR flow.
11. Project 8 updated for #204: Status `In Review`, Validation `CI Passed`,
    Review Gate `Fix Verification Running`, Next Action points to PR #243
    fix-verification and no core01 deploy in this phase.
12. Opposite-runtime Claude cross-review ran on PR #243 and found three LOW
    observations:
    - Promoter role resolves cross-namespace UUIDs. This is existing
      get_entry/read-policy parity for promotion candidates and is now pinned by
      resolver coverage.
    - Negative responses expose `checked_sources`/`checked_tables`. This is
      intentional contract diagnostics for the requested tool shape and does
      not expose unreadable row metadata.
    - Cross-table UUID collision behavior was undocumented. The resolver now
      documents first-match `SOURCE_TABLES` order and the global UUID
      uniqueness assumption.
13. Focused validation after cross-review fixes:
    - `bun test src/tools/__tests__/resolve-entry.test.ts src/contract.test.ts`
      -> 13 pass.
    - `cd python/openbrain-memory && uv run pytest -q tests/test_client.py tests/test_contract.py`
      -> 69 pass.
    - `git diff --check` -> passed.
14. Done: PR #243 merged as
    `3b8e47ac5d4b3b614fdd26f5609242b73204f928`; issue #204 closed at
    `2026-07-06T01:54:16Z`.
15. Deferred by current local-only instruction: downstream rollout and any
   core01 deploy/live canary. This contract change still triggers
   `docs/downstream-rollout.md` before issue closure/release.

Current #176 state:

1. Done locally: structured non-leaking `reject_detail` for sync
   `share_candidate` rejections with `category`, safe `matched_kind`,
   `span_count`, `redaction_hint`, `resubmittable`,
   `resubmit_attempt`, and `max_resubmit_attempts`.
2. Done locally: bounded sanitized resend metadata via
   `reject_detail.resubmit_metadata.sanitized_resubmit_of` and
   `sanitized_resubmit_attempt`, with max attempt 2.
3. Done locally: contract bump to `2026-07-06.memory-tools.v13`;
   `append_session_event` tool contract version 6; manifest floor/range and
   `python/openbrain-memory` package version bumped to `0.1.3`.
4. Done locally: rejection logs expose only safe classifier metadata
   (`matched_kind`, `span_count`, `resubmittable`) and never the matched
   content.
5. Done locally: tests cover secret structured rejection, private structured
   rejection, string `"true"` nomination parity, non-resubmittable repeated
   sanitized rejection at the bound, server-enforced protection against a reset
   `sanitized_resubmit_attempt`, and clean sanitized resend acceptance.
6. Validation passed locally:
   - `bun test src/sharing.test.ts src/tools/__tests__/append-session-event.test.ts src/contract.test.ts`
     -> 90 pass, 5 skip, 0 fail.
   - `bunx tsc --noEmit` -> passed.
   - `bun test` -> 1055 pass, 46 skip, 0 fail.
   - `cd python/openbrain-memory && uv run pytest -q tests/test_client.py tests/test_contract.py`
     -> 69 pass.
   - `cd python/openbrain-memory && uv run mypy src/openbrain_memory` ->
     passed.
   - `cd python/openbrain-memory && uv run ruff check src tests` -> passed.
   - `git diff --check` -> passed.
   - `ggshield secret scan path -y <changed files>` -> no secrets found.
7. Phase 1 critical pass ran and found one material issue: the first
   implementation trusted the client-supplied resend attempt too much. Fixed
   before PR by counting prior rejected resubmits in the same lane and using
   the larger of client-supplied and server-observed attempts.
8. Pending: commit/push, open PR, then run Phase 2 swarm, Phase 3
   opposite-runtime cross-review, Phase 4 fixes/waivers, and Phase 5 merge only
   after the gate is clean.
9. Deferred by current local-only instruction: downstream rollout and any
   core01 deploy/live canary. This contract change triggers
   `docs/downstream-rollout.md`; downstream rollout waits for the later release
   phase.

---

# Open Brain Agent Memory Substrate Goal Run

## Goal

Build Open Brain into a first-class local agent memory substrate through the
local-complete slice of the project, proving behavior locally before any hosted
Open Brain rollout or downstream Hermes/mcp2cli deployment.

The run should complete the local implementation and validation work for issues
#207-#215, then stop at #216 for hosted/downstream rollout approval.

## Current Branch

`feat/memory-substrate-adapter-contract`

Branch source: clean `main` after PR #217 merged.

## Operating Mode

Use Pony/minimal-correct mode:

- Identify the owning boundary before editing.
- Make the smallest correct owned change.
- Preserve existing callers, auth boundaries, namespace behavior, and contract
  invariants.
- Prefer existing repo patterns and helpers.
- Verify each meaningful slice before advancing.

Use critical thinking by default:

- Challenge weak assumptions once.
- Surface concrete security, migration, and downstream risks.
- Ask when ambiguity changes implementation.
- Do not hide residual risk behind "done" language.

Use loop-engineering:

- Load and follow `/Volumes/ThunderBolt/Development/_ob/skills/loop-engineering/SKILL.md`.
- Treat loops as recurring jobs with memory, triggers, receipts, handoffs, and
  human stop conditions; do not treat ordinary implementation phases as loops.
- Use the local Codex skill only as an adapter. The shared `_ob` skill owns the
  operating procedure.

Use the project temp root:

- Put all temp files, scratch artifacts, and worktrees for this run under
  `/Volumes/ThunderBolt/_tmp/open-brain`.
- Move no-longer-needed files to `/Volumes/ThunderBolt/_tmp/open-brain/_archive`.
- Do not use `rm -f` or `rm -rf` for this goal run.

Use pre-PR critical review:

- Before opening or marking a PR ready, run the critical self-review gate.
- Do not use the CSV subagent method.
- For review swarms, create one temporary worktree per reviewer under
  `/Volumes/ThunderBolt/_tmp/open-brain` and give each reviewer a pinned prompt.
- For larger PRs, API contracts, REST structures, or public client behavior,
  include an alternate review with `claude -p` using an Opus 4.8-class model
  when available.

## Goal Boundary

### In Scope For Local Completion

- #207 Define agent memory adapter contract.
- #210 Define receipt schema and provenance model.
- #209 Add TypeScript thin client memory wrapper.
- #208 Wire Codex local lifecycle memory adapter.
- #213 Wire Hermes lifecycle memory adapter contract.
- #212 Add receipt capture helpers and tests.
- #211 Harden share-candidate promotion provenance.
- #215 Add OKF disclosure export bundle.
- #214 Add memory substrate eval harness.

### Stop Gate

- #216 Run downstream rollout and hosted canaries.

Do not deploy hosted Open Brain, refresh mcp2cli generated skills, or run Hermes
live canaries until the local-complete slice passes and Rico approves the rollout
phase.

## Open Decisions

These should be resolved before or during the first planning loop:

1. Branching shape: default to one implementation branch for the local-complete
   slice unless the diff becomes too large or independent PRs become safer.
2. PR shape: default to one PR for the local-complete slice with issue checklist
   evidence, unless review risk argues for split PRs.
3. Review gate: default to required review-swarm before merge because this work
   changes public contract/client/runtime behavior.
4. Closed Brain depth: implement lightweight Open Brain receipt hooks and schema
   now; document stricter Closed Brain requirements without enforcing them yet.
5. Hermes depth: implement Open Brain-side contract/fixtures first; only touch
   rtech-hermes in a separate downstream branch if the local contract cannot be
   validated otherwise.

## Source Of Truth Order

1. Live repo files and tests.
2. GitHub issues #207-#216 and Project 8 board fields.
3. Open Brain repo memory lane when prior decisions matter.
4. qmd/source search for indexed code context.
5. Conversation summaries or memory.

## Looping Method

Run this project through loop-engineering, not a phase checklist. Each loop is a
named recurring job that can wake, read state, act inside bounds, leave receipts,
handoff to another loop, or stop for Rico.

### Controller Shape

```text
wake
-> refresh world state
-> choose next bounded loop
-> run worker/reviewer/tooling
-> verify evidence
-> write receipts, memory, and board updates
-> decide continue, stop, or handoff
```

The controller owns sequencing and readiness decisions. Worker/reviewer loops
produce evidence; they do not declare the goal complete.

### Required Loop Spec

Each named loop must define:

- `trigger`
- `state read`
- `allowed actions`
- `required receipts`
- `handoff signals`
- `human stop conditions`
- `memory update`
- `next wake condition`

### Named Loops For This Run

#### `goal-controller-loop`

- Trigger: start, resume, compaction recovery, phase change, completed loop, or
  blocker handoff.
- State read: active policies/SOPs, `pwd`, branch, dirty state, issues #207-#216,
  Project 8 board fields, `goal-run.md`, and latest local validation receipts.
- Allowed actions: select next bounded loop, assign temp worktrees, update
  local progress, and stop at approval gates.
- Required receipts: selected loop, source state read, reason for next action,
  blocker or handoff.
- Handoff signals: issue ready for implementation, review needed, board sync
  needed, memory capture needed, rollout gate reached.
- Human stop conditions: hosted rollout, destructive cleanup, unclear scope,
  protected branch mutation, or unresolved authority conflict.
- Memory update: capture durable process learnings in OB when discovered.
- Next wake condition: after each loop receipt or user-approved continuation.

#### `issue-execution-loop`

- Trigger: controller selects an issue or tightly-coupled issue pair.
- State read: issue body/comments, affected source/tests/docs, related contract
  docs, qmd/OB only as candidate context, and current branch diff.
- Allowed actions: implement the smallest owned slice, add focused tests/docs,
  and run targeted checks.
- Required receipts: files touched, commands run, test result, issue evidence,
  and residual risk.
- Handoff signals: slice verified, review needed, board update needed, or
  blocked by missing decision.
- Human stop conditions: auth/namespace semantic expansion, downstream repo
  mutation, hosted deployment, or ambiguous public contract change.
- Memory update: only durable gotchas or reusable process corrections.
- Next wake condition: targeted verification complete or blocker reached.

#### `critical-review-loop`

- Trigger: meaningful diff before PR, public contract/API change, REST/client
  behavior change, or controller request.
- State read: pinned diff, relevant tests, `docs/sme/`, PR requirements, and
  critical self-review template.
- Allowed actions: create reviewer worktrees under
  `/Volumes/ThunderBolt/_tmp/open-brain`, run reviewer prompts, collect findings,
  and drive fixes.
- Required receipts: reviewers used, prompts/worktrees, findings, fixes made,
  and residual risk.
- Handoff signals: fix loop needed, PR ready, or Rico decision needed.
- Human stop conditions: review requires unavailable model/tooling, findings
  imply scope expansion, or fix would cross rollout gate.
- Memory update: promote missed-review patterns to `docs/sme/` or OB.
- Next wake condition: after each fix/review cycle.

#### `receipt-provenance-loop`

- Trigger: any loop changes files, issues, boards, memory, PRs, or validation
  state.
- State read: diff, command outputs, issue/board state, touched files, source
  documents, and test artifacts.
- Allowed actions: write compact receipts to docs/issues/PR/OB as appropriate.
- Required receipts: what changed, sources/tools used, files/issues/hosts
  touched, verification evidence, handoffs, and uncertainty.
- Handoff signals: board sync, memory capture, PR body update, or Closed Brain
  strict receipt follow-up.
- Human stop conditions: receipt would expose secrets, raw transcripts, or
  private source bodies.
- Memory update: OB event only for high-signal durable facts.
- Next wake condition: after every acting loop.

#### `board-sync-loop`

- Trigger: issue status changes, validation completes/fails, review gate changes,
  or PR state changes.
- State read: live GitHub issue/PR state and Project 8 board fields.
- Allowed actions: update Status, Validation, Review Gate, Target Date, Owner,
  and Next Action when the source evidence supports it.
- Required receipts: fields changed and evidence source.
- Handoff signals: next issue selected, review needed, or hosted gate reached.
- Human stop conditions: bulk closure, uncertain issue ownership, or board fields
  not matching live work.
- Memory update: none unless a durable board-process rule is learned.
- Next wake condition: after each completed issue slice or PR state change.

#### `memory-capture-loop`

- Trigger: durable process correction, reusable gotcha, workflow rule, or
  handoff-worthy fact appears.
- State read: current source-backed evidence and existing docs/OB context.
- Allowed actions: append high-signal OB process memory; update repo docs when
  that is the owning boundary.
- Required receipts: memory event id or doc path changed.
- Handoff signals: future goal-controller-loop can retrieve the fact.
- Human stop conditions: memory would include secrets, raw logs, transcript
  dumps, or speculative facts.
- Memory update: this loop is the memory update.
- Next wake condition: next durable learning.

#### `downstream-rollout-loop`

- Trigger: local-complete PR merged and Rico approves #216.
- State read: `docs/downstream-rollout.md`, mcp2cli/rtech-hermes requirements,
  hosted Open Brain deploy state, and canary checklist.
- Allowed actions: prepare rollout checklist and evidence template before
  approval; execute rollout only after approval.
- Required receipts: rollout scope, versions, commands, canary evidence, and
  rollback notes.
- Handoff signals: hosted-canary-loop.
- Human stop conditions: all #216 execution before approval.
- Memory update: rollout facts and gotchas after approval.
- Next wake condition: Rico approval for #216.

#### `hosted-canary-loop`

- Trigger: downstream-rollout-loop emits approved hosted validation handoff.
- State read: hosted service version, logs, health checks, mcp2cli generated
  client behavior, Hermes canary, and rollback path.
- Allowed actions: run approved canaries and record evidence.
- Required receipts: exact hosted version, checks run, results, errors, and
  rollback readiness.
- Handoff signals: rollout complete, fix loop needed, or rollback decision.
- Human stop conditions: unapproved deploy, auth/secret uncertainty, or live
  behavior regression.
- Memory update: hosted operational gotchas and final receipt.
- Next wake condition: approved rollout/canary window.

### Validation Checks

Run the narrowest useful checks first, then broaden when the surface expands:

- TypeScript:
  - `bunx tsc --noEmit`
  - targeted `bun test ...`
  - full `bun test` before PR readiness when practical
- Python:
  - `uv run mypy src/openbrain_memory`
  - `uv run ruff check src tests`
  - targeted `uv run pytest ...`
  - full package pytest before PR readiness when practical
- Scripts:
  - `/opt/homebrew/bin/bash -n <script>`
- Evals:
  - memory substrate fixture runner once #214 exists
- Git:
  - `git diff --check`

If a check cannot run, record the exact blocker and residual risk.

## Issue Execution Order

### Phase A: Contract And Receipts

1. #207 Adapter contract.
2. #210 Receipt/provenance model.

Exit criteria:

- Adapter surface is documented and testable.
- Receipt schema distinguishes lightweight OB receipts from Closed Brain strict
  receipts.
- Contract/docs identify exact server/client ownership.

### Phase B: Client Runtime

3. #209 TypeScript thin client wrapper.
4. #212 Receipt capture helpers and tests.
5. #208 Codex lifecycle adapter.
6. #213 Hermes adapter contract.

Exit criteria:

- Local clients can call lifecycle helpers without raw MCP call composition.
- Receipt helpers can write bounded, citation-safe event metadata.
- Codex compact/wrap can preserve lane context and dirty state.
- Hermes identity/channel/thread mapping is specified and fixture-tested.

### Phase C: Promotion And Disclosure

7. #211 Promotion provenance hardening.
8. #215 OKF disclosure export bundle.

Exit criteria:

- Private/secret share candidates are rejected before promotion.
- Promotion retains safe provenance back to the source lane/event.
- OKF-like export creates deterministic index/log/concept/citation surfaces
  without becoming storage.

### Phase D: Evals And Local Done

9. #214 Memory substrate eval harness.

Exit criteria:

- Evals cover compaction recovery, private-data non-promotion, receipts, recall
  of names/repos/dates/channels/files, and linked graph context.
- Local validation evidence is complete enough to open/mark the PR ready.

### Phase E: Hosted Stop Gate

10. #216 Downstream rollout and hosted canaries.

Exit criteria:

- Do not execute without explicit approval.
- Prepare rollout checklist and evidence template only.

## Local Definition Of Done

The local-complete goal run is done when:

- #207-#215 are implemented or explicitly narrowed with Rico approval.
- Tests/evals pass locally.
- No known P0/P1/P2 review findings remain unresolved.
- PR body includes:
  - validation evidence
  - critical self-review
  - review gate
  - downstream rollout classification
- Project 8 board reflects current Status, Validation, Review Gate, Target Date,
  Owner, and Next Action for #207-#216.
- #216 remains the explicit hosted rollout gate.

## Hard Stop Conditions

Stop and ask Rico before:

- deploying hosted Open Brain
- mutating rtech-hermes outside an explicitly approved branch
- changing auth/namespace semantics beyond the issue scope
- promoting imported OKF content automatically
- storing raw transcripts, secrets, tokens, or private source bodies
- bypassing review-swarm/merge guards

## First Next Action

Start with #207 and #210 together:

1. Inspect existing contract surfaces in `src/contract.ts`,
   `src/contract-schemas.ts`, `python/openbrain-memory/src/openbrain_memory/`,
   and `docs/memory-contract.md`.
2. Draft the adapter contract and receipt schema as docs/types.
3. Add tests that pin public contract discoverability if new contract fields are
   added.
4. Update Project 8 statuses for #207 and #210 to `In Progress`.
