# Progress

Status: implementation and local validation complete

Current phase: ready for controller review

## Scope Lock

Phase/task: first-class local runtime foundation
Issue(s): open-brain #293
Objective: expose a minimal package-owned lifecycle API and bounded JSON entry point for thin visible runtime adapters.
In scope: typed scope/config; context-pack recall; distilled capture/checkpoint/wrap; honest receipts; optional injectable fallback; content safety; fake-boundary tests; required exports/version/docs.
Out of scope: hooks/runtime homes; server TypeScript/protocol changes; external lockfiles; GitHub mutations; raw transcripts; deployment.
Changed paths remain inside `python/openbrain-memory/**` and `specs/ob-first-class-memory/**`.

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
- `uv run pytest -q` — passed; 283 passed, 5 skipped.
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
- `uv run pytest -q tests/test_runtime.py tests/test_safety.py tests/test_agent.py`
  — passed; 122 tests.
- `uv run ruff format --check src tests` — passed; 23 files already formatted.
- `uv run ruff check src tests` — passed; all checks passed.
- `uv run mypy src/openbrain_memory` — passed; 14 source files.
- `uv run pyright src tests/test_runtime.py` — passed; 0 errors, 0 warnings.
- `uv run pytest -q` — passed; 283 passed, 5 skipped.
- `uv build` — passed; built the 0.1.8 sdist and wheel.
- Public import smoke and malformed-JSON module CLI smoke — passed; the CLI
  returned a structured failed receipt and exit code 2.
- `git diff --check` — passed.

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
  subprocess capture, and live service/runtime canaries remain outside this local
  package-foundation slice.

## Residual risks

- Append and wrap tool bodies expose IDs rather than complete scope. Their fallback durability depends on the same fallback instance having just established and verified the lane through `session_start`; attempts without that proof fail closed.
- `subprocess.run` captures command output before the 1 MB post-capture rejection, so a trusted local mcp2cli process can allocate more than the accepted response bound before returning.
- Live service/deployment canaries were out of scope; validation used behavior-aware fake MCP and subprocess boundaries.

## Handoff

No commit created. Controller should review the scoped diff and decide downstream rollout separately under the repository rollout policy.
