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
   uv pip install openbrain-memory
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
   uv pip install "git+ssh://git@github.com/rodaddy/open-brain.git#subdirectory=python/openbrain-memory"
   ```

For deterministic host installs, pin the git dependency to a reviewed commit or
tag rather than a moving branch.

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
facts = client.list_repo_facts(repo="rodaddy/open-brain", limit=10)
client.upsert_repo_fact(metadata={...})
```

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
- **The server owns namespace authority.** Namespace is bound from the client's
  configured `X-Namespace`, not from caller metadata. Passing `namespace` inside
  a wrapper's arguments does not override it.

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
Brain service. `OpenBrainClient` sends the configured namespace through
`X-Namespace` when present, and the server validates that header against the
bearer token role. `AgentMemory` never accepts `namespace` as facade metadata.
Nested user-owned structures such as decision context remain available for
semantic fields, but authority-shaped keys such as `namespace`, `authorization`,
`headers`, `role`, `token`, or `X-Namespace` are rejected before client calls.
Cross-namespace writes require an explicit privileged client/server path rather
than facade metadata.

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
    role="n8n",
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
which requires an admin or n8n-capable Open Brain role.

Mutation is opt-in at the wrapper level. `set_tier()` and `promote_entry()` only
write to Open Brain when called directly with `dry_run=False`. There is no
archive/apply behavior by default.

```python
dreams.set_tier("thoughts", "<entry-id>", "hot", dry_run=False)
dreams.promote_entry("thoughts", "<entry-id>", reason="useful", dry_run=False)
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
uv run pytest tests/test_live_canary.py
```

Non-local `http://` endpoints are rejected by default because MCP requests carry
bearer tokens. For trusted lab-only HTTP endpoints, set
`OPENBRAIN_ALLOW_INSECURE_HTTP=1` explicitly.

### Canary Coverage Expectations

Before claiming a Hermes agent or other host runtime is ready on this package,
run a live canary that covers the required memory contract, not only package
import or `/health`.

Required coverage:

- **Contract authority:** call `get_contract()` against the configured live
  endpoint and treat its manifest as the source of truth. Check
  `contract_version`, `contract_scope`, `schema_hash`, compatible/minimum client
  version fields, required capabilities, and required tool names before enabling
  required-memory mode. The package exposes helpers and constants, but required
  contract validation remains a runtime integration responsibility until a
  shared validator lands.
- **Lane tools:** exercise `session_start`, `session_context`, `lane_upsert`,
  `lane_load`, and `session_wrap` for the agent namespace.
- **Append/write:** verify `append_session_event`, `log_thought`, and
  `upsert_repo_fact` can write through the configured token and namespace.
- **Read:** verify `search_all`, `brain_answer`, and `list_repo_facts` can read
  expected results without crossing namespace or role boundaries.
- **Spool distinction:** verify a successful live write is reported as saved in
  Open Brain, and separately verify that unreachable or rejected writes are
  spooled locally when a spool is configured. A spooled record is not a saved
  Open Brain memory; readiness requires either replay success or an explicit
  decision that the failed write is acceptable for the canary.

The current `tests/test_live_canary.py` is intentionally small and env-gated.
It is a smoke test, not the full Hermes readiness canary. Host rollouts should
record which live endpoint, package version or artifact, namespace, and canary
operations were verified.
