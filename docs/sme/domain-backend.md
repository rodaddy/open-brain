# Backend and Open Brain Domain SME Findings

The backend/domain lane checks MCP-over-HTTP behavior, Open Brain tool contracts,
namespace semantics, and package/runtime deployment boundaries.

## [2026-06-11] MCP transport must be bounded and stream-aware

**Severity:** HIGH
**Source:** Issue #81, PR #72 follow-up; PR #319 fix delta
**Scope:** `python/openbrain-memory/src/openbrain_memory/client.py`, `clients/ts/src/client.ts`
**Status:** active

### Pattern

Transport code that reads an entire HTTP response before parsing can hang on
long-lived Streamable HTTP/SSE responses or consume too much memory on bad
responses.

**PR #319:** TS `response.text()` defeated its byte cap and its SSE parser
waited for EOF. Bound bytes while reading chunks, cancel on overflow, and return
after a complete matching JSON-RPC SSE event; cover JSON, SSE, and open streams.

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
**Source:** Issue #81; PR #319 terminal audit
**Scope:** Python and TypeScript `OpenBrainClient`
**Status:** active

### Pattern

MCP sessions can accumulate under churn if the client has no explicit close or
context-manager path and no documented TTL reliance. Concurrent first-use calls
can also create multiple sessions when initialization is not coalesced; a close
that overlaps initialization must invalidate and tear down the pending session
so no session is published after close returns.

### Review Questions

- Does `OpenBrainClient` support `close()` and context manager behavior if the
  server supports termination?
- Are concurrent first-use calls coalesced onto one initialization attempt?
- Does close-during-initialize invalidate the pending operation, delete the
  pending server session, and still allow a later post-close call to reinitialize?
- If explicit close is unsupported, do README/API docs state lifecycle and server
  TTL clearly?
- Are lifecycle concurrency tests included?

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

## [2026-07-06] Domain replacements must not reuse embedding chunk parent semantics

**Severity:** MEDIUM
**Source:** PR #254 Claude/Opus cross-review for Issue #247
**Scope:** `thoughts.parent_id`, decomposition/rewrite tools, recall-visible
replacement rows
**Status:** fixed in PR #254; keep as active checklist

### Pattern

`thoughts.parent_id` is not a generic provenance link. It identifies embedding
sub-chunks, and recall/listing paths intentionally exclude rows with
`parent_id IS NOT NULL` from top-level results. A tool that writes replacement
thoughts as standalone recall entries must not set `parent_id` to the source
row just to preserve lineage.

### Review Questions

- Is the new row supposed to be recall/list visible as a top-level memory?
- If yes, does it keep `parent_id = null` and put lineage in provenance/tags or
  the owning relationship model instead?
- Do tests assert the insert parameters keep replacement rows out of chunk-only
  semantics?

## [2026-07-07] Second transports must mirror the authoritative contract bounds

**Severity:** MEDIUM
**Source:** PR #260 initial swarm for Issue #223
**Scope:** `src/nats-runtime.ts`, `src/tools/agent-context-pack.ts`, transport bridge schemas
**Status:** fixed in PR #260; keep as active checklist

### Pattern

A first-class second transport can still drift if its planning envelope accepts
fields, section names, or budgets that the authoritative HTTP/MCP tool would
reject. Planned-only bridge code is contract surface area: callers can build
against it before runtime rollout. NATS `agent_context_pack` must use the same
section enum, comparable bounds for query/budget, and a strict body schema so
unsupported planned fields fail before fallback planning.

### Review Questions

- Does the secondary transport import or mirror the same enum/bounds as the
  authoritative tool or manifest?
- Are unknown section names and unsupported body fields rejected before bridge
  planning instead of being stripped silently?
- Are query and budget limits no looser than the primary tool schema?
- Do tests cover drift cases, not only the happy-path envelope?

## [2026-07-07] Runtime availability must distinguish active transport from configured fallback

**Severity:** HIGH
**Source:** PR #262 initial swarm for Issue #223
**Scope:** `src/nats-runtime.ts`, `src/contract.ts`, `src/index.ts`, optional second-transport metadata
**Status:** fixed in PR #262; keep as active checklist

### Pattern

Optional second transports can over-advertise readiness when configuration is
present but the runtime path is not active. In PR #262, setting NATS bridge env
and a URL could make `get_contract()` advertise NATS availability while the
server was still running the default HTTP transport. The contract also listed
planned request/reply subjects in the same bucket as the one implemented
subject.

### Review Questions

- Does runtime availability require the transport to be requested and actually
  started, not merely configured?
- Are available subjects separated from planned/not-yet-implemented subjects in
  machine-readable contract metadata?
- Do fallback/client paths continue to fail closed when the second transport is
  configured but not active?
- Do docs and tests cover default HTTP behavior, active second-transport
  behavior, and configured-but-inactive behavior?

## [2026-07-07] Subscription liveness must not stay green on empty iterator churn

**Severity:** MEDIUM
**Source:** PR #262 Claude/Opus cross-review for Issue #223
**Scope:** `src/nats-bridge.ts`, streaming/subscription loops, runtime health
**Status:** fixed in PR #262; keep as active checklist

### Pattern

A clean iterator completion is not always healthy. If a broker or driver returns
empty subscriptions repeatedly, the bridge can resubscribe forever without ever
processing a request while `/health` and `get_contract()` still advertise the
transport as available. One clean completion can be a normal recycle; repeated
zero-message completions need a bounded degradation rule.

### Review Questions

- Does the subscription loop distinguish a single clean recycle from repeated
  empty completions?
- Is health degraded after a bounded number or duration of no-message
  completions?
- Do tests cover both a successful resubscribe after one clean completion and
  repeated empty completions that must not stay healthy?

## [2026-07-08] Shared search helper changes need explicit consumer gating

**Severity:** MEDIUM
**Source:** PR #274 initial swarm for Issue #267
**Scope:** `executeSearch`, `executeSearchWithSharedFallback`,
`executeSearchWithScopedSharedFallback`, `search_all`, `brain_answer`, REST
search paths
**Status:** fixed in PR #274; keep as active checklist

### Pattern

Adding behavior to a shared backend helper can silently expand the public
surface beyond the issue scope. In PR #274, adding graph retrieval inside
`executeSearch` would have affected direct `search_brain`, `search_all`,
`brain_answer`, and REST callers unless the graph arm was explicitly gated for
the direct tool path.

### Review Questions

- Which tools and REST endpoints call the shared helper being changed?
- Is new behavior opt-in when the issue/PR claims a narrower tool scope?
- Are sibling callers covered by graph-off or no-behavior-change regression
  tests, not only by PR-body wording?

## [2026-07-08] Streamable-HTTP builds a fresh McpServer per session -- "once per process" state resets

**Severity:** HIGH
**Source:** PR #275 pre-merge gauntlet for Issue #269
**Scope:** `src/index.ts` serverFactory, install/register functions for tools
and wrappers, any state initialized inside MCP server construction
**Status:** fixed in PR #275

### Pattern

The streamable-HTTP transport constructs a fresh `McpServer` per session via
`serverFactory`. Any "once per process" state initialized inside an
install/register function -- retention sweep timers, warn-once flags, counters,
caches -- silently resets on every new session. In PR #275 this would have
respawned per-session state the audit feature assumed was process-wide.

### Review Questions

- Is any state declared inside an install/register/tool-setup function assumed
  to be process-wide? It is actually per-session under serverFactory.
- Is process-wide state module-scoped or keyed by the shared pool/config object
  instead?
- Do tests create two sessions (two factory invocations) and prove the state is
  shared or reset as intended?

## [2026-07-08] Python client changes move the version and min_client_versions floor together

**Severity:** MEDIUM
**Source:** PR #277 pre-merge gauntlet for Issue #270
**Scope:** `python/openbrain-memory/pyproject.toml`, `src/contract.ts`
`min_client_versions`, downstream rollout classification
**Status:** fixed in PR #277

### Pattern

Behavior changes in `python/openbrain-memory` require a package version bump
(0.1.6 set the precedent), and the server's advertised `min_client_versions`
floor must move in lockstep with the exact-version contract. Shipping client
behavior under an unchanged version, or bumping the package without moving the
advertised floor, breaks the contract downstream consumers pin against.

### Review Questions

- Does any change under `python/openbrain-memory/` ship without a version bump?
- Does the server's `min_client_versions` advertisement match the new exact
  version when the contract requires lockstep?
- Is the bump classified in `docs/downstream-rollout.md` terms before the PR is
  called complete?

## [2026-07-08] Launchd updates must reload desired state, not only kickstart

**Severity:** MEDIUM
**Source:** PR #283 initial swarm for Issue #282
**Scope:** launchd service templates and core01 deploy/runbook instructions
**Status:** fixed in PR #283

### Pattern

Copying an updated plist and running `launchctl kickstart -k` can restart the
currently loaded job definition without reloading changed `ProgramArguments`,
environment, log paths, or resource limits. A deploy can look restarted while
live launchd state still differs from the repo template.

### Review Questions

- For plist changes, does the update path boot out and bootstrap the service
  before kickstart?
- Does verification print the loaded job after bootstrap so desired state can be
  compared to live state?
- Does the launch command fail fast when its env file is missing or unreadable?
- Does the runbook validate the env file before installing/restarting the
  service, especially when the worker env sources a shared production env?

## [2026-07-13] Joined event chronology must stay database-owned and fully ordered

**Severity:** HIGH
**Source:** Issue #288 Full-tier review and focused verification
**Scope:** transcript citation migration and neighbor SQL
**Status:** fixed in issue #288 implementation

Do not round-trip PostgreSQL timestamps through millisecond JS dates for tuple boundaries. Compare against the target row in SQL, qualify every projected column, apply direction to every ORDER BY term, and make constraint creation retry-idempotent.

## [2026-07-17] Bounded context reads need omission proof, total order, and cancellable latency

**Severity:** HIGH
**Source:** PR #294 Full-tier review and terminal audit
**Scope:** `agent_context_pack` durable lane/event reads and bounded database retrieval
**Status:** fixed in PR #294

A bounded context query must fetch one extra row before truncating so omission flags are truthful, use a total order such as `(created_at, id)` in both selection and returned chronology, and keep timestamp comparison database-owned. PostgreSQL ordering boundaries must not round-trip through millisecond-precision `Date` values, which can collapse distinct timestamps and skip or duplicate rows. The request budget must cover pool acquisition as well as query execution: race `pool.connect()` against the remaining deadline, and if acquisition resolves after timeout, release that late client immediately so the pool does not leak capacity. Every acquired-client query, including `BEGIN`, transaction-local timeout setup, reads, commit, and rollback, must carry pg's per-query `query_timeout`; never bootstrap it with an unbounded session `SET`. Keep PostgreSQL `statement_timeout` transaction-local for server-side read cancellation, and discard a client after a timed-out or protocol-uncertain query rather than queueing cleanup behind it. Tests must cover sub-millisecond timestamps, timestamp ties, exactly-at-limit versus over-limit results, a saturated pool with late acquisition, a concretely wedged transaction start, per-query timeout configuration, and no session `SET`/`RESET`.
