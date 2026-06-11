# openbrain-memory

Python client package for talking to a remote Open Brain service.

This package is installed on agent hosts. The Open Brain service remains remote
and exposes HTTP endpoints such as `/health` and `/mcp`.

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
