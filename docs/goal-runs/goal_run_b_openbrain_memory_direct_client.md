# goal_run_b: OpenBrain Direct Package Client

## Objective

Unblock deeper `rtech-hermes` package adoption by making
`openbrain-memory`'s direct `OpenBrainClient` compatible with agent-role tokens,
then use that evidence to drive the next Hermes adapter migration.

Run B starts in `open-brain` because the first blocker is package-owned:
`OpenBrainClient` must not send `X-Namespace` unless the caller explicitly opts
into namespace delegation.

## Control Plane

- Open Brain repo: `rodaddy/open-brain`
- Open Brain board: Project #8, Open Brain Work Board
- Hermes repo: `rodaddy/rtech-hermes`
- Hermes board: Project #9, rtech-hermes Operational Work Board
- Controller: main Codex session
- Workers: standard subagents only; no CSV row workers
- Review rule: every PR gets a standard review swarm
- Package review rule: any PR touching `python/openbrain-memory/` includes the
  gotcha-agent lane from `docs/sme/gotcha-agent.md`

## Issue Map

### Open Brain

- [open-brain #184](https://github.com/rodaddy/open-brain/issues/184)
  - Let `openbrain_memory.OpenBrainClient` omit `X-Namespace` for agent-role
    tokens.
- [open-brain #179](https://github.com/rodaddy/open-brain/issues/179)
  - Add contract DSL to JSON Schema/tool-schema conversion, or decide an
    explicit consumer-local adapter boundary.
- [open-brain #181](https://github.com/rodaddy/open-brain/issues/181)
  - Expand lane facade, spool manager, docs, and live canary coverage.
- [open-brain #177](https://github.com/rodaddy/open-brain/issues/177)
  - Umbrella for installable/canonical package adoption.

### rtech-hermes Follow-Up

- [rtech-hermes #92](https://github.com/rodaddy/rtech-hermes/issues/92)
  - Adopt `openbrain-memory` package and retire vendored OB fork.
- [rtech-hermes #94](https://github.com/rodaddy/rtech-hermes/issues/94)
  - Replace fork with package-backed runtime adapter.
- [rtech-hermes #95](https://github.com/rodaddy/rtech-hermes/issues/95)
  - Migrate plugin clients and tool schema surfaces.
- [rtech-hermes #96](https://github.com/rodaddy/rtech-hermes/issues/96)
  - Remove duplicated transport/redaction/schema code after parity proof.

## Phase 1: Fix Direct Client Namespace Delegation

- [x] Add an `OpenBrainClient` option equivalent to
      `delegate_namespace: bool = False`.
- [x] Omit `X-Namespace` by default for normal agent-role clients.
- [x] Send `X-Namespace` only when explicit delegation is enabled.
- [x] Keep `X-Agent-Id` and `X-Role` behavior unchanged.
- [x] Preserve session lifecycle behavior for initialize, initialized,
      tool calls, and close.
- [x] Add fake-transport tests for default omission and explicit delegation.
- [x] Update README identity/namespace authority documentation.
- [x] Run focused package validation:
  - [x] `cd python/openbrain-memory && uv run pytest tests/test_client.py -q`
        passed: 45 tests.
  - [x] `cd python/openbrain-memory && uv run pytest -q` passed:
        122 passed, 1 skipped.
  - [x] `cd python/openbrain-memory && uv run ruff check src tests`
        passed.
  - [x] `cd python/openbrain-memory && uv run ruff format --check src tests`
        passed.
  - [x] `cd python/openbrain-memory && uv run mypy src/openbrain_memory`
        passed.

Completion for Phase 1:

- [x] open-brain #184 acceptance criteria are implemented and tested locally.
- [ ] PR has critical self-review, review swarm, gotcha-agent lane, and
      fix-verification evidence.
- [ ] #184 is closed only after merge and controller verification.

## Phase 2: Decide Schema Conversion Boundary

- [ ] Inspect open-brain #179 against Hermes #95 needs.
- [ ] Decide whether schema conversion belongs in `openbrain-memory` now or
      remains a Hermes-local adapter backed by package-owned DSL tests.
- [ ] If package-owned, implement/test the conversion helper in open-brain.
- [ ] If Hermes-local, record the boundary in both repos before Hermes work.

Completion for Phase 2:

- [ ] #179 has implementation or an explicit boundary decision.
- [ ] Run C deletion work is not started until this boundary is settled.

## Phase 3: Hermes Adapter Migration Prep

- [ ] Return to `rtech-hermes` after #184 lands.
- [ ] Update the Hermes adapter plan for #94/#95 from the package evidence.
- [ ] Prove a direct package facade can perform `get_contract` with an
      agent-role token before replacing provider/client code.
- [ ] Preserve Hermes session-key protection and read allowlist.
- [ ] Keep Nagatha as the first canary before Bilby or Skippy.

## goal_run_b Is Complete Only When

- [ ] #184 is merged and verified.
- [ ] Direct package client behavior is tested for both default agent mode and
      explicit delegation mode.
- [ ] The schema conversion boundary for #179/#95 is decided or implemented.
- [ ] Hermes migration work has a concrete next PR plan based on package
      evidence, not another custom client fork.
