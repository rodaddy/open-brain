# Core01 Dedicated NATS Worker Runbook

Issue: #282.
Status: runtime entrypoint and launchd shape exist; install only from a release
that has passed the validation gate below.

## Boundary

The NATS bridge must run as a separate launchd service from the HTTP workers.
HTTP workers stay in `OPENBRAIN_TRANSPORT=http` mode and keep serving `/health`
on `3100`, `3101`, and `3102`. The NATS worker subscribes to
`ob.memory.context_pack` and may fail or restart without taking HTTP health down.

The broker and worker are separate services:

| Component | Launchd label | Responsibility |
| --- | --- | --- |
| HTTP Open Brain | `com.rico.open-brain` | HTTP/MCP entrypoint and two HTTP workers. |
| NATS broker | `com.rico.open-brain-nats` | Local NATS/JetStream server on `127.0.0.1:4222`. |
| NATS Open Brain worker | `com.rico.open-brain-nats-worker` | Request/reply bridge for `ob.memory.context_pack`. |

Do not put the NATS subscription path back into the HTTP launchd service. Broker
restart, subscription failure, malformed NATS envelopes, or worker crash loops
must be visible in NATS worker logs without degrading HTTP `/health`.

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

The worker env should source or duplicate only the production settings required
to execute Open Brain authority paths. Keep secrets in the env file or approved
secret store; do not commit them.

Minimum worker-specific values:

```zsh
OPENBRAIN_TRANSPORT=nats
OPENBRAIN_NATS_ENABLE_BRIDGE=true
OPENBRAIN_NATS_URL=nats://127.0.0.1:4222
OPENBRAIN_NATS_CONTEXT_PACK_SUBJECT=ob.memory.context_pack
OPENBRAIN_NATS_FALLBACK_HTTP=true
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
and tests for:

- successful `ob.memory.context_pack` request/reply;
- missing or invalid bearer auth;
- malformed NATS envelope;
- broker unavailable behavior;
- HTTP health staying healthy while the NATS worker starts, stops, and restarts.

If the entrypoint does not exist, stop at documentation and report that runtime
work is still required. Do not patch around it in launchd with the HTTP server
entrypoint.

## Install Or Update

Run these commands on core01 after the release gate in
`docs/local-release-deploy-sop.md` has passed and the runtime app is staged at
`/Volumes/ThunderBolt/open-brain/app`:

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

For updates after the service is already bootstrapped:

```zsh
sudo cp \
  /Volumes/ThunderBolt/open-brain/app/docs/deploy/com.rico.open-brain-nats-worker.plist.template \
  /Library/LaunchDaemons/com.rico.open-brain-nats-worker.plist
sudo chown root:wheel /Library/LaunchDaemons/com.rico.open-brain-nats-worker.plist
sudo chmod 0644 /Library/LaunchDaemons/com.rico.open-brain-nats-worker.plist
sudo launchctl kickstart -k system/com.rico.open-brain-nats-worker
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
The expected response envelope is:

```json
{
  "schema": "openbrain.nats.response.v1",
  "status": "ok"
}
```

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
