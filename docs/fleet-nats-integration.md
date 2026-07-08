# Fleet NATS Integration — Open Brain

How the Hermes fleet adopts Open Brain's NATS request/reply transport, and how
Open Brain moves from its local core01 broker to the shared fleet bus on CT274.

This is the **paved road**: everything below is config, not code. The wire
format, subject convention, and auth model are already reconciled to
`rodaddy/fleet-bus`.

## Current state (v1 — local, auth-off)

Open Brain runs a dedicated NATS worker (`com.rico.open-brain-nats-worker`,
`scripts/run-nats-worker.ts`) separate from the HTTP service, so a broker/
subscription failure cannot take HTTP `/health` down. In v1 it points at a
**local broker** on core01 and the message-auth gate is **off** (trusted local
bus), matching fleet-bus's own bootstrapping stance.

| Setting | v1 default | Meaning |
|---|---|---|
| `OPENBRAIN_NATS_URL` | `nats://127.0.0.1:4222` | Local core01 broker |
| `OPENBRAIN_NATS_ENV` | `dev` | Subject env prefix — `{env}.ob.memory.context_pack` |
| `OPENBRAIN_NATS_ENABLE_BRIDGE` | `true` | Worker runs the request/reply bridge |
| `OPENBRAIN_NATS_REQUIRE_AUTH` | `false` | Message-auth gate OFF (local trust) |
| `OPENBRAIN_NATS_ALLOW_NAMESPACE_OVERRIDE` | `true` | `payload.namespace` may set the lane |

> **HARD PRECONDITION — cross-tenant read hole.** Auth-off (`REQUIRE_AUTH`
> unset/`false`) is ONLY safe on a **fully-trusted local loopback bus**. On any
> bus reachable by untrusted publishers — including the fleet bus on CT274 — a
> publisher can forge `payload.namespace` or the envelope `from` and read **any**
> namespace. Before pointing the worker at a non-loopback broker you MUST set
> `OPENBRAIN_NATS_REQUIRE_AUTH=true` (see the v2 flip below). This is a hard
> deployment gate, not a footnote: namespace is an Open Brain security boundary.

## Wire contract (what a fleet client must speak)

Open Brain uses the shared fleet `Envelope` (compact UTF-8 JSON). The wire key is
`from` (not `sender`); `version = 1`.

**Request** — subject `{env}.ob.memory.context_pack`:

```json
{
  "id": "<uuid>",
  "ts": "<ISO-8601 UTC>",
  "from": "<caller agent_id>",
  "kind": "context_pack_request",
  "correlation_id": "<uuid, echoed on the reply>",
  "version": 1,
  "payload": {
    "operation": "agent_context_pack",
    "identity": { "agent": "...", "platform": "...", "server_id": "...",
                  "channel_id": "...", "session_key": "...", "thread_id": null },
    "body": { "query": "...", "requested_sections": ["..."] },
    "namespace": "<optional lane override>"
  }
}
```

**Response** — on the NATS reply inbox, `kind="context_pack_response"`,
`from="open-brain"`, `correlation_id` = request `id`. `payload` carries
`{ status, operation, namespace_source, body }` or `{ ..., error }`.

`namespace_source` is stamped on every reply (a response-only field — never send
it in a request): `token` (REQUIRE_AUTH: derived from the bearer token) |
`override` (auth off: `payload.namespace` used) | `declared` (auth off: derived
from the declared identity) | `rejected` (unroutable / auth missing). Use it to
confirm your request landed in the lane you expected.

### Lane binding (v1, auth off)

1. `payload.namespace` present (and override allowed) → that lane
   (`namespace_source: "override"`).
2. else the lane is derived from the declared identity (`from` /
   `payload.identity.agent`) → `namespace_source: "declared"`.
3. else the request is **rejected** as unroutable — Open Brain never falls back
   to a global or shared namespace.

The declared/override namespace binds a **non-privileged** synthetic identity
whose access is that one namespace only; it flows through the same server-side
`canReadNamespace` check as every other request. There is no bypass.

## Moving to the fleet bus (CT274) — the v2 flip

The fleet NATS server ("honcho") runs on **CT274, `nats://10.71.20.74:4222`**
(monitor `http://10.71.20.74:8223/connz` — note port **8223**, not 8222).

To make Open Brain a real fleet participant, change **config only**:

```bash
# in /Users/rico/.config/open-brain/env.nats-worker on core01
OPENBRAIN_NATS_URL=nats://10.71.20.74:4222   # join the fleet bus
OPENBRAIN_NATS_ENV=prod                       # fleet env prefix (dev|prod)
OPENBRAIN_NATS_REQUIRE_AUTH=true              # turn the bearer gate ON
# OPENBRAIN_NATS_ALLOW_NAMESPACE_OVERRIDE is force-disabled when REQUIRE_AUTH=true
```

Open Brain's remote-URL guard (`isNatsUrlAllowedForRuntime`) must allow the
CT274 address; set `OPENBRAIN_NATS_ALLOW_INSECURE_REMOTE=true` (the fleet bus is
plain `nats://`, no TLS — consistent with fleet-bus convention).

### Auth on the fleet bus

Turning on `OPENBRAIN_NATS_REQUIRE_AUTH` re-enables Open Brain's per-request
**bearer-token** auth (the same `AUTH_TOKEN_*` tokens every OB agent/user already
holds — role tokens plus `AUTH_TOKEN_USER_<NAME>`). The token is sent as a NATS
header (`authorization: Bearer <token>`), the namespace is derived from the
token, and a client-supplied `payload.namespace` can no longer override it. This
keeps Open Brain **stricter** than fleet-bus's trust-the-bus default, which is
required because namespace is an Open Brain security boundary.

fleet-bus's own perimeter is the NATS server's ACLs plus per-service NATS
**connection** credentials. If CT274 enforces connection ACLs, Open Brain needs
a per-service NATS credential (creds file / nkey / user-pass in the URL) to
connect. As of this writing core01's OB env carries the app-level `AUTH_TOKEN_*`
set but **no** NATS connection credential — provisioning that on CT274 is an
infra step, tracked separately, and is the one piece that is not pure config.

## Hermes client side

- **Python:** `python/openbrain-memory` ships a `NatsTransport` +
  `FleetNatsDriver`. It emits/validates this same fleet `Envelope`. It
  optional-imports `fleet-nats` for byte-for-byte parity when the package is
  installed (private monorepo, `git+ssh` with `#subdirectory=packages/fleet-nats`)
  and mirrors the shape locally otherwise. Enable the `nats` extra for a live
  driver: `pip install 'openbrain-memory[nats]'`.
- **Per agent:** set the fleet env contract the client reads —
  `FLEET_NATS_URL`, `FLEET_AGENT_ID=open-brain`, `FLEET_ENV` — then drive a
  context-pack request/reply through the configured transport. Verify the agent
  appears on the CT274 `/connz` probe and that a representative read returns
  `namespace_source: "declared"` for the expected lane.

Do not use TN01 / `10.71.1.11` as a control point. Roll agents through the
standard update path (`ssh 10.71.1.71` → `/mnt/collab/agent-backups/rtech-hermes`
→ `git pull --ff-only` → `scripts/update.sh`) once the server side is live.

## Upstream follow-up

fleet-bus's `fleet_nats/subjects.py` has no `ob_*` builder yet; Open Brain
mirrors the `{env}.ob.memory.context_pack` convention in `src/nats-subjects.ts`
(TS) and `nats_wire.py` (Python). File a `fleet-nats` issue to add an
`ob_context_pack(env)` builder so subject construction has a single source of
truth and the hand-maintained cross-language parity is retired.
