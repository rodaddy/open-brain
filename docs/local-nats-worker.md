# Local Mac NATS Worker (loopback only)

Split out of the retired-host runbook on 2026-10-05 (issue 1678).

The NATS bridge runs as a separate launchd service from the HTTP clone, pointed
at the local clone (`/srv/open-brain-local`). Stood up and
proven live on 2026-08-04.

| Component | Launchd label | Notes |
| --- | --- | --- |
| Local HTTP clone | `com.rico.open-brain-local-clone` | Pre-existing; stays `OPENBRAIN_TRANSPORT` empty (HTTP mode). |
| NATS broker | `com.rico.open-brain-nats` | `nats-server` on **127.0.0.1:4222**, monitor 127.0.0.1:8222. |
| NATS worker | `com.rico.open-brain-local-nats-worker` | Bridge for `dev.ob.memory.context_pack`, own health on 3110. |

These are **user LaunchAgents** (`~/Library/LaunchAgents`, `launchctl bootstrap
gui/$(id -u) ...`), not system LaunchDaemons, matching the existing local clone
service. No `sudo` is involved.

Do not put the NATS subscription path back into the HTTP service. Broker
restart, subscription failure, malformed NATS envelopes, or worker crash loops
must be visible in NATS worker logs without degrading HTTP `/health`.

## SCOPE LINE — loopback only, auth off

This lane runs `OPENBRAIN_NATS_REQUIRE_AUTH=false`, which is safe **only**
because the broker binds `127.0.0.1`. The "HARD PRECONDITION" in
`docs/fleet-nats-integration.md` applies unchanged: on any bus an untrusted
publisher can reach, a forged `payload.namespace` or envelope `from` reads
**any** namespace.

`nats-server`'s default bind is `0.0.0.0`, so plain `brew services start
nats-server` would open exactly that hole. The broker therefore runs from
`/opt/homebrew/etc/nats-server.conf` (`host: 127.0.0.1`) under its own
LaunchAgent rather than the Homebrew service, and the `-c` flag is load-bearing.

**Putting this broker on the LAN is a separate follow-up, and the auth flip
comes FIRST:** set `OPENBRAIN_NATS_REQUIRE_AUTH=true` in the worker env (which
also force-disables the `payload.namespace` override), then change the bind.
Never the other way round.

## Files

- broker config: `/opt/homebrew/etc/nats-server.conf`
- broker plist: `~/Library/LaunchAgents/com.rico.open-brain-nats.plist`
- worker plist: `~/Library/LaunchAgents/com.rico.open-brain-local-nats-worker.plist`
- worker env: `/srv/open-brain-local/local-clone.env.nats-worker` (mode 0600)
- logs: `~/Library/Logs/open-brain-local/nats-worker.{out,err}.log`

The worker env sources `local-clone.env` and then sets only the v1 NATS
overrides (`OPENBRAIN_NATS_URL`, `OPENBRAIN_NATS_ENV=dev`,
`REQUIRE_AUTH=false`, `ALLOW_NAMESPACE_OVERRIDE=true`). It does NOT set
`OPENBRAIN_TRANSPORT` or `OPENBRAIN_NATS_ENABLE_BRIDGE`, because
`readNatsWorkerBoundary()` in `server/application/nats-worker.ts` forces both — the
dedicated-worker boundary cannot be disabled by editing the env file.

> **Env-var plumbing differs from the HTTP service.** The HTTP clone starts
> through `scripts/local-clone.ts`, whose `CHILD_ENV_KEYS` allowlist drops any
> variable not named in it (the #543 `OPENBRAIN_TRACING_*` failure). The NATS
> worker does **not** go through that launcher — the plist sources the env file
> and `exec`s `scripts/run-nats-worker.ts`, which reads `process.env` directly.
> Adding a worker variable means editing the env file only; no allowlist.

## Install or reinstall

The worker plist and its wrapper are rendered from
`docs/deploy/com.rico.open-brain-local-nats-worker.plist.template` and
`docs/deploy/open-brain-local-nats-worker.sh.template` by
`scripts/install-nats-worker-launchagent.sh` (issue 735). Preview first, then
install, then assert liveness. A dry run refuses to start unless
`LAUNCH_AGENTS_DIR` names a staging dir, so a preview never touches the live
plist.

The worker runs through a named exec: the plist's first `ProgramArguments`
entry is `~/.local/libexec/agents/OpenBrainLocalNatsWorker`, which runs the
wrapper so the process shows a readable name. rtech-infra's Claudex named-exec
step (`named-exec.swift`) builds it; the installer only renders it into the
plist (override with `NAMED_EXEC_PATH`), and a real install refuses when it is
missing (Rico ruling 2026-10-05,
issue 1689).

```zsh
DRY_RUN=1 LAUNCH_AGENTS_DIR=<scratch dir> scripts/install-nats-worker-launchagent.sh
scripts/install-nats-worker-launchagent.sh
scripts/install-nats-worker-launchagent.sh --check
```

## Deploy coupling

`scripts/local-clone-deploy.sh` swaps the runtime directory that BOTH services
execute from, so the worker must be restarted or it keeps running the previous
revision. Set the label so the deploy kickstarts it:

```zsh
OPENBRAIN_NATS_WORKER_LABEL=com.rico.open-brain-local-nats-worker \
OPENBRAIN_SERVICE_LABEL=com.rico.open-brain-local-clone \
  scripts/local-clone-deploy.sh
```

The kickstart is non-fatal (a WARN): a clone with no worker installed is
unaffected.

## What `/health` on 3100 does and does NOT show

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
boundary this document exists to keep.

## `embed_watermark` on 3110 (#724 item 3)

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
matches their shape (`server/transport/health.ts`).

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
- `lag_threshold_seconds` reports the threshold the verdict was actually taken
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
(`server/application/embed-watermark-observer.ts`); the `embedWatermarkHealth` option remains
an override for tests, but its absence no longer means "no observer". The live
entrypoint passes only `{ env: process.env }` and gets a real one. The startup
log line reports `embed_watermark_observer_source` as `default_pool_observer`
or `injected`, so which one is in force is visible without reading code.

The watermark is registry-driven, not a hard-coded table: it queries every
`EMBEDDING_TARGETS` entry whose `provenance.hasEmbeddedAt` is true
(`server/embedding/embedding-targets.ts`), which is the same registry the embedding repair
path drives off. `ob_entities` is skipped because it declares
`ENTITY_PROVENANCE` — it has an `embedding` column and no `embedded_at`. Adding
a target to the registry extends the watermark with no change here.

**It is cached, and `/health` never waits on Postgres.** The health handler is
synchronous, so the accessor returns a cached reading and schedules a
background refresh once that reading is older than
`EMBED_WATERMARK_CACHE_TTL_MS` — **30 seconds**, announced at startup as
`embed_watermark_cache_ttl_seconds` beside the threshold. A reading up to 30s
old cannot move a verdict taken against a one-hour threshold, and the cost of
the endpoint is at most one aggregate query per 30s no matter how often it is
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

## Verify

```zsh
launchctl list | rg 'open-brain'
curl -fsS http://127.0.0.1:3110/health
curl -fsS 'http://127.0.0.1:8222/connz?subs=1'
curl -fsS http://127.0.0.1:3100/health    # must stay healthy across a worker restart
launchctl kickstart -k "gui/$(id -u)/com.rico.open-brain-local-nats-worker"
```

## Rollback

Rolling back the NATS worker must not roll back PostgreSQL or the HTTP clone.

```zsh
launchctl bootout "gui/$(id -u)/com.rico.open-brain-local-nats-worker"
curl -fsS http://127.0.0.1:3100/health
```

Preserve logs and JetStream state for inspection unless an explicit cleanup
decision says only minimized metadata exists and the state can be removed.

## Large context packs and `payload_too_large` (#549, #563)

A live request/reply on `dev.ob.memory.context_pack` returns `status: ok` in
~1.2s for `repo_facts` / `working_set` / `pointers`. Before #563, asking for
`durable_memory` in the `rico` namespace built a **58.5 MB** reply (the
`durable_memory` section alone was 39.9 MB), which exceeds the broker's 8 MB
`max_payload`, so the client rejected the publish.

**How the rejection actually surfaces:** the nats.js client THROWS on it. Its
`Msg.respond()` publishes through `protocol.publish()`, which raises
`NatsError(MAX_PAYLOAD_EXCEEDED)` once the encoded length passes
`info.max_payload` (`nats-base-client/msg.js` -> `protocol.js`). It does NOT
return false — `respond()` returns false in exactly one case, a request that
carried no reply inbox at all, which is unrelated to size.

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

**Resolved (#563, operator ruling 2026-08-08, ledger item 23 in
`docs/issue-graph.md`).** A `durable_memory` reply now carries a BURST of
records (`DURABLE_MEMORY_BURST_ITEMS`, 10) plus the `pointers` pool the pack
already builds, and a `next` handle. A caller that wants the whole corpus
replays the request with that handle and receives the rest as further bursts.
This changed delivery, not data: records are still stored whole and returned
whole, and every matching record is retrievable by walking the handle to
completion. A reply the size of ten records fits any broker by construction.

Executable acceptance: the issue 563 check in `scripts/done-means/`.
