# Backend and Open Brain Domain SME Findings

The backend/domain lane checks MCP-over-HTTP behavior, Open Brain tool contracts,
namespace semantics, and package/runtime deployment boundaries.

## [2026-06-11] MCP transport must be bounded and stream-aware

**Severity:** HIGH
**Source:** Issue #81, PR #72 follow-up
**Scope:** `python/openbrain-memory/src/openbrain_memory/client.py`
**Status:** active

### Pattern

Transport code that reads an entire HTTP response before parsing can hang on
long-lived Streamable HTTP/SSE responses or consume too much memory on bad
responses.

### Review Questions

- Is there a `max_response_bytes` or equivalent bounded read?
- Does SSE parsing return on the matching JSON-RPC response instead of requiring
  EOF?
- If non-streaming behavior is intentional, is it explicitly negotiated or
  documented?
- Are oversized JSON/SSE responses tested?

## [2026-06-11] Health should return structured degraded diagnostics

**Severity:** MEDIUM
**Source:** Issue #81
**Scope:** `OpenBrainClient.health()`
**Status:** active

### Pattern

`/health` can legitimately return degraded status such as HTTP 503 with a useful
JSON body. Treating that as opaque HTTP failure hides diagnostics from callers.

### Review Questions

- Does `health()` return structured bodies for expected degraded health
  responses?
- Does it still raise for non-health failures and malformed health bodies?
- Are degraded health responses tested?

## [2026-06-11] Session lifecycle must be explicit

**Severity:** MEDIUM
**Source:** Issue #81
**Scope:** `OpenBrainClient`
**Status:** active

### Pattern

MCP sessions can accumulate under churn if the client has no explicit close or
context-manager path and no documented TTL reliance.

### Review Questions

- Does `OpenBrainClient` support `close()` and context manager behavior if the
  server supports termination?
- If not supported, does README/API docs state lifecycle and server TTL clearly?
- Are lifecycle tests or docs included?

## [2026-06-11] Python package gates belong in CI

**Severity:** HIGH
**Source:** Issue #79
**Scope:** `.github/workflows/**`, `python/openbrain-memory/**`
**Status:** active

### Pattern

The root Bun/TypeScript gate does not protect Python package regressions,
packaging/import failures, or wheel/sdist build failures.

### Review Questions

- Does CI run `uv run pytest -q` in `python/openbrain-memory`?
- Does CI run `uv build` in `python/openbrain-memory`?
- Are these gates triggered for package changes?
- Are generated artifacts excluded from commits?

## [2026-06-11] Runtime placement and adapter boundary are architectural contracts

**Severity:** MEDIUM
**Source:** PR #76, issue #71
**Scope:** README, integration docs
**Status:** superseded (2026-06-11, by "Two MCP client implementations exist" below -- Rico
accepted a stdlib transport inside rtech-hermes-runtime instead of consuming this package)

### Pattern

`openbrain-memory` installs on agent hosts. The Open Brain service stays remote
on the LXC. `rtech-hermes` owns the Hermes adapter/lifecycle integration and
should consume this package instead of reimplementing protocol logic.

### Review Questions

- Does a change preserve one-way dependency direction?
- Does open-brain avoid importing Hermes runtime code?
- Does Hermes-specific lifecycle logic stay out of the reusable package?

## [2026-06-11] Two MCP client implementations exist -- protocol changes must check both

**Severity:** MEDIUM
**Source:** rtech-hermes feat/openbrain-http-transport (decision: Rico, 2026-06-11)
**Scope:** `src/transport.ts`, MCP tool schemas, session lifecycle semantics
**Status:** active

### Pattern

Open Brain's MCP Streamable HTTP contract has two independent client
implementations: `python/openbrain-memory` (this repo) and
`rtech-hermes-runtime/openbrain/http_transport.py` (stdlib, no shared code --
deliberate, to keep agent LXC deploys dependency-free). The server contract is
the only thing keeping them in sync.

### Review Questions

- Does a change to `src/transport.ts`, tool input/output schemas, the
  initialize handshake, SSE framing, or MCP session TTL behavior get verified
  against BOTH clients?
- Is a breaking protocol change flagged to rtech-hermes before deploy?
- Session TTL is 30 minutes -- do long-lived clients re-initialize cleanly?

## [2026-06-27] Adapter contract mappings must match facade behavior

**Severity:** MEDIUM
**Source:** PR #218 full swarm
**Scope:** `src/contract.ts`, `docs/agent-memory-adapter-contract.md`, Python/TS facades
**Status:** fixed in PR #218

### Pattern

The local adapter contract can mislead downstream generated consumers if a
method advertises tool calls the facade does not make. In PR #218, `wrap`
advertised `session_context` even though only `compact` reads context before
`session_wrap`, and Python `recall` initially lacked the TS facade's optional
session/answer behavior.

### Review Questions

- Does `get_contract().agent_memory_adapter.methods.*.maps_to` match actual
  facade calls?
- If TS and Python are both advertised as runtime facades, do they expose the
  same Hermes-facing behavior even if return shapes differ?
- Are transport/runtime rollout changes kept out of Open Brain unless the
  downstream rollout issue explicitly owns them?

## [2026-07-05] Retiring a legacy shared namespace must stay correct pre-migration

**Severity:** MEDIUM
**Source:** PR for #167 (retire collab namespace)
**Scope:** `src/shared-namespace.ts`, `src/read-policy.ts`, fallback call sites, `scripts/retire-collab-migration.ts`
**Status:** fixed in #167 PR

### Pattern

Retiring `collab` as the default `legacySharedNamespace` (default now empty,
fallback default now off) can make un-mirrored legacy rows invisible if the
code deploys before the data migration runs. The retirement kept an env escape
hatch (`SHARED_NAMESPACE_LEGACY` + `OPENBRAIN_LEGACY_SHARED_FALLBACK=1`) and
made the fallback helpers no-op on an empty legacy namespace, but merge order
still matters: migrate first, then deploy.

Two easy mistakes surfaced:
- An `INSERT ... SELECT` that omits `namespace` inherits the table default
  (`'collab'`), silently writing copies back into the retired namespace. Always
  set the target namespace explicitly in the column list.
- `ON CONFLICT (content_hash, namespace)` fails (`42P10`) against a *partial*
  unique index unless the conflict target repeats the index predicate
  (`WHERE content_hash IS NOT NULL`).

### Review Questions

- After removing a default fallback, is the code still correct if it deploys
  BEFORE the data migration? Is the merge/deploy order spelled out in the PR?
- Do canonicalization-dependent tools (`get_stats`, `list_namespaces`, repo-fact
  canonicalization) change client-visible output when the legacy namespace stops
  being canonicalized? Is that intended and documented?
- Does the migration copy preserve provenance (created_by/created_at) and set
  the destination namespace explicitly rather than relying on a column default?
- Is the migration idempotent via a real uniqueness guard (per-namespace
  content_hash), proven by a run-twice test?

## [2026-07-06] Multi-row explicit apply paths need atomicity or progress semantics

**Severity:** MEDIUM
**Source:** PR #254 initial swarm for Issue #247
**Scope:** `src/tools/decompose-entry.ts`, any MCP tool that turns one explicit
apply call into multiple durable writes
**Status:** fixed in PR #254; keep as active checklist

### Pattern

`decompose_entry` originally inserted replacement thoughts one chunk at a time
without a transaction. If embedding generation or a later insert failed after
earlier chunks committed, the caller would receive an error without
`written_ids` while durable partial replacements remained. That is an ambiguous
apply contract.

### Review Questions

- Does one explicit apply call produce multiple durable writes?
- If yes, are those writes wrapped in `BEGIN`/`COMMIT`/`ROLLBACK`, or does the
  tool explicitly return recoverable partial progress?
- Is there a regression test forcing a mid-batch failure and proving rollback
  or documented progress semantics?
