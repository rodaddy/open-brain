# NATS/JetStream Foundation For Realtime Open Brain

Status: planned transport foundation, not deployed.
Parent issue: #223.
Depends on: `agent_context_pack` contract in
`docs/agent-context-pack-contract.md`.

## Boundary

NATS is a transport for first-class Open Brain memory calls. It is not a new
memory authority, not a durable-memory store, and not a bypass around Open
Brain auth or namespace predicates.

The first request/reply subject carries the planned `agent_context_pack`
envelope. Existing HTTP `/mcp` and direct Open Brain client access remain the
compatibility and fallback path until a live canary proves parity.

## Source Notes

This plan follows NATS' documented operating model:

- NATS servers should use a config file for durable service configuration.
- Client port `4222` is the documented default, and monitoring commonly uses a
  separate HTTP listener.
- Core request/reply publishes a request on a subject with a reply inbox.
- JetStream streams should have explicit retention limits such as max age,
  bytes, or message count.
- NATS recommends ASCII-friendly names for subjects, streams, durables, and
  other system entities.

Primary references:

- https://docs.nats.io/running-a-nats-service/configuration
- https://docs.nats.io/nats-concepts/core-nats/reqreply
- https://docs.nats.io/nats-concepts/jetstream/streams
- https://docs.nats.io/running-a-nats-service/configuration/resource_management
- https://docs.nats.io/nats-concepts/subjects

## Core01 Config Plan

Planned host:
core01 Mac Mini, co-located with hosted Open Brain.

Planned service:
`com.rico.open-brain-nats` launchd service.

Planned config path:
`/Volumes/ThunderBolt/open-brain/nats/nats-server.conf`.

Planned JetStream store:
`/Volumes/ThunderBolt/open-brain/nats/jetstream`.

Planned listeners:

- Client listen: `127.0.0.1:4222` for local Open Brain/Hermes processes.
- Monitoring listen: `127.0.0.1:8222`, reverse-proxied only if a later release
  explicitly approves it.

Planned NATS config skeleton:

```conf
server_name: open-brain-core01
listen: "127.0.0.1:4222"
http: "127.0.0.1:8222"
max_payload: 1MB

jetstream {
  store_dir: "/Volumes/ThunderBolt/open-brain/nats/jetstream"
  max_memory_store: 512MB
  max_file_store: 10GB
  domain: open-brain
}

# Credentials are release-time material. Do not commit them here.
authorization {
  users: [
    {
      user: "$OPENBRAIN_NATS_BRIDGE_USER"
      password: "$OPENBRAIN_NATS_BRIDGE_PASSWORD"
      permissions: {
        publish: ["ob.memory.>", "ob.health"]
        subscribe: ["ob.memory.>", "ob.health", "_INBOX.>"]
      }
    }
  ]
}
```

Release implementation must use `vaultwarden-secrets` or another approved
secret path for credentials. Do not put bearer tokens or NATS passwords in git,
PR bodies, logs, JetStream payloads, or stream metadata.

## Subjects

Subjects are ASCII, dot-delimited, and intentionally coarse. Scope belongs in
the JSON envelope and server predicates, not in subject names.

Core request/reply subjects:

| Subject | Purpose | Runtime status |
| --- | --- | --- |
| `ob.memory.context_pack` | Build `agent_context_pack` for one active scope. | planned |
| `ob.memory.session_start` | Optional bridge to existing `session_start`. | planned |
| `ob.memory.append_event` | Optional bridge to existing `append_session_event`. | planned |
| `ob.memory.wrap` | Optional bridge to existing `session_wrap`. | planned |
| `ob.memory.resolve` | Optional bridge to existing `resolve_entry`. | planned |
| `ob.health` | Lightweight NATS bridge health probe. | planned |

Do not add per-namespace, per-channel, or per-session subject fragments until a
measured routing need exists. Fine-grained subjects are easy to add and hard to
audit once clients depend on them.

## Request Envelope

The request body is JSON and must be compatible with `agent_context_pack`
request semantics.

```json
{
  "schema": "openbrain.nats.request.v1",
  "operation": "agent_context_pack",
  "request_id": "uuid-or-client-trace-id",
  "identity": {
    "namespace_source": "authorization",
    "agent": "nagatha",
    "platform": "discord",
    "server_id": "rodaddy-live",
    "channel_id": "ob-dev",
    "thread_id": null,
    "session_key": "discord:rodaddy-live:ob-dev:nagatha"
  },
  "body": {
    "query": "what is the current task state?",
    "requested_sections": ["durable_lane_context", "durable_memory"],
    "budget": {
      "max_tokens": 3500,
      "max_latency_ms": 750
    }
  },
  "metadata": {
    "client": "openbrain-memory",
    "client_version": "0.1.5",
    "transport": "nats"
  }
}
```

The response body mirrors the HTTP/MCP result envelope:

```json
{
  "schema": "openbrain.nats.response.v1",
  "request_id": "uuid-or-client-trace-id",
  "status": "ok",
  "result": {},
  "warnings": [],
  "error": null
}
```

Error responses must keep the same security posture as HTTP/MCP responses:
redact secrets, avoid source bodies in permission errors, and include retryable
degradation metadata instead of stack traces.

## Auth And Namespace Boundary

NATS connection credentials authorize use of the transport. They do not replace
Open Brain server-side auth.

The bridge must invoke the same Open Brain authority paths as HTTP/MCP:

- bearer-token or trusted service identity is resolved before tool execution;
- namespace is derived from authorization unless an admin/ob-admin delegation
  path explicitly validates it;
- exact-scope predicates for working/recovery data are enforced before search,
  ranking, truncation, or response assembly;
- denied namespaces and sources appear as scoped warnings, not leaked content.

Bearer tokens must not be persisted to JetStream streams. If a release later
allows direct NATS clients, the bridge must map NATS credentials to an Open
Brain server identity or pass short-lived auth through a non-persisted
request/reply message only. Audit streams may record role, namespace, subject,
operation, request id, latency, and outcome, never raw credentials.

## JetStream Streams

JetStream is included from the foundation so stream names, retention, and
replay semantics are contract-shaped before live deployment.

| Stream | Subjects | Retention | Storage | Purpose |
| --- | --- | --- | --- | --- |
| `OB_AGENT_TRACE` | `ob.trace.>` | Limits; max age 24h; max bytes 512MB | file | Scoped realtime trace events, not durable memory. |
| `OB_CONTEXT_PACK_REQUESTS` | `ob.context_pack.requests.>` | Limits; max age 1h; max bytes 128MB | file | Optional request diagnostics for NATS-capable agents. |
| `OB_CONTEXT_PACK_AUDIT` | `ob.context_pack.audit.>` | Limits; max age 7d; max bytes 1GB | file | Pack build receipts, latency, truncation, and denial summaries. |
| `OB_PROMOTION_CANDIDATES` | `ob.promotion_candidates.>` | Limits; max age 7d; max bytes 512MB | file | Explicit client nominations only; not automatic shared truth. |

No stream is durable memory. PostgreSQL remains the memory authority. Stream
consumers must treat trace/recovery material as quarantined evidence until a
client explicitly wraps, promotes, relegates, discards, or nominates it.

## Python Client Plan

`openbrain-memory` will keep HTTP as the default transport. A future
`NatsTransport` must be opt-in and sit behind the same facade semantics:

- same `OpenBrainClient`/`AgentMemory` call shapes where possible;
- same contract-version validation before a client assumes NATS support;
- same namespace/header/delegation policy;
- HTTP fallback when NATS is unavailable or the server contract does not
  advertise `realtime_transport.nats_jetstream.availability == "available"`;
- fake-transport tests before any live canary.

This PR does not implement `NatsTransport`.

## Hermes Opt-In Plan

Hermes may opt in only after the hosted bridge is deployed and canaried.
Initial config should be explicit:

```text
OPENBRAIN_TRANSPORT=http
OPENBRAIN_NATS_URL=nats://127.0.0.1:4222
OPENBRAIN_NATS_CONTEXT_PACK_SUBJECT=ob.memory.context_pack
OPENBRAIN_NATS_FALLBACK_HTTP=true
```

Until `OPENBRAIN_TRANSPORT=nats` is explicitly set and the contract advertises
NATS availability, Hermes must use HTTP/MCP.

## Local Validation Before Release

Local-only validation for #223:

- contract tests prove `get_contract` advertises NATS as planned, not runtime
  available;
- docs make core01 deployment optional/deferred;
- Python tests prove package contract pins match the server contract version.

Release validation, deferred until Rico approves deploy:

- install NATS on core01 through the release SOP;
- prove `/health` and monitoring endpoint locally on core01;
- create streams with the documented limits;
- run HTTP-vs-NATS parity tests for `agent_context_pack`;
- run Hermes canary with HTTP fallback enabled;
- only then consider making NATS the default path.
