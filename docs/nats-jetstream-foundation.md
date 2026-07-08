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
`com.rico.open-brain-nats` launchd service for the broker.

Dedicated Open Brain worker service:
`com.rico.open-brain-nats-worker`, documented in
`docs/core01-nats-worker-runbook.md`. This worker is separate from the HTTP
launchd service and subscribes to NATS request/reply subjects without making
HTTP `/health` depend on broker or subscription health.

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

# Credentials and exact permissions are release-time material. Do not commit
# them here. This skeleton is illustrative only; the release branch must replace
# it with the deployed nats-server version's least-privilege response model.
authorization {
  users: [
    {
      user: "$OPENBRAIN_NATS_BRIDGE_USER"
      password: "$OPENBRAIN_NATS_BRIDGE_PASSWORD"
      permissions: {
        # Bridge responder: receives memory requests, publishes health, request
        # replies, and minimized audit/trace metadata only. It must not be
        # reused by direct clients. Release config must prefer NATS
        # allow_responses or the deployed server's equivalent response-only
        # permission instead of broad _INBOX.> publish access.
        subscribe: [
          "ob.memory.>",
          "ob.health"
        ]
        publish: [
          # Placeholder for response-only reply subjects. Do not ship a blanket
          # _INBOX.> grant unless the release review explicitly proves no safer
          # response permission is available in the deployed NATS version.
          "ob.health",
          "ob.trace.>",
          "ob.context_pack.requests.>",
          "ob.context_pack.audit.>",
          "ob.promotion_candidates.>"
        ]
      }
    }
  ]
}
```

Release implementation must use `vaultwarden-secrets` or another approved
secret path for credentials and must show the final permissions in the release
PR. Do not put bearer tokens or NATS passwords in git, PR bodies, logs,
JetStream payloads, or stream metadata.

Direct client credentials are intentionally omitted from this foundation
skeleton. If a later release allows direct NATS clients, it must add a separate
requester credential with response-only inbox permissions (or the NATS
equivalent supported by the deployed server version), no bridge subscription
rights, and explicit Open Brain identity mapping. Do not use one shared
credential for bridge and client roles.

## Subjects

Subjects are ASCII, dot-delimited, and intentionally coarse. Scope belongs in
the JSON envelope and server predicates, not in subject names.

Core request/reply subjects:

| Subject | Purpose | Runtime status |
| --- | --- | --- |
| `ob.memory.context_pack` | Build `agent_context_pack` for one active scope. | available only when the server bridge is explicitly enabled |
| `ob.memory.session_start` | Optional bridge to existing `session_start`. | planned |
| `ob.memory.append_event` | Optional bridge to existing `append_session_event`. | planned |
| `ob.memory.wrap` | Optional bridge to existing `session_wrap`. | planned |
| `ob.memory.resolve` | Optional bridge to existing `resolve_entry`. | planned |
| `ob.health` | Lightweight NATS bridge health probe. | planned |

Do not add per-namespace, per-channel, or per-session subject fragments until a
measured routing need exists. Fine-grained subjects are easy to add and hard to
audit once clients depend on them.

## Request Envelope

> **Superseded wire shape.** The `openbrain.nats.request/response.v1` envelopes
> shown in this section are the ORIGINAL #223 design shape. The shipped wire has
> since been reconciled to the shared fleet-bus `Envelope` (compact JSON, wire
> key `from`, `kind` = `context_pack_request` / `context_pack_response`,
> top-level `payload.namespace`, subject `{env}.ob.memory.context_pack`). The
> authoritative wire contract is `docs/fleet-nats-integration.md` and
> `src/__fixtures__/nats-context-pack-wire.json`. The blocks below are retained
> only for design history; do not implement against them.

The request body is JSON and must be compatible with `agent_context_pack`
request semantics. `query` is optional and bounded like the MCP tool input; the
bridge must not require fields the MCP tool accepts as omitted.
The first NATS request/reply bridge also rejects request envelopes over 64 KiB.
That cap is intentionally stricter than the HTTP JSON body limit so transient
realtime messages stay small; clients should fall back to HTTP/MCP for larger
payloads until a later release explicitly raises the NATS envelope limit.

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
    "client_version": "<installed-package-version>",
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
operation, request id, latency, outcome, truncation counts, denial counts, and
degraded-source counts. They must not record raw credentials, headers, request
bodies, user queries, prompt context, memory snippets, source bodies, or raw
agent transcript text unless a later explicit debug mode is approved with
redaction and retention tests.

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
By default, these streams store minimized metadata only. The stream names reserve
places for future diagnostics; they are not permission to persist raw
`agent_context_pack` request/response bodies, queries, headers, or context.

## Python Client Status

`openbrain-memory` keeps HTTP as the default transport. The package now exposes
an opt-in `NatsTransport` boundary, but the Python client still fails closed or
delegates to HTTP fallback until a Python-native request/reply implementation is
approved. The server-side bridge is independently opt-in and advertises
availability only when explicitly enabled.

- Own the same `Transport` protocol shape as `UrllibTransport` where practical:
  `get()`, `delete()`, and `post()` remain the package boundary until a tested
  tool-call transport abstraction replaces it.
- Constructor/config:
  `NatsTransport(url, context_pack_subject="ob.memory.context_pack",
  fallback_transport=UrllibTransport(...), timeout=...)`.
- Dedicated NATS worker env, not the HTTP worker env:
  `OPENBRAIN_TRANSPORT=nats`, `OPENBRAIN_NATS_ENABLE_BRIDGE=true`,
  `OPENBRAIN_NATS_URL`, `OPENBRAIN_NATS_CONTEXT_PACK_SUBJECT`, and
  `OPENBRAIN_NATS_FALLBACK_HTTP=true`.
- HTTP Open Brain workers must keep `OPENBRAIN_TRANSPORT=http` and
  `OPENBRAIN_NATS_ENABLE_BRIDGE=false`, even when the same host has a local
  broker and NATS worker.
- Remote plaintext `nats://` broker URLs are not runtime-available by default.
  Use loopback/local NATS for local rollout, or set
  `OPENBRAIN_NATS_ALLOW_INSECURE_REMOTE=true` only for an explicitly approved
  trusted lab override.
- Request/reply mapping: only `agent_context_pack` is NATS-native in the first
  bridge. Other Open Brain calls continue over HTTP/MCP unless a later PR adds
  parity tests for their subjects.
- Contract gate: before using NATS, the client must read `get_contract()` over
  HTTP/MCP and require
  `realtime_transport.nats_jetstream.availability == "available"`. Planned or
  missing metadata falls back to HTTP.
- Authority: namespace/header/delegation semantics remain the Open Brain server
  policy. NATS credentials do not create namespace authority.
- Server tests cover fake request/reply transport, bearer-token rejection,
  contract-gated availability, HTTP fallback planning, and matching
  `agent_context_pack` response envelopes. Python-native request/reply tests
  remain future work.

## Hermes Opt-In Plan

Hermes may opt in only after the hosted bridge is deployed and canaried.
Initial config should be explicit:

```text
OPENBRAIN_TRANSPORT=http
OPENBRAIN_NATS_ENABLE_BRIDGE=false
OPENBRAIN_NATS_URL=nats://127.0.0.1:4222
# Subjects are env-prefixed via the fleet-bus builder
# ({env}.ob.memory.context_pack). Set the env, NOT a hand-pinned subject —
# pinning the legacy flat `ob.memory.context_pack` makes the worker subscribe to
# a subject clients no longer publish, and request/reply hangs.
OPENBRAIN_NATS_ENV=dev
OPENBRAIN_NATS_FALLBACK_HTTP=true
```

Until `OPENBRAIN_TRANSPORT=nats` is explicitly set and the contract advertises
NATS availability, Hermes must use HTTP/MCP.

## Local Validation Before Release

Local-only validation for #223:

- contract tests prove `get_contract` advertises NATS as planned, not runtime
  available by default, and as available only when the bridge is explicitly
  enabled for requested NATS transport with an allowed URL;
- server tests prove authorized NATS request/reply maps to the same
  `agent_context_pack` payload, rejects missing bearer auth before parsing,
  bounds request size, and hides raw parser/schema errors from callers;
- docs make core01 deployment optional/deferred;
- Python tests prove package contract pins match the server contract version.

Release validation, deferred until Rico approves deploy:

- install NATS on core01 through the release SOP;
- install or update `com.rico.open-brain-nats-worker` only after the runtime
  entrypoint exists and the worker tests pass;
- prove `/health` and monitoring endpoint locally on core01;
- prove HTTP `/health` remains healthy while the NATS worker is started,
  stopped, and restarted;
- create streams with the documented limits;
- run HTTP-vs-NATS parity tests for `agent_context_pack`;
- run Hermes canary with HTTP fallback enabled;
- only then consider making NATS the default path.

## Rollback Plan

Before NATS becomes the default path, rollback is to keep or restore
`OPENBRAIN_TRANSPORT=http` and stop using the NATS bridge. If a release deploys
the service and needs rollback:

1. Set Hermes/Open Brain clients back to HTTP and confirm `/mcp` reads/writes.
2. Stop or unload `com.rico.open-brain-nats-worker`.
3. Stop or unload `com.rico.open-brain-nats` if the broker itself is unsafe.
4. Preserve the JetStream store for inspection unless an explicit cleanup
   decision says it contains only minimized metadata and can be deleted.
5. Remove or rotate NATS credentials through the approved secret store.
6. Leave PostgreSQL/Open Brain untouched; NATS streams are not memory authority.
