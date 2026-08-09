#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="${REPO_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
RUNTIME_DIR="${RUNTIME_DIR:-/Volumes/ThunderBolt/open-brain/app}"
ENV_FILE="${ENV_FILE:-/Users/rico/.config/open-brain/env}"
SERVICE_LABEL="${SERVICE_LABEL:-gui/$(id -u)/com.rico.open-brain}"
NATS_WORKER_LABEL="${NATS_WORKER_LABEL:-gui/$(id -u)/com.rico.open-brain-nats-worker}"
QMD_PATH_VALUE="${QMD_PATH_VALUE:-/Volumes/ThunderBolt/qmd/open-brain-qmd.ts}"
BUN_BIN="${BUN_BIN:-}"
STAGING_DIR="${STAGING_DIR:-${RUNTIME_DIR}.next}"
PREVIOUS_DIR="${PREVIOUS_DIR:-${RUNTIME_DIR}.previous}"

cleanup_previous_dir() {
  local phase="$1"

  if [[ ! -e "$PREVIOUS_DIR" ]]; then
    return 0
  fi

  if rm -rf "$PREVIOUS_DIR"; then
    return 0
  fi

  if [[ "$phase" == "post-health" ]]; then
    echo "WARN: deployed successfully but could not remove rollback dir: $PREVIOUS_DIR" >&2
    return 0
  fi

  echo "FATAL: could not remove stale rollback dir before deploy: $PREVIOUS_DIR" >&2
  return 1
}

# Pre-mutation deploy ref gate. Provider-neutral: supports GitHub Actions and a
# future Forgejo Actions repository-scoped runner. Provider/event/ref come from
# explicit DEPLOY_* inputs, falling back to GitHub Actions env for backward
# compatibility. The ALLOW/REFUSE decision itself lives in the unit-tested
# scripts/deploy-ref-gate.ts so it can be exercised without touching git, env
# loading, launchctl, runtime dirs, or production state.
#
# Fail closed: inside CI (any supported provider) a missing/unsupported/stale
# trigger refuses the deploy. Outside CI the gate is a no-op, preserving the
# prior operator-run behavior.
verify_deploy_ref() {
  local bun_bin="$1"

  # Detect CI. Explicit DEPLOY_PROVIDER wins; otherwise fall back to the
  # provider-native "actions" flags. Outside CI, skip the gate entirely.
  if [[ -z "${DEPLOY_PROVIDER:-}" \
        && "${GITHUB_ACTIONS:-}" != "true" \
        && "${FORGEJO_ACTIONS:-}" != "true" ]]; then
    return 0
  fi

  # Gather git facts here (preserving the exact fetch/rev-parse/merge-base
  # behavior) and hand the decision to the TS gate.
  local head_sha main_sha reachable="false"
  git -C "$REPO_DIR" fetch --no-tags origin main:refs/remotes/origin/main
  head_sha="$(git -C "$REPO_DIR" rev-parse HEAD)"
  main_sha="$(git -C "$REPO_DIR" rev-parse origin/main)"
  if git -C "$REPO_DIR" merge-base --is-ancestor "$head_sha" origin/main; then
    reachable="true"
  fi

  DEPLOY_HEAD_SHA="$head_sha" \
  DEPLOY_MAIN_SHA="$main_sha" \
  DEPLOY_HEAD_REACHABLE_FROM_MAIN="$reachable" \
    "$bun_bin" run "$REPO_DIR/scripts/deploy-ref-gate.ts"
}

wait_for_health() {
  local label="$1"

  for _ in 1 2 3 4 5 6 7 8 9 10; do
    if curl -fsS --max-time 5 http://127.0.0.1:3100/health >/dev/null 2>&1; then
      echo "$label health check passed"
      return 0
    fi
    sleep 2
  done

  return 1
}

if [[ -z "$BUN_BIN" ]]; then
  if [[ -x "/Users/rico/Library/Application Support/reflex/bun/bin/bun" ]]; then
    BUN_BIN="/Users/rico/Library/Application Support/reflex/bun/bin/bun"
  elif command -v bun >/dev/null 2>&1; then
    BUN_BIN="$(command -v bun)"
  else
    echo "FATAL: bun not found" >&2
    exit 1
  fi
fi

# Ref gate runs before ANY mutation (env load, staging, tar, migrate, swap).
# It needs bun to run the unit-tested decision module, so it follows bun
# resolution but precedes every side effect below.
verify_deploy_ref "$BUN_BIN"

if [[ ! -d "/Volumes/ThunderBolt" ]]; then
  echo "FATAL: /Volumes/ThunderBolt is not mounted" >&2
  exit 1
fi

if [[ ! -r "$ENV_FILE" ]]; then
  echo "FATAL: env file missing: $ENV_FILE" >&2
  exit 1
fi

set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a

# Deploy/backup mutual exclusion (#677, cutover blocker B4). Taken HERE:
# after the env file is sourced (the lock helper needs DB_* to connect) and
# BEFORE the first mutation of staging, migrate, or the runtime swap. A lock
# acquired after `bun run migrate` would protect nothing while reading
# identically in a diff, which is why the done-means check asserts this
# ordering by line number rather than by presence.
#
# The lock is HELD BY A CHILD PROCESS for the rest of this script. It is a
# session-scoped Postgres advisory lock, so if this deploy dies at any point
# the child dies with it and the lock is released — there is no stale-lock
# file to clean up and no path where a crashed deploy wedges backups.
DEPLOY_LOCK_PID=""
release_deploy_lock() {
  if [[ -n "$DEPLOY_LOCK_PID" ]]; then
    kill "$DEPLOY_LOCK_PID" 2>/dev/null || true
    wait "$DEPLOY_LOCK_PID" 2>/dev/null || true
    DEPLOY_LOCK_PID=""
  fi
}
trap release_deploy_lock EXIT

# Ready-file lives beside the runtime, never in /tmp or $TMPDIR: those are
# process- and sandbox-local, so a runner and the host see different ones
# (AGENTS.md hard rule). This path is deterministic and inspectable after a
# failed deploy, which is when its contents matter most.
DEPLOY_LOCK_STATE_DIR="${DEPLOY_LOCK_STATE_DIR:-$(dirname "$RUNTIME_DIR")/deploy-state}"
if ! mkdir -p "$DEPLOY_LOCK_STATE_DIR"; then
  echo "FATAL: could not create the deploy-lock state dir: $DEPLOY_LOCK_STATE_DIR" >&2
  exit 1
fi
DEPLOY_LOCK_READY_FILE="$DEPLOY_LOCK_STATE_DIR/deploy-lock.$$.log"
: > "$DEPLOY_LOCK_READY_FILE"

"$BUN_BIN" run "$REPO_DIR/scripts/deploy-lock.ts" --hold > "$DEPLOY_LOCK_READY_FILE" 2>&1 &
DEPLOY_LOCK_PID=$!

# Wait for the child to report READY. A deploy that proceeded without
# confirming the lock is held would be a guard in name only.
deploy_lock_ready=0
for _ in $(seq 1 60); do
  if grep -q '^READY$' "$DEPLOY_LOCK_READY_FILE" 2>/dev/null; then
    deploy_lock_ready=1
    break
  fi
  if ! kill -0 "$DEPLOY_LOCK_PID" 2>/dev/null; then
    break
  fi
  sleep 1
done

if [[ "$deploy_lock_ready" -ne 1 ]]; then
  echo "FATAL: could not acquire the openbrain-deploy lock before deploying." >&2
  echo "A backup may be in flight; retry once it completes. Detail:" >&2
  cat "$DEPLOY_LOCK_READY_FILE" >&2 || true
  exit 1
fi
echo "openbrain-deploy lock held for the duration of this deploy"

rm -rf "$STAGING_DIR"
cleanup_previous_dir pre-deploy
mkdir -p "$STAGING_DIR"

"$REPO_DIR/scripts/core01-package-runtime.sh" "$REPO_DIR" "$STAGING_DIR"

"$BUN_BIN" install --cwd "$STAGING_DIR" --frozen-lockfile

if [[ -x "$STAGING_DIR/scripts/core01-qmd-bootstrap.sh" ]]; then
  "$STAGING_DIR/scripts/core01-qmd-bootstrap.sh"
fi

if grep -q "^QMD_PATH=" "$ENV_FILE"; then
  perl -pi -e "s#^QMD_PATH=.*#QMD_PATH=$QMD_PATH_VALUE#" "$ENV_FILE"
else
  printf '\nQMD_PATH=%s\n' "$QMD_PATH_VALUE" >> "$ENV_FILE"
fi

cd "$STAGING_DIR"
"$BUN_BIN" run migrate

if [[ -d "$RUNTIME_DIR" ]]; then
  mv "$RUNTIME_DIR" "$PREVIOUS_DIR"
fi
mv "$STAGING_DIR" "$RUNTIME_DIR"

launchctl kickstart -k "$SERVICE_LABEL"
if ! launchctl kickstart -k "$NATS_WORKER_LABEL"; then
  echo "WARN: could not restart Open Brain NATS worker: $NATS_WORKER_LABEL" >&2
fi

if wait_for_health "Open Brain"; then
  "$BUN_BIN" test src/tools/__tests__/search-all.test.ts
  cleanup_previous_dir post-health
  exit 0
fi

if [[ -d "$PREVIOUS_DIR" ]]; then
  rm -rf "$RUNTIME_DIR"
  mv "$PREVIOUS_DIR" "$RUNTIME_DIR"
  launchctl kickstart -k "$SERVICE_LABEL"
  if ! launchctl kickstart -k "$NATS_WORKER_LABEL"; then
    echo "WARN: could not restart Open Brain NATS worker after rollback: $NATS_WORKER_LABEL" >&2
  fi

  if wait_for_health "Open Brain rollback"; then
    echo "FATAL: Open Brain health check failed after deploy; previous runtime restored and passed health" >&2
    exit 1
  fi

  echo "FATAL: Open Brain health check failed after deploy; rollback was attempted but health did not recover" >&2
  exit 1
fi

echo "FATAL: Open Brain health check failed after restart" >&2
exit 1
