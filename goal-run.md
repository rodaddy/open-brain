# Open Issues And PRs Roadmap Takeover

Updated: 2026-07-05 by Codex after Fable handoff.

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
  reachable from `origin/main`, or manual `workflow_dispatch` from `main` with
  `deploy_core01=true`.
- PR #240 adds `docs/local-release-deploy-sop.md` and updates `README.md` so
  local full testing, release-candidate creation, and core01 deploy verification
  are a separate release phase after PR merges.
- PR #240 live checks must be re-read for the current head before merge.
- Project 8 item for #240 is current:
  - Status: `In Review`
  - Validation: follow live PR checks for the current head.
  - Review Gate: `Fixes In Progress` while initial gauntlet findings are being
    addressed.
  - Component/Surface: `Deploy/Canary`
  - Phase: `P6 Deploy/Canary Follow-On`
  - Owner: `codex`
  - Next Action: run `pre-merge-gauntlet` for deploy trigger/SOP semantics; if
    clean, merge only with Rico approval, then cut a versioned release candidate
    and deploy via `v*` tag or manual dispatch.
- PR #240 is not merged. Do not deploy hosted Open Brain from this PR; use it to
  make deploy optional and document the release gate.

Active source plan:
`specs/open-issues-and-prs-completion-roadmap.html`

## Current Operating Mode

- Follow the roadmap as-is.
- Keep Pony/minimal-correct mode active.
- Use `pre-merge-gauntlet` for every non-trivial PR.
- Do not merge to `main` or deploy hosted Open Brain without explicit Rico
  approval.
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

Status: PR #238 open; pre-merge-gauntlet findings addressed; waiting on live CI
completion and explicit merge approval.

Current worktree:
`/Volumes/ThunderBolt/_tmp/open-brain/issue-177-openbrain-memory-package`

Current branch:
`fix/177-openbrain-memory-package` from `origin/main` at `5373c1b`.

Owning boundary:
`python/openbrain-memory` package contract: installability, public API surface,
canonical redaction policy, and package build/install proof.

Current findings:

- `pyproject.toml` already uses hatchling and supports `uv build`.
- README already documents install methods, schema helpers, contract authority,
  and canary expectations.
- `schema.py` already implements contract DSL to JSON Schema helpers, so #177's
  normalizer-home question is already mostly answered in package code.
- Closed PR #232 / branch `fix/openbrain-memory-redaction-superset` is not on
  `origin/main`; its redaction parity changes must be ported into #177.
- `dist/` is gitignored, so package artifacts should be built and proven, not
  committed.

Next #177 checklist:

1. Done: port redaction superset parity from
   `fix/openbrain-memory-redaction-superset`.
2. Done: add `py.typed` marker.
3. Done: tighten README language for stable public API, SemVer/package version,
   live contract version, and canonical redaction.
4. Done: run Python package checks:
   - `uv run mypy src/openbrain_memory` -> passed.
   - `uv run ruff check src tests` -> passed.
   - `uv run pytest -q` -> 193 passed, 5 skipped.
   - source-tree import without installed metadata -> `0.1.1`.
5. Done: build artifacts with `uv build`:
   - `dist/openbrain_memory-0.1.1.tar.gz`
   - `dist/openbrain_memory-0.1.1-py3-none-any.whl`
6. Done: install wheel into temp venv:
   `/Volumes/ThunderBolt/_tmp/open-brain/issue-177-wheel-smoke-6`.
7. Done: import/API smoke from installed wheel:
   `wheel smoke ok 0.1.1`.
   First smoke attempt failed because the sample token was below the redaction
   length threshold; rerun used a valid opaque token shape and passed.
8. Done: opened PR #238:
   https://github.com/rodaddy/open-brain/pull/238
9. Done: ran review-swarm Phase 2 on pinned diff
   `86d46614fb7c9914841d79d9715452235719b7a0524208536df3b4a9f4322527`.
   Initial findings fixed:
   - dash/underscore-bounded dotted token redaction;
   - duplicate package version source;
   - README redaction-superset wording.
10. Done: fix-verification after amended head `310e955`:
    - SME/gotcha: clean.
    - Antagonist: found source-tree import regression from import-time
      `importlib.metadata.version()`.
    - Fix: `PACKAGE_VERSION` now uses installed metadata first, then falls back
      to source `pyproject.toml`; regression test added.
11. Done: Phase 3 cross-runtime review via local `claude -p --model opus`
    because the GitHub `claude-review` workflow can produce false-positive
    success around invalid-model output.
    - Final reviewed diff SHA-256:
      `b2d207bd380c6ad079edfa4b70cdaed192c2a6b40c15d53a81b91d85381f1d65`.
    - Findings fixed/addressed: over-broad heuristic redaction of benign
      identifiers, length-only dotted-token matching, slash-bearing base64
      coverage, write-vs-display redaction boundary docs/tests, pure base62
      false-negative docs, and 40-character heuristic floor docs.
12. Pending: wait for final PR #238 CI on head `672b203`; do not merge without
    explicit Rico approval.

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
