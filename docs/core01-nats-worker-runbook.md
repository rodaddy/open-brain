# Core01 Dedicated NATS Worker Runbook

Issue: #282.
Status: runtime entrypoint and launchd shape exist; install only from a release
that has passed the validation gate below.

## Boundary

The NATS bridge must run as a separate launchd service from the HTTP workers.
HTTP workers stay in `OPENBRAIN_TRANSPORT=http` mode and keep serving `/health`
on `3100`, `3101`, and `3102`. The NATS worker subscribes to the env-prefixed
subject `{env}.ob.memory.context_pack` (e.g. `dev.ob.memory.context_pack`; env
from `OPENBRAIN_NATS_ENV`) and may fail or restart without taking HTTP health
down.

The broker and worker are separate services:

| Component | Launchd label | Responsibility |
| --- | --- | --- |
| HTTP Open Brain | `com.rico.open-brain` | HTTP/MCP entrypoint and two HTTP workers. |
| NATS broker | `com.rico.open-brain-nats` | Local NATS/JetStream server on `127.0.0.1:4222`. |
| NATS Open Brain worker | `com.rico.open-brain-nats-worker` | Request/reply bridge for `{env}.ob.memory.context_pack`. |

Do not put the NATS subscription path back into the HTTP launchd service. Broker
restart, subscription failure, malformed NATS envelopes, or worker crash loops
must be visible in NATS worker logs without degrading HTTP `/health`.

## DEPLOYMENT PRECONDITION — message auth (READ BEFORE ENABLING)

Enabling this worker with `OPENBRAIN_NATS_REQUIRE_AUTH` unset or `false` on any
NATS bus reachable by untrusted publishers is a **cross-tenant read hole**: a
publisher can forge `payload.namespace` or the envelope `from` and read **any**
namespace. Auth-off is ONLY safe on a **fully-trusted local loopback bus**
(`nats://127.0.0.1:4222`, no untrusted publishers).

- **Local core01 broker (v1):** auth-off is acceptable because the bus is
  loopback-only and no untrusted publisher can reach it.
- **Fleet bus (CT274, `nats://10.71.20.74:4222`) or any shared/remote broker:**
  you MUST set `OPENBRAIN_NATS_REQUIRE_AUTH=true` before enabling the worker.
  With `REQUIRE_AUTH=true` the per-request bearer gate is on and the
  `payload.namespace` override is force-disabled (mutually exclusive), so a
  client can no longer forge a lane; the namespace is derived from the token.

Treat this as a hard gate, not a footnote: do not point the worker at a
non-loopback broker until `OPENBRAIN_NATS_REQUIRE_AUTH=true` is set in the worker
env. namespace is an Open Brain security boundary.

## Files

- launchd template:
  `docs/deploy/com.rico.open-brain-nats-worker.plist.template`
- runtime app:
  `/Volumes/ThunderBolt/open-brain/app`
- shared HTTP env:
  `/Users/rico/.config/open-brain/env`
- NATS worker env:
  `/Users/rico/.config/open-brain/env.nats-worker`
- logs:
  `/Volumes/ThunderBolt/open-brain/logs/nats-worker.out.log`
  and `/Volumes/ThunderBolt/open-brain/logs/nats-worker.err.log`

The worker env should source the shared production env and then set only
worker-specific overrides. Keep secrets in the env file or approved secret
store; do not commit them. The launchd template fails closed when this file is
missing or unreadable.

Expected shape:

```zsh
source /Users/rico/.config/open-brain/env
OPENBRAIN_TRANSPORT=nats
OPENBRAIN_NATS_ENABLE_BRIDGE=true
OPENBRAIN_NATS_URL=nats://127.0.0.1:4222
# Subject is built env-prefixed: {env}.ob.memory.context_pack. Set the env, not
# a hand-pinned subject. Do NOT set OPENBRAIN_NATS_CONTEXT_PACK_SUBJECT to the
# legacy flat `ob.memory.context_pack` — clients publish the env-prefixed
# subject and request/reply would hang.
OPENBRAIN_NATS_ENV=dev
OPENBRAIN_NATS_FALLBACK_HTTP=true
OPEN_BRAIN_NATS_WORKER_HEALTH_PORT=3110
OPEN_BRAIN_RUN_MIGRATIONS=0
OPEN_BRAIN_WORKER_NAME=open-brain-nats-worker
QMD_PATH=/Volumes/ThunderBolt/qmd/open-brain-qmd.ts
```

HTTP worker env must stay in HTTP mode:

```zsh
OPENBRAIN_TRANSPORT=http
OPENBRAIN_NATS_ENABLE_BRIDGE=false
```

## Install Gate

Install the worker only after a release includes `scripts/run-nats-worker.ts`
and evidence for:

- automated bridge tests for successful `{env}.ob.memory.context_pack` request/reply,
  missing or invalid bearer auth, malformed NATS envelopes, oversized payloads,
  and degraded bridge health;
- automated worker tests for dedicated-worker boundary forcing, missing broker
  URL fail-closed behavior, subscription startup, shutdown cleanup, constant-time
  bearer-token matching, and health-bind cleanup after bridge startup;
- live release proof for broker unavailable behavior and HTTP health staying
  healthy while the NATS worker starts, stops, and restarts.

If the entrypoint does not exist, stop at documentation and report that runtime
work is still required. Do not patch around it in launchd with the HTTP server
entrypoint.

## Install Or Update

Run these commands on core01 after the release gate in
`docs/local-release-deploy-sop.md` has passed and the runtime app is staged at
`/Volumes/ThunderBolt/open-brain/app`:

First create or validate the worker env file. It should be mode `0600`, source
`/Users/rico/.config/open-brain/env`, and set the worker-specific overrides from
the Files section above:

```zsh
sudo test -r /Users/rico/.config/open-brain/env
sudo test -r /Users/rico/.config/open-brain/env.nats-worker
/opt/homebrew/bin/bash -n /Users/rico/.config/open-brain/env.nats-worker
```

```zsh
sudo install -d -m 0755 /Volumes/ThunderBolt/open-brain/logs
sudo cp \
  /Volumes/ThunderBolt/open-brain/app/docs/deploy/com.rico.open-brain-nats-worker.plist.template \
  /Library/LaunchDaemons/com.rico.open-brain-nats-worker.plist
sudo chown root:wheel /Library/LaunchDaemons/com.rico.open-brain-nats-worker.plist
sudo chmod 0644 /Library/LaunchDaemons/com.rico.open-brain-nats-worker.plist
sudo launchctl bootstrap system /Library/LaunchDaemons/com.rico.open-brain-nats-worker.plist
sudo launchctl kickstart -k system/com.rico.open-brain-nats-worker
```

For updates after the service is already bootstrapped, reload the launchd job
definition. `kickstart` alone restarts the currently loaded definition and is
not enough when `ProgramArguments`, environment, log paths, or resource limits
changed:

```zsh
sudo cp \
  /Volumes/ThunderBolt/open-brain/app/docs/deploy/com.rico.open-brain-nats-worker.plist.template \
  /Library/LaunchDaemons/com.rico.open-brain-nats-worker.plist
sudo chown root:wheel /Library/LaunchDaemons/com.rico.open-brain-nats-worker.plist
sudo chmod 0644 /Library/LaunchDaemons/com.rico.open-brain-nats-worker.plist
sudo launchctl bootout system/com.rico.open-brain-nats-worker
sudo launchctl bootstrap system /Library/LaunchDaemons/com.rico.open-brain-nats-worker.plist
sudo launchctl kickstart -k system/com.rico.open-brain-nats-worker
sudo launchctl print system/com.rico.open-brain-nats-worker
```

## Verification

Confirm the service shape:

```zsh
sudo launchctl print system/com.rico.open-brain
sudo launchctl print system/com.rico.open-brain-nats
sudo launchctl print system/com.rico.open-brain-nats-worker
```

Confirm HTTP health is independent:

```zsh
curl -fsS http://127.0.0.1:3100/health
curl -fsS http://127.0.0.1:3101/health
curl -fsS http://127.0.0.1:3102/health
sudo launchctl kickstart -k system/com.rico.open-brain-nats-worker
curl -fsS http://127.0.0.1:3100/health
curl -fsS http://127.0.0.1:3101/health
curl -fsS http://127.0.0.1:3102/health
```

Confirm NATS request/reply with the release-owned smoke tool or approved client.
Responses are fleet envelopes (compact UTF-8 JSON, wire key `from`, not `sender`)
with `kind="context_pack_response"`, `from="open-brain"`, and `correlation_id`
echoing the request `id`. The success reply is:

```json
{
  "id": "<request id>",
  "ts": "<ISO-8601 UTC>",
  "from": "open-brain",
  "kind": "context_pack_response",
  "correlation_id": "<request id>",
  "version": 1,
  "payload": {
    "status": "ok",
    "operation": "agent_context_pack",
    "namespace_source": "token|override|declared",
    "body": { "...": "context pack" }
  }
}
```

Error replies use the same envelope with an error payload:

```json
{
  "id": "<request id or 'unknown'>",
  "ts": "<ISO-8601 UTC>",
  "from": "open-brain",
  "kind": "context_pack_response",
  "correlation_id": "<request id or null>",
  "version": 1,
  "payload": {
    "status": "error",
    "operation": "agent_context_pack",
    "namespace_source": "token|override|declared|rejected|null",
    "error": {
      "code": "permission_denied|unroutable|bad_request|payload_too_large|temporarily_unavailable|tool_error|internal_error",
      "message": "redacted failure summary"
    }
  }
}
```

A missing reply inbox is not a successful request/reply smoke; inspect the NATS
worker logs and `/health` for bridge request, subscription, shutdown, or close
failures.

Record the command used, response status, HTTP health before and after worker
restart, and any JetStream stream creation/defer evidence in the rollout
receipt for #223 and #282.

## Rollback

Rollback of the NATS worker must not roll back PostgreSQL or HTTP workers.

```zsh
sudo launchctl bootout system/com.rico.open-brain-nats-worker
curl -fsS http://127.0.0.1:3100/health
curl -fsS http://127.0.0.1:3101/health
curl -fsS http://127.0.0.1:3102/health
```

Preserve logs and JetStream state for inspection unless an explicit cleanup
decision says only minimized metadata exists and the state can be removed. If
the worker env carried credentials, rotate or remove them through the approved
secret path.

## Local Mac Dogfood NATS Lane (loopback only)

The same two-service shape as core01, but pointed at the local dogfood clone
(`/Volumes/ThunderBolt/open-brain-local`) instead of the core01 runtime. Stood
up and proven live on 2026-08-04.

| Component | Launchd label | Notes |
| --- | --- | --- |
| Local HTTP clone | `com.rico.open-brain-local-clone` | Pre-existing; stays `OPENBRAIN_TRANSPORT` empty (HTTP mode). |
| NATS broker | `com.rico.open-brain-nats` | `nats-server` on **127.0.0.1:4222**, monitor 127.0.0.1:8222. |
| NATS worker | `com.rico.open-brain-local-nats-worker` | Bridge for `dev.ob.memory.context_pack`, own health on 3110. |

These are **user LaunchAgents** (`~/Library/LaunchAgents`, `launchctl bootstrap
gui/$(id -u) ...`), not system LaunchDaemons, matching the existing local clone
service. No `sudo` is involved.

### SCOPE LINE — loopback only, auth off

This lane runs `OPENBRAIN_NATS_REQUIRE_AUTH=false`, which is safe **only**
because the broker binds `127.0.0.1`. Both preconditions above ("HARD
PRECONDITION" in `docs/fleet-nats-integration.md` and "DEPLOYMENT PRECONDITION"
in this file) apply unchanged: on any bus an untrusted publisher can reach, a
forged `payload.namespace` or envelope `from` reads **any** namespace.

`nats-server`'s default bind is `0.0.0.0`, so plain `brew services start
nats-server` would open exactly that hole. The broker therefore runs from
`/opt/homebrew/etc/nats-server.conf` (`host: 127.0.0.1`) under its own
LaunchAgent rather than the Homebrew service, and the `-c` flag is load-bearing.

**Putting this broker on the LAN is a separate follow-up, and the auth flip
comes FIRST:** set `OPENBRAIN_NATS_REQUIRE_AUTH=true` in the worker env (which
also force-disables the `payload.namespace` override), then change the bind.
Never the other way round.

### Files

- broker config: `/opt/homebrew/etc/nats-server.conf`
- broker plist: `~/Library/LaunchAgents/com.rico.open-brain-nats.plist`
- worker plist: `~/Library/LaunchAgents/com.rico.open-brain-local-nats-worker.plist`
- worker env: `/Volumes/ThunderBolt/open-brain-local/local-clone.env.nats-worker` (mode 0600)
- logs: `~/Library/Logs/open-brain-local/nats-worker.{out,err}.log`

The worker env sources `local-clone.env` and then sets only the v1 NATS
overrides (`OPENBRAIN_NATS_URL`, `OPENBRAIN_NATS_ENV=dev`,
`REQUIRE_AUTH=false`, `ALLOW_NAMESPACE_OVERRIDE=true`). It does NOT set
`OPENBRAIN_TRANSPORT` or `OPENBRAIN_NATS_ENABLE_BRIDGE`, because
`readNatsWorkerBoundary()` in `src/nats-worker.ts` forces both — the
dedicated-worker boundary cannot be disabled by editing the env file.

> **Env-var plumbing differs from the HTTP service.** The HTTP clone starts
> through `scripts/local-clone.ts`, whose `CHILD_ENV_KEYS` allowlist drops any
> variable not named in it (the #543 `OPENBRAIN_TRACING_*` failure). The NATS
> worker does **not** go through that launcher — the plist sources the env file
> and `exec`s `scripts/run-nats-worker.ts`, which reads `process.env` directly.
> Adding a worker variable means editing the env file only; no allowlist.

### Deploy coupling

`scripts/local-clone-deploy.sh` swaps the runtime directory that BOTH services
execute from, so the worker must be restarted or it keeps running the previous
revision. Set the label so the deploy kickstarts it:

```zsh
OPENBRAIN_NATS_WORKER_LABEL=com.rico.open-brain-local-nats-worker \
OPENBRAIN_SERVICE_LABEL=com.rico.open-brain-local-clone \
  scripts/local-clone-deploy.sh
```

The kickstart is non-fatal (a WARN), matching core01's behavior: a clone with no
worker installed is unaffected.

### What `/health` on 3100 does and does NOT show

`curl -s 127.0.0.1:3100/health | jq .nats` keeps reporting
`"requested_transport": "http"` and `"availability": "not_runtime_available"`
**even when the worker is running, and that is correct.** `server/config/nats.ts`
derives that block from the HTTP process's OWN environment
(`parseNatsConfig(process.env)`); the HTTP service is deliberately in HTTP mode
and never observes the separate worker process. The unavailable reason is
`transport_not_requested`.

The worker's bridge health is on its own port:

```zsh
curl -fsS http://127.0.0.1:3110/health   # {"status":"healthy","nats":{"availability":"available",...}}
curl -fsS 'http://127.0.0.1:8222/connz?subs=1'   # broker's view: 1 conn, subscribed to the subject
```

Do not "fix" 3100 by setting `OPENBRAIN_TRANSPORT=nats` in the clone env — that
would put the HTTP service back into the bridge business, which is exactly the
boundary this runbook exists to keep.

### `embed_watermark` on 3110 (#724 item 3)

`/health` on 3110 carries an OPTIONAL `embed_watermark` block beside `nats`:

```json
{
  "status": "healthy",
  "nats": { "availability": "available", "...": "..." },
  "embed_watermark": {
    "stale": false,
    "newest_raw_age_seconds": 45,
    "newest_embedded_age_seconds": 60,
    "lag_seconds": 15,
    "lag_threshold_seconds": 3600,
    "raw_rows_recent": 128,
    "reason": "embed watermark within threshold"
  },
  "timestamp": "..."
}
```

**Why it exists.** The maintenance producer ticked for three days with no
consumer draining the embed queue. Raw rows kept arriving, embedded rows
stopped, and nothing anywhere COMPARED the two — so every liveness surface
stayed green while the corpus quietly stopped being searchable. This is the
same argument `maintenance_producer` (#625) and `capture` (#647) make on the
HTTP payload, applied to the third background lane, and the block deliberately
matches their shape (`server/transport/health.ts:14-33`, `:35-79`).

**Reading it.**

- `stale: true` is THE verdict and flips `status` to `degraded` with HTTP 503,
  even when `nats.availability` is `available`. A healthy bridge must not be
  able to hold this endpoint green while the embed lane is days behind — that
  combination is exactly the shape of the outage.
- `stale` requires `raw_rows_recent > 0`. A quiet week produces an old embedded
  row too; alarming on an idle corpus is how a check stops being read. An idle
  corpus reports the lag numbers and stays `healthy`.
- **Absence is not staleness.** A worker that composes no embed observer emits
  NO `embed_watermark` key and cannot be degraded by one. Missing block means
  "not my job"; `stale: true` means "my job and I am not doing it". Do not read
  an absent block as a failure. In the DEPLOYED worker the block is always
  present (see "Who builds the observer" below), so an absent block there means
  the process is older than #724 item 3 — not that the lane is idle.
- `lag_threshold_seconds` reports the bound the verdict was actually taken
  against, so a reading is interpretable without knowing the deployed config.

**Threshold.** `OPENBRAIN_EMBED_WATERMARK_LAG_THRESHOLD_SECONDS`, default
`3600` (one hour — the outage ran three days; the goal is catching it in about
an hour). Nothing is adjusted silently: the worker's startup log line carries
`embed_watermark_lag_threshold_seconds` and
`embed_watermark_lag_threshold_source` (`default`, `env`, or
`invalid_env_default`), plus `embed_watermark_observed`, so an unset key is
visible as a default rather than looking configured, and an unusable value
announces the original it replaced.

**Who builds the observer, and what it reads.** `startNatsWorkerProcess`
constructs one by default against the worker's own pool
(`src/embed-watermark-observer.ts`); the `embedWatermarkHealth` option remains
an override for tests, but its absence no longer means "no observer". The live
entrypoint passes only `{ env: process.env }` and gets a real one. The startup
log line reports `embed_watermark_observer_source` as `default_pool_observer`
or `injected`, so which one is in force is visible without reading code.

The watermark is registry-driven, not a hard-coded table: it queries every
`EMBEDDING_TARGETS` entry whose `provenance.hasEmbeddedAt` is true
(`src/embedding-targets.ts`), which is the same registry the embedding repair
path drives off. `ob_entities` is skipped because it declares
`ENTITY_PROVENANCE` — it has an `embedding` column and no `embedded_at`. Adding
a target to the registry extends the watermark with no change here.

**It is cached, and `/health` never waits on Postgres.** The health handler is
synchronous, so the accessor returns a cached reading and schedules a
background refresh once that reading is older than
`EMBED_WATERMARK_CACHE_TTL_MS` — **30 seconds**, announced at startup as
`embed_watermark_cache_ttl_seconds` beside the threshold. A reading up to 30s
old cannot move a verdict taken against a one-hour bound, and the cost of the
endpoint is at most one aggregate query per 30s no matter how often it is
scraped. The observer is primed once during startup so the first probe answers
with numbers.

**When the query itself fails.** The block is still published, with
`stale: false` and a `reason` naming the read failure; the numeric fields carry
the last successful reading, or `-1` (explicitly "not measured", never an age)
if there has never been one. A database the observer cannot reach is evidence
about the OBSERVER, not the embed lane — flipping to `degraded` on it would
make a transient blip indistinguishable from the three-day outage, and a 503
that fires for unrelated reasons is how a check stops being read. It equally
does not go silently absent or hold a stale green: the reason says the read
failed and every failure is logged as `Open Brain embed watermark read failed`.
The refresh catches its own errors, so a failing query can never crash
`/health`.

**Empty corpus.** No rows in any target reports `-1` ages,
`raw_rows_recent: 0`, and `stale: false`. An empty corpus is not a stalled lane;
this is the same guard that keeps an idle week quiet.

```zsh
curl -fsS http://127.0.0.1:3110/health | jq .embed_watermark
```

### Verify

```zsh
launchctl list | rg 'open-brain'
curl -fsS http://127.0.0.1:3110/health
curl -fsS 'http://127.0.0.1:8222/connz?subs=1'
curl -fsS http://127.0.0.1:3100/health    # must stay healthy across a worker restart
launchctl kickstart -k "gui/$(id -u)/com.rico.open-brain-local-nats-worker"
```

### The silence is fixed; large context packs still do not fit (#549, 2026-08-04)

A live request/reply on `dev.ob.memory.context_pack` returns `status: ok` in
~1.2s for `repo_facts` / `working_set` / `pointers`. Asking for
`durable_memory` in the `rico` namespace currently builds a **58.5 MB** reply
(the `durable_memory` section alone is 39.9 MB), which exceeds the broker's
8 MB `max_payload`, so the client rejects the publish.

**How the rejection actually surfaces:** the nats.js client THROWS on it. Its
`Msg.respond()` publishes through `protocol.publish()`, which raises
`NatsError(MAX_PAYLOAD_EXCEEDED)` once the encoded length passes
`info.max_payload` (`nats-base-client/msg.js` -> `protocol.js`). It does NOT
return false — `respond()` returns false in exactly one case, a request that
carried no reply inbox at all, which is unrelated to size.

**What used to happen:** that throw escaped to
`processNatsSubscriptionMessage`, whose catch logged the generic **"NATS
context-pack bridge request failed"** and published nothing, so the caller saw
**no reply at all** and waited out its own timeout with no client-visible
reason. The "NATS request did not include a reply inbox" message was never the
one this path produced; it was reserved for its own, correct condition.

**What happens now (#549):** the bridge answers with a redacted
`payload_too_large` error envelope carrying the same `correlation_id` as a
normal reply, so the caller is released immediately instead of timing out. The
envelope is content-free — it names the measured reply bytes, the broker's own
advertised `max_payload`, and which sections were requested, and carries no pack
data. Before publishing, the bridge compares the encoded reply against the
figure the broker advertises on the connection (`connection.info.max_payload`),
never a value of Open Brain's own, so a broker advertising the NATS protocol
default of 1 MB and this one advertising 8 MB are both handled correctly. When
the figure is unreadable the reply cannot be pre-judged, so the publish is
attempted — and that call is wrapped, so a thrown `MAX_PAYLOAD_EXCEEDED` routes
to the same error envelope instead of escaping to the handler-error catch. The
throw is matched by its machine **code**, never by message text, so a reworded
client string cannot silently reopen this. Any other throw is not the bridge's
to reinterpret and is rethrown unchanged. Only when `respond()` returns false —
the genuine no-reply-inbox condition — does the bridge log a missing reply
inbox, which is the accurate reading of that case.

The handler still builds the full pack first, and nothing about what it builds
changed; this changed only how an undeliverable reply is answered.

**Resolved (#563, operator ruling 2026-08-08, ledger item 23 in
`docs/issue-graph.md`).** The 58.5 MB reply — re-measured at 60.4 MiB on
2026-08-05, because the corpus grows daily — did not fit an 8 MB broker, so a
`durable_memory` request on this namespace got a clear error rather than a
pack. The 8 MB figure is the NATS server's own `max_payload`, not an Open Brain
choice.

The resolution was not to make the reply fit. It was that a whole-corpus reply
is not a shape the server should ever produce: "I don't see any reason why this
whole thing would ship in a single shot to anywhere. It defeats the whole
purpose of this." A `durable_memory` reply now carries a BURST of records
(`DURABLE_MEMORY_BURST_ITEMS`, 10 — the top of the 5–10 range the ruling names)
plus the `pointers` pool the pack already builds, and a `next` handle. A caller
that legitimately wants the whole corpus replays the request with that handle
and receives the rest as further bursts, server→client, "not ever as the whole
file."

**This changed delivery, not data.** Records are still stored whole and
returned whole; every record the query matches is still retrievable, in bursts,
by walking the handle to completion. Nothing is truncated for being late in the
ranking, and the storage side is untouched (#604/#606). A pack whose largest
single reply is now the size of ten records rather than the size of the
namespace fits any broker by construction, so the `max_payload` measurement
above is no longer the binding constraint on this path.

Executable acceptance: `scripts/done-means/563-bounded-recall.sh`.

