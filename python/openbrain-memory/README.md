# openbrain-memory

Python client package for talking to a remote Open Brain service.

This package is installed on agent hosts. The Open Brain service remains remote
and exposes HTTP endpoints such as `/health` and `/mcp`.

## Runtime Model

`openbrain-memory` is client-side code. Installing this package on an agent host
does not move the Open Brain service or database onto that host.

| Component | Runs where | Responsibility |
| --- | --- | --- |
| Open Brain service | Remote LXC, for example `http://10.71.20.49:3100` | Owns MCP-over-HTTP, auth, namespace policy, storage, search, curation tools. |
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

For trusted lab-only HTTP endpoints, such as `http://10.71.20.49:3100`, opt in
explicitly:

```bash
export OPENBRAIN_BASE_URL="http://10.71.20.49:3100"
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

## Safety and Spooling

`AgentMemory` sends the original caller payload to Open Brain. Redaction helpers
are for diagnostics and display only; they do not mutate live writes.

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
