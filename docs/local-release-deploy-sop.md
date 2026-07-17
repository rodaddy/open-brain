# Local Release And Core01 Deploy SOP

This SOP is the release gate between "PRs are green" and "core01 is updated".
It exists so PRs can be merged without automatically restarting production, then
a versioned release candidate can be tested locally on this box and deployed
deliberately.

## Policy

- Merging to `main` is not a deploy signal.
- Production deploy is allowed only from:
  - a manual CI workflow dispatch from the current `origin/main` tip with
    `deploy_core01=true`; or
  - a pushed version tag matching `v*` whose target commit is reachable from
    `origin/main`.
- Never use production secrets in command logs, PR bodies, issues, or reports.
  Evidence may name env vars and commands only.
- Use a clean release-candidate worktree under
  `/Volumes/ThunderBolt/_tmp/open-brain/...`; do not test from a dirty
  development checkout.
- A release is not ready for core01 until the local runtime smoke, full test
  suite, Python package checks, and downstream-rollout classification are
  recorded in the release PR or release notes.

## Inputs

- A clean `main` containing the PR batch intended for release.
- A version string, for example `v0.1.1-rc.1` or `v0.1.1`.
- A local test env file outside the repo, for example
  `/Users/rico/.config/open-brain/env.release-test`.
- A local/test Postgres database with pgvector installed.
- The local embedding provider, when the release needs embedded-write proof.

The env file must provide test values only:

```zsh
PORT=13100
DB_HOST=127.0.0.1
DB_PORT=5432
DB_NAME=open_brain_release_test
DB_USER=open_brain_release
DB_PASSWORD=...
OPENBRAIN_TEST_DATABASE_URL=postgres://open_brain_release:PASSWORD@127.0.0.1:5432/open_brain_release_test
AUTH_TOKEN_ADMIN=...
AUTH_TOKEN_AGENT=...
AUTH_TOKEN_READONLY=...
EMBEDDING_BASE_URL=http://127.0.0.1:8791/v1
EMBEDDING_MODEL=embeddinggemma-300m-8bit
EMBEDDING_DIMENSIONS=768
OPEN_BRAIN_SERVER_IP=127.0.0.1
OPEN_BRAIN_RUN_MIGRATIONS=1
```

Do not commit this file or paste its values anywhere.

## Build The Release Candidate

Use a clean temp worktree:

```zsh
mkdir -p /Volumes/ThunderBolt/_tmp/open-brain/_archive
git fetch origin main --tags
git worktree add /Volumes/ThunderBolt/_tmp/open-brain/release-v0.1.1-rc.1 origin/main
cd /Volumes/ThunderBolt/_tmp/open-brain/release-v0.1.1-rc.1
git status --short --branch
```

The status must be clean before testing.

## Full Local Test Gate

Run the repository checks from the release candidate worktree:

```zsh
set -a
source /Users/rico/.config/open-brain/env.release-test
set +a
: "${OPENBRAIN_TEST_DATABASE_URL:?env.release-test must set OPENBRAIN_TEST_DATABASE_URL}"
bun install --frozen-lockfile
bunx tsc --noEmit
bun test
```

Run the Python package checks:

```zsh
cd python/openbrain-memory
uv run mypy src/openbrain_memory
uv run ruff check src tests
uv run pytest -q
uv build
```

For package changes, install the built wheel into a temp venv under
`/Volumes/ThunderBolt/_tmp/open-brain/...` and run an import/API smoke. Record
the venv path and command output summary, not secrets.

## Local Runtime Smoke

Start a local test instance on the non-production port:

```zsh
cd /Volumes/ThunderBolt/_tmp/open-brain/release-v0.1.1-rc.1
set -a
source /Users/rico/.config/open-brain/env.release-test
set +a
bun run src/index.ts
```

In another shell, verify health:

```zsh
curl -fsS http://127.0.0.1:13100/health
```

Expected result:

- HTTP 200 and `status: "healthy"` when DB is reachable.
- `embedding.configured: true`.
- `embedding.connected: true` when embedded-write proof is required.

Run a REST write/read smoke with the test admin token:

Run these commands only on the local single-user test box. On shared hosts, use a
temporary curl config/header file with mode `0600` so bearer tokens do not appear
in process arguments.

```zsh
curl -fsS \
  -H "Authorization: Bearer $AUTH_TOKEN_ADMIN" \
  -H "Content-Type: application/json" \
  -d '{"content":"release candidate smoke thought","tags":["release-smoke"]}' \
  http://127.0.0.1:13100/api/v1/thoughts

curl -fsS \
  -H "Authorization: Bearer $AUTH_TOKEN_ADMIN" \
  "http://127.0.0.1:13100/api/v1/search?q=release%20candidate%20smoke&limit=5"
```

Run at least one MCP-backed smoke through the client path that will consume the
release. If using `mcp2cli`, point it at the local test server/config and verify
a representative read and write. Use an isolated temp home/cache for this check;
do not mutate the operator's real mcp2cli config as a fixture.

Stop the local process with `Ctrl-C` after the smoke passes.

## Downstream Rollout Classification

Before tagging, classify the release using `docs/downstream-rollout.md`:

- If the merged PRs changed MCP schemas, transport, auth/namespace behavior,
  Python client exports, generated skills, or agent-facing contracts, complete
  or explicitly defer the applicable downstream steps.
- If none apply, say so in the release notes.

Do not treat local runtime health alone as downstream completion.

## Create The Version

After the full local gate passes:

```zsh
test -z "$(git status --short)" || {
  git status --short --branch
  echo "release candidate worktree must be clean before tagging"
  exit 1
}
git fetch origin main --tags
test "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)" || {
  echo "HEAD must equal the current origin/main tip before tagging"
  exit 1
}
git tag -a v0.1.1-rc.1 -m "Open Brain v0.1.1-rc.1"
git push origin v0.1.1-rc.1
```

Pushing a `v*` tag runs CI and, once CI passes, the deploy job is eligible to
run on core01 only if the tagged commit is reachable from `origin/main`. Watch
the workflow. Do not leave a tag deploy unattended. Do not move or reuse a
published `v*` tag after the local gate; cut a new version tag if the release
candidate changes.

For a manual deploy instead of a tag deploy, run the CI workflow from GitHub
Actions on `main` with `deploy_core01=true` after the exact current `origin/main`
tip passed the local gate. The deploy script refuses stale manual-dispatch
commits that are only ancestors of `origin/main`.

## Core01 Deploy Verification

The workflow's deploy script proves only the primary loopback
`http://127.0.0.1:3100/health` endpoint, then runs
`bun test src/tools/__tests__/search-all.test.ts`. That test is local regression
coverage, not a live MCP or changed-tool canary. The operator verification below
is therefore a separate required post-workflow gate, not a duplicate of what CI
already proved.

After the deploy workflow finishes:

```zsh
curl -fsS http://127.0.0.1:3100/health
curl -fsS http://127.0.0.1:3101/health
curl -fsS http://127.0.0.1:3102/health
curl -fsS https://open-brain.rodaddy.live/health
```

Also verify from the normal client path:

```zsh
mcp2cli open-brain search_all --params '{"query":"release smoke"}'
```

For contract-changing releases, complete the downstream steps in
`docs/downstream-rollout.md` before closing linked issues.

For releases that enable the dedicated NATS worker from issue #282, also follow
`docs/core01-nats-worker-runbook.md`. The release is not complete until HTTP
health is recorded before and after `com.rico.open-brain-nats-worker` restart,
and a hosted NATS request/reply smoke returns a fleet `context_pack_response`
envelope (`kind="context_pack_response"`, `from="open-brain"`, `correlation_id`
echoing the request `id`) — see the runbook's Verification section and
`docs/fleet-nats-integration.md` for the authoritative shape. If the release does
not include the NATS worker runtime entrypoint, leave the launchd template
uninstalled and record the worker rollout as deferred.

## Rollback

The deploy script keeps the prior runtime at:

```text
/Volumes/ThunderBolt/open-brain/app.previous
```

If post-deploy health fails, the script restores the prior runtime, restarts
launchd, and runs the same local health loop against the restored runtime. If
rollback health also fails, treat core01 as degraded and stop issue closure until
the service is manually recovered. If a later manual rollback is needed, use the
same runtime directories and restart `com.rico.open-brain`; record the rollback
in the release notes and do not continue closing issues until the release is
reconciled.

## Release Evidence Template

Use this in the release PR, tag notes, or final rollout comment:

```text
Release:
- Version:
- Commit:
- PRs included:
- Local full suite:
- Python package checks:
- Local runtime port:
- Health result:
- REST smoke:
- MCP/client smoke:
- Downstream rollout classification:
- Deploy trigger:
- Core01 health:
- Residual risk:
```
