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
OPENBRAIN_NATS_CONTEXT_PACK_SUBJECT=ob.memory.context_pack
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

- automated bridge tests for successful `ob.memory.context_pack` request/reply,
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
The expected response envelope is:

```json
{
  "schema": "openbrain.nats.response.v1",
  "status": "ok"
}
```

Expected error responses use the same response schema with `status: "error"`:

```json
{
  "schema": "openbrain.nats.response.v1",
  "request_id": "uuid-or-null",
  "status": "error",
  "operation": "agent_context_pack",
  "error": {
    "code": "permission_denied|bad_request|payload_too_large|temporarily_unavailable|tool_error|internal_error",
    "message": "redacted failure summary"
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
