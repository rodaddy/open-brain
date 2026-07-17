# Progress

Status: contract coherence updates and focused local validation complete

Current phase: ready for controller diff review and PR-boundary gates

## Scope Lock

Phase/task: first-class local runtime foundation
Issue(s): open-brain #293
Objective: expose a minimal package-owned lifecycle API and bounded JSON entry point for thin visible runtime adapters.
In scope: typed scope/config; context-pack recall; distilled capture/checkpoint/wrap; honest receipts; optional injectable fallback; content safety; fake-boundary tests; required exports/version/docs.
Original out of scope: hooks/runtime homes; server TypeScript/protocol changes; external lockfiles; GitHub mutations; raw transcripts; deployment.
The approved full-stack local canary exposed two server-owned defects required for the runtime to work: missing durable exact-scope lane hydration and unasserted lane coordinates that were not persisted. The scope therefore expanded only to the owning server tools/tests, public contract declarations, downstream rollout docs, and their shared NATS caller. The hashed required contract advances to v22; active runtime registration, provider implementation, deployment, and GitHub mutations remain out of scope.
Changed paths now remain inside the package/spec surface plus `src/tools/{agent-context-pack,append-session-event}.ts`, their tests, the shared `src/nats-bridge` caller/tests, and `docs/agent-context-pack-contract.md`.

## Implemented

- Exact-scope `agent_context_pack` recall with contract-aligned budgets and section validation.
- Fresh-scope writes establish the AgentMemory lane through `session_start` before capture/checkpoint/wrap.
- Capture sends scope coordinates as top-level `append_session_event` arguments for server-side collision checks.
- Capture metadata is scope-owned; JSON requests reject metadata, scope overrides, unknown config, and fallback argv.
- Distilled/secret/size validation covers summaries and checkpoint/wrap list fields before lane mutation.
- Structured `saved`, `spooled`, `fallback`, `lost`, `failed`, and recall `direct` receipts.
- Fixed mcp2cli argv, bounded captured output, ambient-auth documentation, and real `{"success":true,"result":...}` envelope unwrapping.
- Tool-specific fallback proof: verified the public `session_start` lane authority fields (namespace/session/agent, optional returned project), exact top-level `agent_context_pack` result scope matching live mcp2cli, and append/wrap only after verified fallback lane initialization. Exact append scope remains server-authoritative through top-level platform/server/channel/thread validation.
- Package-owned MCP sessions close after JSON execution; caller-injected clients remain caller-owned.
- Per-runtime operation lock isolates router/spool receipt state under concurrent calls.
- Console/module entry point emits JSON only and exits nonzero for failed/lost writes.
- Package version advanced compatibly from 0.1.7 to 0.1.8.

## Verification log

- `uv sync` — passed; installed editable `openbrain-memory==0.1.8`.
- `uv run ruff format --check src tests` — passed; 21 files already formatted.
- `uv run ruff check src tests` — passed.
- `uv run mypy src/openbrain_memory` — passed; 12 source files.
- `uv run pytest -q tests/test_runtime.py` — passed; 30 tests.
- `uv run pytest -q` — passed; 284 passed, 5 skipped.
- `uv build` — passed; built 0.1.8 sdist and wheel.
- Installed-environment import smoke — passed for root API, `.cli`, and `.__main__`.
- `uv run pyright src tests/test_runtime.py` — passed; 0 errors.
- Workspace-root/global Pyright invocation was also attempted; it produced unresolved-environment imports plus pre-existing diagnostics in unrelated legacy tests. Running through the package uv environment resolves imports and proves the changed source/runtime test surface cleanly.
- `git diff --check` — passed.

## Package-hardening slice (2026-07-17)

- Reproduced the lane-start bug with the pre-fix regression: a failed
  `session_start` left only that prerequisite in the spool while capture was
  reported `lost`.
- Moved fixed mcp2cli fallback/router/scope verification into
  `_runtime_router.py` and ordered lifecycle spool ownership into
  `_runtime_spool.py`; public runtime API/types remain in `runtime.py`.
- `runtime.py` is 736 lines, below the repository's 750-line hard warning.
- Failed fresh-lane writes now atomically queue `session_start` followed by the
  requested capture/checkpoint/wrap through `JsonlSpool.append_batch()`. If the
  ordered pair cannot be committed, the receipt is `lost` and no orphan start
  record is added.
- Removed the redundant aggregate secret rescan from wrap metadata. The summary
  and every list item still pass the existing fail-closed per-string scan before
  persistence; a focused observable test proves one scan per persisted string.
- Package version remains `0.1.8`.

### Group-retention completion and final verification

- Ordered spool batches now retain group identity through JSONL parsing,
  redacted views, replay rewrites, and later line/byte-bound FIFO eviction.
- Replay stops dispatching the remainder of a group after a failed prerequisite,
  while successful earlier records are removed normally.
- Malformed partial group metadata is counted and skipped as corruption; legacy
  ungrouped records remain readable and replayable.
- The module CLI now selects its exit code from the bounded JSON actually emitted,
  so an oversized successful response replaced by a failed output receipt exits
  nonzero instead of contradicting stdout.
- `uv run pytest -q tests/test_runtime.py tests/test_safety.py tests/test_agent.py`
  — passed; 122 tests.
- `uv run ruff format --check src tests` — passed; 23 files already formatted.
- `uv run ruff check src tests` — passed; all checks passed.
- `uv run mypy src/openbrain_memory` — passed; 14 source files.
- `uv run pyright src tests/test_runtime.py` — passed; 0 errors, 0 warnings.
- `uv run pytest -q` — passed; 284 passed, 5 skipped.
- `uv build` — passed; built the 0.1.8 sdist and wheel.
- Public import smoke and malformed-JSON module CLI smoke — passed; the CLI
  returned a structured failed receipt and exit code 2.
- `git diff --check` — passed.

## Isolated full-stack local E2E (2026-07-17)

- Took a read-only PostgreSQL 18 custom-format logical dump from core01 and restored it into a uniquely named local database. The dump and local clone were treated as sensitive: restrictive permissions, structural/count-only inspection, no content output, and cleanup after evidence capture.
- Restored schema evidence: pgvector `0.8.2`, 27 applied migrations, 13 public tables, 19 distinct namespaces, 1,015 session lanes, 8,373 session events, and 16 `halfvec(768)` columns before canary writes.
- Started the issue branch on loopback port `13100` against the restored clone and a loopback-only 768-dimension embedding stub. `/health` reported database and embedding connectivity; NATS remained `not_runtime_available` with HTTP fallback.
- The pre-coherence local canary returned v21. Final contract reconciliation now bumps the changed hashed public contract to `2026-07-17.memory-tools.v22`; hosted verification of v22 remains a downstream rollout gate.
- Corrected stale env-gated live-canary assertions to the current public `session_start`, `append_session_event`, and checkpoint-style `session_wrap` envelopes. The live suite passed `4 passed, 1 skipped` with repo-fact writes deliberately disabled.
- Real package CLI receipts passed through the local server: direct recall `direct`; capture/checkpoint/wrap `saved` and durable; forced isolated mcp2cli recall/write `fallback`; offline grouped write `spooled`; no-spool write `lost` with exit `1`; malformed input failed with exit `2`; secret-like content was rejected before transport.
- Real JSONL replay dispatched the ordered `session_start` + `append_session_event` group and left zero records. The spool used mode `0600` and preserved group indexes `[0,1]` and group size `2`.
- The canary proved a server gap: `agent_context_pack` returned only `working_set`, while an existing lane could retain null platform/server scope. Fixed the server owning boundary so first scoped append atomically attaches missing coordinates without overwriting asserted scope, and explicitly requested `durable_lane_context` uses all seven exact coordinates and bounded distilled events.
- Compatibility decision: bump the changed hashed public contract to v22 rather than relabeling it v21. Package `0.1.8` accepts both v21 and v22 for rollout order, while the v22 manifest truthfully requires `openbrain-memory` `0.1.8` with range `>=0.1.8 <1.0.0`; package `0.1.7` pins only v21. Tool declarations advance to `agent_context_pack` v2 and `append_session_event` v8, with a regenerated deterministic schema-hash fixture.
- Null thread is no longer treated as an attachable wildcard after agent/platform/server/channel are asserted. This preserves the unthreaded lane boundary and prevents a later threaded append from reclassifying existing events.
- Post-fix live proof: one direct append persisted `shared|dev:open-brain|shared|development|local|open-brain|NULL`; durable context contained the marker; an `other-channel` append returned non-durable `lost`, persisted zero events, and mismatched recall returned one generic exact-scope denial with no durable section.
- Full server validation with separate disposable application/migration databases passed: TypeScript check, `1,357 passed, 24 skipped`, and the anti-skip guard confirmed 25 live-Postgres cases across all six required suites with zero skipped/failed/errored.
- Package validation remained green after live-test corrections: Ruff format/check, mypy, and `284 passed, 5 skipped`.
- Active Claude, Codex, and Pi configuration fingerprints remained unchanged. No active provider registration, production deploy, NATS enablement, or GitHub mutation occurred.

## Contract coherence validation (2026-07-17)

- Focused TypeScript contract/tool suite: `143 passed, 9 skipped, 0 failed` across contract, server/operator status, get-contract, context-pack, append-event, and NATS bridge tests.
- TypeScript: `tsc --noEmit` passed against the issue worktree.
- Python contract/client/live-canary suite: `110 passed, 5 skipped`; live tests remained environment-gated.
- Ruff passed for the changed Python client and contract/client/live-canary tests.
- Deterministic v22 `schema_hash`: `3f0ce606fe1fe6df02a36ab696011abca1cf08f1342045f9a6cd57c52dbb864d`.
- `git diff --check` passed. No commit, push, GitHub mutation, deploy, or live infrastructure mutation was performed.

## Alignment verifier blocker fixes (2026-07-17)

- Rechecked current `rodaddy/mcp2cli` source, README, merged PR #59, and open issue #60. Daemon-routed `cache warm` still self-calls and deadlocks; PR #59's supported coherence path is drift detection on a newly opened credentialed connection, with local/daemon cache invalidation. `credentials reload` is the supported admin reset because it clears affected caches and closes pooled connections.
- Replaced the broken required rollout command with three explicit lanes: local direct no-daemon refresh when direct auth is configured; hosted daemon credential/schema verification; and coordinated credential reload or daemon restart only when an old pool prevents self-healing.
- Corrected deployment language against `.github/workflows/ci.yml` and `scripts/core01-deploy-local.sh`: the gated deploy proves primary health and then runs a Bun regression test, so a real hosted changed-tool MCP smoke remains a separate post-workflow gate.
- Refreshed the critical self-review, residual risk, handoff, and agent-context-pack contract language for required contract v22, `agent_context_pack` v2, `append_session_event` v8, and downstream-applicable status.
- Focused TypeScript contract/tool suite rerun: `143 passed, 9 skipped, 0 failed` across seven files.
- TypeScript rerun: `node_modules/.bin/tsc --noEmit --project tsconfig.json` passed.
- Python contract/client/live-canary rerun: `110 passed, 5 skipped`; live tests remained environment-gated.
- Focused executable documentation assertions passed for issue #60 disclosure, local no-daemon qualification, daemon credential reset, deploy-smoke separation, and v22/v2/v8 declarations.
- Final `git diff --check` passed; no commit, push, deploy, credential mutation, daemon reload, or live infrastructure mutation was performed.

## Critical self-review

- Highest-risk behavior: offline fresh-lane writes could lose prerequisite/write
  ordering or retain only half of a durable pair under bounded spool eviction.
- Assumptions that could be wrong: JSONL group identity remains contiguous and
  idempotency keys remain unique; both are established by package-owned append
  code, while malformed external records fail closed as corruption.
- Missing/weak tests: no crash-injection test interrupts `os.replace()` itself;
  tests cover observable atomic batch failure, replay rewrite, grouped eviction,
  malformed metadata, and legacy compatibility.
- Security/permission risk: group metadata contains opaque generated IDs only;
  payload redaction behavior and 0600 spool/lock permissions remain unchanged.
- Migration/deploy risk: existing ungrouped JSONL records remain compatible; no
  schema migration, service deployment, or active runtime configuration changed.
- Downstream client/runtime risk: `SpoolRecord` adds optional defaulted fields and
  `JsonlSpool.append()` retains its signature; package behavior changed and must
  still be classified under `docs/downstream-rollout.md` at PR time.
- Rollback/cleanup concern: reverting grouped retention after ordered lifecycle
  batching would reintroduce misleading partial durability; rollback must revert
  the lifecycle batching and retention changes together.
- Fixes made before PR: atomic ordered batching, persisted group metadata,
  group-aware FIFO eviction, replay dependency blocking, malformed metadata
  validation, and regression coverage.
- Known residual risk: trusted local `mcp2cli` output is bounded only after
  subprocess capture.

### Full-stack critical self-review receipt

- Highest-risk behavior: attaching scope to a legacy unscoped lane must never overwrite a concurrently asserted coordinate or allow context from another namespace/channel/thread.
- Assumptions that could be wrong: `namespace + session_key` remains the lane identity while platform/server/channel/thread become immutable assertions on first scoped append; exact SQL predicates and a real conflict canary now prove that behavior.
- Missing/weak tests: no crash injection between the transactional lane attachment and event insert; the transaction boundary, concurrent-conflict test, real-Postgres test, and post-fix HTTP canary cover observable atomicity.
- Security/permission risk: durable context can expose only the auth-derived namespace and all seven exact lane coordinates. Queries reassert lane ID plus namespace/session/agent/platform/server/channel/thread; mismatches return a generic denial and do not read events.
- Migration/deploy risk: no database schema migration is required, but the hashed required contract advances from v21 to `2026-07-17.memory-tools.v22`, with `agent_context_pack` v2 and `append_session_event` v8. Existing legacy lanes gain coordinates on their first valid scoped append. Deployment must use the gated core01 workflow, then prove the hosted v22 manifest and changed tools; rollback must restore a server/package combination that agrees on the accepted v21/v22 compatibility range and must not reintroduce ambiguous unscoped lanes.
- Downstream client/runtime risk: the shared context-pack builder is now asynchronous and the NATS bridge awaits it. All in-repo callers, TypeScript checks, NATS tests, HTTP MCP canaries, and full tests pass; unknown direct TypeScript imports remain a residual compatibility risk.
- Rollback/cleanup concern: Open Brain server context hydration and package runtime behavior must stay compatible with the separately deployed Development provider; either repository can be rolled back independently only if that compatibility is preserved.
- Fixes made in this Open Brain candidate: transactional scope attachment, exact-scope durable context, async NATS caller update, public contract/tool declarations, corrected live canary assertions, and deterministic contract fixtures. Provider mcp2cli PATH/no-daemon forwarding and prioritized 3,000-character startup formatting belong to the separate Development branch and are evidence only here.
- Known residual risk: durable context has bounded prompt-bearing content and event count, but fixed envelope/citation overhead can exceed a caller's token-derived content budget; the package's 1 MB output bound remains enforced. Provider-side 3,000-character enforcement is owned and validated separately. The v22/v2/v8 contract is locally verified but not hosted or downstream-activated, and daemon-routed `mcp2cli cache warm open-brain --force` remains blocked by open mcp2cli issue #60.

## Residual risks

- Append and wrap tool bodies expose IDs rather than complete scope. Their fallback durability depends on the same fallback instance having just established and verified the lane through `session_start`; attempts without that proof fail closed.
- `subprocess.run` captures command output before the 1 MB post-capture rejection, so a trusted local mcp2cli process can allocate more than the accepted response bound before returning.
- Local service, restored-database, direct HTTP, isolated mcp2cli fallback, and spool/replay canaries passed in this repository. Inactive provider canaries passed on the separate Development branch. Hosted deployment, hosted v22 manifest/tool proof, mcp2cli local-direct refresh plus daemon credential/cache verification, generated-skill refresh, NATS rollout, Hermes checks, and active runtime registration remain deferred under `docs/downstream-rollout.md`. Daemon-routed `mcp2cli cache warm open-brain --force` is not a valid required gate while mcp2cli issue #60 remains open; the documented supported pool/cache reset path must be used if daemon self-healing does not refresh the schema.

## Handoff

No new integration-fix commit has been created. Controller should review the scoped diff, retain the two-repository commit boundary, and execute the already-applicable downstream classification before PR completion: gated core01 deploy, hosted v22/tool proof, truthful mcp2cli local-direct plus daemon credential/cache verification, generated-skill refresh, and applicable Hermes/NATS/provider gates.
