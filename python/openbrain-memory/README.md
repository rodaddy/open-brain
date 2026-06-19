# openbrain-memory

Python client package for talking to a remote Open Brain service.

This package is installed on agent hosts. The Open Brain service remains remote
and exposes HTTP endpoints such as `/health` and `/mcp`.

## Runtime Model

`openbrain-memory` is client-side code. Installing this package on an agent host
does not move the Open Brain service or database onto that host.

| Component | Runs where | Responsibility |
| --- | --- | --- |
| Open Brain service | Remote service, for example `https://open-brain.rodaddy.live` or trusted lab `http://10.71.1.21:3100` | Owns MCP-over-HTTP, auth, namespace policy, storage, search, curation tools. |
| `openbrain-memory` | Bilby, Skippy, Nagatha, automation hosts, or any Python agent runtime | Reusable Python client, memory facade, safety/retry/spool helpers, and dry-run dream planning. |
| Hermes provider | `rtech-hermes` | Thin adapter from Hermes lifecycle/events into this package. |

Dependency direction is one-way:

- `open-brain` owns the reusable client and memory brain package.
- `rtech-hermes` owns the Hermes adapter and lifecycle integration.
- The Python package should not import Hermes runtime code.
- Hermes should consume this package instead of reimplementing MCP-over-HTTP.

## Install

Install from the package subdirectory until the package is published:

```bash
uv pip install "git+ssh://git@github.com/rodaddy/open-brain.git#subdirectory=python/openbrain-memory"
```

Future package install:

```bash
uv pip install openbrain-memory
```

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

`OpenBrainClient` exposes first-class methods for the current required Open
Brain memory contract, currently `2026-06-19.memory-tools.v3`. Agent runtimes
should call these package methods instead of carrying local copies of tool
schemas, stale mcp2cli paths, or Hermes-specific Open Brain adapters.

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

- **The server owns the contract.** `client.get_contract()` returns the
  authoritative live manifest. `CURRENT_CONTRACT_VERSION` /
  `REQUIRED_CONTRACT_TOOLS` are a snapshot pinned in this package release and may
  lag the deployed server. A wrapper existing here does not prove the connected
  Open Brain implements that tool — confirm with `get_contract()` against the
  live endpoint.
- **A wrapper call is not a confirmed write.** Importing this package and calling
  `log_thought()` / `upsert_repo_fact()` does not guarantee the runtime is wired
  to a reachable Open Brain. If `OPENBRAIN_BASE_URL`, the token, or the namespace
  is misconfigured, or the service is unreachable, writes can fail and be spooled
  locally (see [Safety and Spooling](#safety-and-spooling)) rather than landing
  in Open Brain. Verify live writes; do not treat "spooled" as "saved."
- **The server owns namespace authority.** Namespace is bound from the client's
  configured `X-Namespace`, not from caller metadata. Passing `namespace` inside
  a wrapper's arguments does not override it.

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
