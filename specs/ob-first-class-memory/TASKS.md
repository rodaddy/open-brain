# Tasks

## T1 — Scope and configuration

Objective: define validated typed scope/config loaded from explicit arguments and environment without built-in namespace or credentials.

Acceptance: explicit values override environment; required scope/auth are not invented; secrets are excluded from serialization/errors.

## T2 — Lifecycle service

Objective: provide exact-scope context-pack recall plus distilled capture, checkpoint, and wrap through existing `OpenBrainClient`/`AgentMemory` methods.

Acceptance: recall uses context-pack API, writes preserve exact scope, recall fails open, and direct write outcomes distinguish durable save, spool, and loss.

## T3 — Receipts and fallback

Objective: return stable JSON-ready receipts with `saved`, `spooled`, `fallback`, and `failed`/`lost` semantics; optionally call an injectable argv-based `mcp2cli` runner only after direct setup/call failure.

Acceptance: no attempted operation is labeled saved; fallback argv has no shell interpolation; errors are redacted.

## T4 — Stable entry point

Objective: add importable main logic and a console/module entry point accepting bounded JSON and emitting JSON only.

Acceptance: unsupported/oversized/malformed input yields a structured safe failure; stdout remains machine-readable.

## T5 — Content safety and tests

Objective: require already-distilled content and enforce package redaction/size helpers.

Acceptance: fake transport/subprocess tests prove exact scope, auth headers, context-pack call shape, receipt semantics, fail-open recall, spool versus loss, fallback shape, and secret/size enforcement.

## Validation

- `uv sync`
- `uv run ruff format --check src tests`
- `uv run ruff check src tests`
- `uv run mypy src/openbrain_memory`
- `uv run pytest -q`
- `uv build`
