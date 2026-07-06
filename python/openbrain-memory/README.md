# openbrain-memory

Python client package for talking to a remote Open Brain service.

This package is installed on agent hosts. The Open Brain service remains remote
and exposes HTTP endpoints such as `/health` and `/mcp`.

## Runtime Model

`openbrain-memory` is client-side code. Installing this package on an agent host
does not move the Open Brain service or database onto that host.

| Component | Runs where | Responsibility |
| --- | --- | --- |
| Open Brain service | Remote service, for example `https://open-brain.rodaddy.live` or trusted lab `http://10.71.1.21:3100` | Owns direct HTTP `/mcp`, auth, namespace policy, storage, search, curation tools. |
| `openbrain-memory` | Bilby, Skippy, Nagatha, automation hosts, or any Python agent runtime | Reusable Python client, memory facade, safety/retry/spool helpers, and dry-run dream planning. |
| Hermes provider | `rtech-hermes` | Thin adapter from Hermes lifecycle/events into this package. |

Dependency direction is one-way:

- `open-brain` owns the reusable client and memory brain package.
- `rtech-hermes` owns the Hermes adapter and lifecycle integration.
- The Python package should not import Hermes runtime code.
- Hermes migration should move lifecycle/event wiring toward this package
  rather than growing a long-lived fork of Open Brain client behavior. Until
  that wiring lands in the deployed Hermes adapter, treat this package as the
  migration target, not proof of current Hermes runtime state.

## Install

Install this package into the host Python environment that runs the agent
runtime or adapter. The Open Brain service stays remote.

Preferred options, in order:

1. **Published/internal package.** Use this after `openbrain-memory` is
   published to the chosen package index or internal wheelhouse:

   ```bash
   uv pip install "openbrain-memory==<version>"
   ```

2. **Prebuilt CI/release wheel artifact.** Use this for pinned rollout when
   publication is not done yet, or when promoting the exact wheel built and
   tested by CI or a release job. Download or copy that reviewed artifact from
   the CI/release artifact store, then install that file on the host:

   ```bash
   uv pip install /path/to/openbrain_memory-<version>-py3-none-any.whl
   ```

3. **Local development build.** Use this to test packaging from a checkout or
   to install an unreleased local build for development. This creates a new
   wheel on the host, so it is not the same artifact CI already reviewed:

   ```bash
   cd python/openbrain-memory
   uv build
   uv pip install dist/openbrain_memory-*.whl
   ```

4. **Transitional git-subdirectory install.** Use this only while a consuming
   runtime is migrating and no published/internal package or reviewed wheel
   artifact is available:

   ```bash
   uv pip install \
     "git+https://github.com/rodaddy/open-brain.git@<40-char-commit>#subdirectory=python/openbrain-memory"
   ```

For deterministic host installs, pin the package to an exact version or reviewed
wheel, or pin the git dependency to a reviewed commit or tag rather than a
moving branch.

Hermes deployments usually do not call `uv pip install` by hand. In
`rtech-hermes`, set `openbrain_memory.package_spec` in the target agent manifest
or set `OPENBRAIN_MEMORY_PACKAGE_SPEC` for an emergency override. Both paths
must use a reviewed wheel, exact package version, or full commit-pinned
git-subdirectory URL.

## Runtime Config

Provide the remote service URL, token, namespace, and agent/project identity from
the host process. Keep tokens in the host secret manager or an uncommitted env
file; do not paste real tokens into shell history or commit them.

```bash
export OPENBRAIN_BASE_URL="https://brain.example"
export OPENBRAIN_TOKEN="..."
export OPENBRAIN_NAMESPACE="bilby"
export OPENBRAIN_AGENT_ID="bilby"
export OPENBRAIN_PROJECT="open-brain"
```

Current production-style examples:

```bash
# Caddy/TLS in front of the Mac Mini Open Brain service
export OPENBRAIN_BASE_URL="https://open-brain.rodaddy.live"

# Trusted lab direct endpoint; requires explicit insecure-HTTP opt-in
export OPENBRAIN_BASE_URL="http://10.71.1.21:3100"
export OPENBRAIN_ALLOW_INSECURE_HTTP="1"
```

Do not use retained pre-cutover LXC snapshots such as `10.71.20.49` for current
host canaries.

For trusted lab-only HTTP endpoints, such as `http://10.71.1.21:3100`, opt in
explicitly:

```bash
export OPENBRAIN_BASE_URL="http://10.71.1.21:3100"
export OPENBRAIN_ALLOW_INSECURE_HTTP="1"
```

```python
import os

from openbrain_memory import AgentMemory, OpenBrainClient

client = OpenBrainClient(
    os.environ["OPENBRAIN_BASE_URL"],
    token=os.environ["OPENBRAIN_TOKEN"],
    namespace=os.environ["OPENBRAIN_NAMESPACE"],
    agent_id=os.environ.get("OPENBRAIN_AGENT_ID"),
    role="agent",
    allow_insecure_http=os.environ.get("OPENBRAIN_ALLOW_INSECURE_HTTP") == "1",
)
memory = AgentMemory(
    client,
    agent=os.environ.get("OPENBRAIN_AGENT_ID", "agent"),
    project=os.environ.get("OPENBRAIN_PROJECT"),
)
```

Normal agent-role tokens derive namespace authority server-side from the token.
`OpenBrainClient` therefore does not send `X-Namespace` by default. Trusted
admin or ob-admin callers that intentionally need namespace delegation can opt in
with `delegate_namespace=True`; doing so sends `X-Namespace` and requires a
server role that is allowed to delegate.

### Retry policy

`OpenBrainClient` retries MCP `initialize` when the service returns HTTP 429 for
session-cap pressure. The default retry policy is conservative and honors
server `Retry-After` or `retry_after_seconds` metadata, capped by
`max_backoff_seconds`.

```python
from openbrain_memory import OpenBrainClient, RetryPolicy

client = OpenBrainClient(
    "https://brain.example",
    token="...",
    namespace="bilby",
    agent_id="bilby",
    retry_policy=RetryPolicy(
        attempts=3,
        backoff_seconds=0.25,
        max_backoff_seconds=5.0,
        honor_retry_after=True,
    ),
)
```

Set `honor_retry_after=False` only for controlled tests or a caller-managed
backoff policy. Session pressure is expected to be handled by client backoff and
session cleanup, not by raising the server cap as the first response.

## Quickstart

```python
from openbrain_memory import AgentMemory, OpenBrainClient

client = OpenBrainClient(
    "https://brain.example",
    token="...",
    namespace="bilby",
    agent_id="bilby",
    role="agent",
)
memory = AgentMemory(client, agent="bilby", project="open-brain")

memory.start_session("project/session", topic="client facade")
context = memory.recall("OpenBrainClient call shape", limit=5)
memory.append_event("assistant", "Implemented the facade.", event_type="action")
memory.remember_fact("AgentMemory delegates protocol work to OpenBrainClient.")
memory.remember_decision("Keep runtime adapter names out of openbrain-memory.")
memory.checkpoint("Facade implemented and tested.")
memory.wrap_session("Ready for PR review.")

prompt_context = context.as_prompt_text()
```

## Current Open Brain Tools

`OpenBrainClient` exposes first-class methods for the Open Brain memory
contract. Agent runtimes should call these package methods and confirm the live
endpoint contract with `client.get_contract()` instead of carrying local copies
of tool schemas, stale mcp2cli paths, or Hermes-specific Open Brain adapters.

Required memory contract methods:

- `get_contract()`
- `session_start()`
- `session_context()`
- `append_session_event()`
- `lane_upsert()`
- `lane_load()`
- `session_wrap()`
- `log_thought()`
- `search_all()`
- `upsert_repo_fact()`
- `list_repo_facts()`

Additional current read helpers:

- `brain_answer()`
- `search_brain()`
- `get_entity()`
- `list_entities()`
- `hydrate_entities()`

The generic `call_tool(name, arguments)` method remains available for forward
compatibility, but missing first-class wrappers for required contract tools are
a package bug.

```python
contract = client.get_contract()
answer = client.brain_answer(query="what did we decide?", limit=5)
compact = client.get_entry(
    table="thoughts",
    id="<uuid>",
    render="compact",
    max_chars=500,
)
facts = client.list_repo_facts(repo="rodaddy/open-brain", limit=10)
client.upsert_repo_fact(metadata={...})
```

### Stable Public API

Downstream runtimes should import from the package root, not from private module
paths. The supported public surface is:

- `OpenBrainClient` and Open Brain errors.
- `AgentMemory` facade types.
- `JsonlSpool`, `SpoolRecord`, `SpoolStatus`, and `replay_records`.
- `RetryPolicy` and `RetryExhaustedError`.
- `redact_text()` and `redact_value()`.
- `validate_required_memory_contract()` and `validate_contract_manifest()`.
- `contract_field_to_json_schema()`, `contract_input_to_json_schema()`,
  `tool_contract_to_input_schema()`, and `tool_contracts_to_tool_schemas()`.
- `CURRENT_CONTRACT_VERSION`, `REQUIRED_CONTRACT_TOOLS`, `CURRENT_TOOL_HELP`, and
  `PACKAGE_VERSION`.

The wheel includes a `py.typed` marker so typed consumers can rely on the
package's inline annotations.

### Versioning and Contract Pinning

`PACKAGE_VERSION` follows SemVer for the Python package API and installable
artifact. While the package remains `0.x`, downstream production hosts should
pin exact versions or reviewed wheel files because minor releases may still
carry breaking API changes.

`CURRENT_CONTRACT_VERSION` is separate. It identifies the Open Brain service
tool contract snapshot expected by this package. The connected endpoint's
`get_contract()` response is authoritative at runtime; consumers should validate
that manifest with `validate_required_memory_contract()` before enabling
required-memory mode. Pinning `openbrain-memory==<version>` is not a substitute
for checking the live `contract_version`, `contract_scope`, `schema_hash`,
minimum client ranges, and required tool names.

### Canonical Redaction Policy

`redact_text()` and `redact_value()` are the canonical client-side diagnostic
redaction implementation for Open Brain consumers. Agent runtimes should import
these helpers instead of maintaining a forked regular-expression list. The
helpers are intentionally for logs, errors, display, and spooled diagnostic
views; they do not mutate successful live writes.

Heuristic-only shapes, such as bare three-segment opaque tokens and unlabeled
base64-style blobs containing `+` or `=`, are display-redacted but are not
fail-closed write rejections. Pure alphanumeric/base62 unlabeled blobs are left
visible so benign identifiers, content hashes, and git SHAs are not silently
destroyed; use context labels such as `access_token=` or `client_secret=` when a
write path must reject a value.
Unlabeled 40+ character base64 cursors, hashes, or request tokens that contain
`+` or `=` may be over-scrubbed in diagnostics; label or truncate benign values
before logging when operators need to inspect them.

The redaction policy should grow here first and downstream forks should retire
toward this implementation. If a consuming runtime needs a new secret shape, add
it here with regression tests that prove both the secret is scrubbed and benign
identifiers, such as git SHAs, file paths, branch names, URL paths, and
environment variable names, remain visible.

### Authority boundaries

These wrappers describe the *expected* contract; they are not proof of live
behavior. Read them with three boundaries in mind:

- **The server owns the contract.** `client.get_contract()` returns the live
  source of truth for the connected Open Brain endpoint, including version,
  required tools, compatibility fields, and schema metadata. Package constants
  such as `CURRENT_CONTRACT_VERSION` / `REQUIRED_CONTRACT_TOOLS` are snapshots
  for compatibility checks and tests; they may lag or lead a specific
  deployment. A wrapper existing here does not prove the connected Open Brain
  implements that tool. Confirm against the live endpoint with `get_contract()`.
- **A wrapper call is not a confirmed write.** Importing this package and calling
  `log_thought()` / `upsert_repo_fact()` does not guarantee the runtime is wired
  to a reachable Open Brain. If `OPENBRAIN_BASE_URL`, the token, or the namespace
  is misconfigured, or the service is unreachable, writes can fail and be spooled
  locally (see [Safety and Spooling](#safety-and-spooling)) rather than landing
  in Open Brain. Verify live writes; do not treat "spooled" as "saved."
- **The server owns namespace authority.** Normal agent-role tokens derive the
  caller namespace server-side, so `OpenBrainClient` omits `X-Namespace` by
  default. `delegate_namespace=True` is an explicit privileged delegation mode
  for roles such as admin or ob-admin that are allowed to send `X-Namespace`.
  Passing `namespace` inside a wrapper's arguments does not create or override
  delegation.

### Schema Helpers

`openbrain_memory.schema` converts the server's `get_contract()` DSL into JSON
Schema-shaped input definitions for downstream validators and tool registries.
The live `get_contract()` manifest remains the source of truth; these helpers
only translate a manifest the caller already obtained or a package test fixture.
They do not prove that a deployed Open Brain endpoint, Hermes adapter, or agent
runtime is wired correctly.

Use `contract_field_to_json_schema()` for one field node and
`contract_input_to_json_schema()` for one tool's `input_schema` mapping. Use
`tool_contract_to_input_schema()` when you already selected one tool contract,
and `tool_contracts_to_tool_schemas()` when converting a manifest's
`tool_contracts` into a list of `{name, input_schema}` entries.

`tool_contracts_to_tool_schemas()` accepts the live `get_contract()` manifest
and reads its `tool_contracts` mapping. Downstream callers should keep tests
pinned to the package version they install and should not hand-maintain a
second converter in the consuming repo.

Malformed contract DSL raises `ContractSchemaError` with the failing path rather
than emitting invalid JSON Schema. Open Brain-specific constraints that do not
map cleanly to standard JSON Schema are preserved with `x-openbrain-*` vendor
extensions. Hermes policy, readiness checks, and runtime enforcement remain
downstream integration responsibilities.

### Transport

Today this package talks directly to the Open Brain service over HTTP endpoints
such as `/health` and `/mcp`. The `/mcp` endpoint uses the Open Brain server's
streamable JSON-RPC/MCP surface, but the host install should be described as
"direct HTTP to Open Brain `/mcp`" rather than generic "MCP HTTP" so it is not
confused with mcp2cli daemon routing or other MCP transports.

NATS or another transport may be added later for agent-host routing, but it is
not the current package transport. Until a future transport is implemented and
documented, Hermes agents should configure `OPENBRAIN_BASE_URL`,
`OPENBRAIN_TOKEN`, and namespace identity for direct HTTP access to Open Brain.

## Safety and Spooling

`AgentMemory` sends the original caller payload to Open Brain. Redaction helpers
are for diagnostics and display only; they do not mutate live writes.

Namespace authority belongs to the configured `OpenBrainClient` and the Open
Brain service. `OpenBrainClient` does not send `X-Namespace` for normal agent
clients; the server derives the namespace from the bearer token. When a trusted
admin/ob-admin-style caller passes `delegate_namespace=True`, the client sends its
configured namespace through `X-Namespace`, and the server validates that
delegation against the bearer token role. `AgentMemory` never accepts
`namespace` as facade metadata. Nested user-owned structures such as decision
context remain available for semantic fields, but authority-shaped keys such as
`namespace`, `authorization`, `headers`, `role`, `token`, or `X-Namespace` are
rejected before client calls. Cross-namespace writes require an explicit
privileged client/server path rather than facade metadata.

`UrllibTransport` bounds JSON and SSE response reads with `max_response_bytes`
and returns from SSE responses after the first JSON-RPC response event rather
than waiting for the stream to close. It skips notification/progress SSE events
that do not carry a JSON-RPC `id`. `health()` returns structured degraded
health bodies for expected HTTP 503 responses. `OpenBrainClient.close()` and
context manager exit clear the local MCP session id; the current Open Brain MCP
surface does not expose an explicit remote session termination method, so
server-side session cleanup remains TTL-based.

`JsonlSpool` stores exact failed-write payloads so replay can faithfully rebuild
the original client call. Spool and lock files are created with `0600`
permissions and should be treated as trusted local recovery storage. Use
`SpoolRecord.redacted_payload()` or `JsonlSpool.redacted_records()` before
showing spool contents in logs, UIs, or debug output.

## DreamEngine

`DreamEngine` wraps Open Brain curation tools with a dry-run-first API. The
default `dream_once()` call gathers stale entries, tier recommendations,
duplicates, and optional namespace promotion candidates without mutating tiers
or promotions.

```python
from openbrain_memory import DreamEngine, OpenBrainClient

client = OpenBrainClient(
    "https://brain.example",
    token="...",
    namespace="bilby",
    agent_id="bilby",
    role="ob-admin",
)
dreams = DreamEngine(client)

plan = dreams.dream_once(namespace="bilby")
for action in plan.actions:
    print(action.as_dict())
```

`dream_once()` is dry-run-only in the first release, so it never applies a whole
dream cycle in bulk. When `namespace` is supplied it only plans namespace
promotion actions because tier recommendations are not namespace-scoped by the
Open Brain tool contract. Namespace promotion planning calls `scan_namespace`,
which requires an admin or ob-admin-capable Open Brain role.

Mutation is opt-in at the wrapper level. `set_tier()` and `promote_entry()` only
write to Open Brain when called directly with `dry_run=False`. There is no
archive/apply behavior by default.

```python
dreams.set_tier("thoughts", "<entry-id>", "hot", dry_run=False)
dreams.promote_entry("thoughts", "<entry-id>", reason="useful", dry_run=False)
```

Oversized-entry decomposition follows the same safety rule. The default
`decompose_entry()` call asks Open Brain for a dry-run proposal containing
smaller linked replacement thoughts and namespace-safe provenance. It does not
archive, promote, demote, tier, or write replacements.

```python
proposal = dreams.decompose_entry(
    "thoughts",
    "<entry-id>",
    max_chunk_chars=2000,
)
```

Replacement writes require an explicit mutating wrapper call:

```python
dreams.decompose_entry(
    "thoughts",
    "<entry-id>",
    dry_run=False,
    apply_mode="write_replacements",
)
```

## Test

```bash
cd python/openbrain-memory
uv run pytest
```

## Optional Live Canary

Default tests use fake transports and do not require credentials. A live canary
can be enabled explicitly with environment variables:

```bash
OPENBRAIN_LIVE_CANARY=1 \
OPENBRAIN_BASE_URL=http://127.0.0.1:3100 \
OPENBRAIN_TOKEN=... \
OPENBRAIN_NAMESPACE=bilby \
uv run pytest tests/test_live_canary.py -q
```

Set `OPENBRAIN_ROLE`/`OPENBRAIN_AGENT_ID` for the identity labels expected by
the target deployment. Do not enable namespace delegation for normal agent-role
tokens; the server should derive their namespace from the token.

Non-local `http://` endpoints are rejected by default because MCP requests carry
bearer tokens. For trusted lab-only HTTP endpoints, set
`OPENBRAIN_ALLOW_INSECURE_HTTP=1` explicitly.

The default live canary now checks package helper readiness, not just `/health`:

- `health()` and `search_all()` read access.
- `get_contract()` plus `validate_required_memory_contract()` against
  `REQUIRED_CONTRACT_TOOLS` and the package `CURRENT_CONTRACT_VERSION`.
- `brain_answer()` and `list_repo_facts()` read access.

Write canaries are intentionally opt-in because they create durable session
state. To exercise lane/session writes, set:

```bash
OPENBRAIN_LIVE_CANARY_WRITE=1
```

That write canary checks `session_start()`, `lane_upsert()`,
`append_session_event()`, `session_context()`, `lane_load()`, and
`session_wrap()`, including proof that the appended event is readable afterward.

`upsert_repo_fact()` is intentionally not part of the default canary because it
creates curated repo-fact rows. To opt into that higher-impact write, set both:

```bash
OPENBRAIN_LIVE_CANARY_REPO_FACT_WRITE=1 \
OPENBRAIN_LIVE_CANARY_REPO_FACT_COMMIT=<git-sha>
```

The commit must be the source commit used in the GitHub source URL embedded in
the repo-fact metadata.

### Canary Coverage Expectations

Before claiming a Hermes agent or other host runtime is ready on this package,
run a live canary that covers the required memory contract, not only package
import or `/health`.

Required coverage:

- **Contract authority:** call `get_contract()` against the configured live
  endpoint and treat its manifest as the source of truth. Check
  `contract_version`, `contract_scope`, `schema_hash`, compatible/minimum client
  version fields, required capabilities, and required tool names before enabling
  required-memory mode. The package exposes `validate_required_memory_contract()`
  for this check; the connected endpoint's `get_contract()` manifest remains
  authoritative, and the runtime that consumes the package still owns the
  fail-closed decision.
- **Lane tools:** exercise `session_start`, `session_context`, `lane_upsert`,
  `lane_load`, and `session_wrap` for the agent namespace.
- **Append/write:** verify `append_session_event` can write through the
  configured token and namespace. Verify `upsert_repo_fact` only when the
  explicit repo-fact write gate is enabled. Use a separate `log_thought` check
  only when durable general-memory writes are intended for the rollout.
- **Read:** verify `search_all`, `brain_answer`, and `list_repo_facts` can read
  expected results without crossing namespace or role boundaries.
- **Spool distinction:** verify a successful live write is reported as saved in
  Open Brain, and separately verify that unreachable or rejected writes are
  spooled locally when a spool is configured. A spooled record is not a saved
  Open Brain memory; readiness requires either replay success or an explicit
  decision that the failed write is acceptable for the canary.

`tests/test_live_canary.py` is env-gated and suitable for package helper
readiness checks. The default gate is read-only; write checks require explicit
write env flags. Host rollouts should record which live endpoint, package
version or artifact, namespace, optional write gates, and canary operations were
verified.
