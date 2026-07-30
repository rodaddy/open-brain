#!/opt/homebrew/bin/bash
# Deploy a COMMITTED revision of this repo into a local dogfood runtime.
#
# Why this exists: until 2026-07-30 the local dogfood service ran `bun run
# src/index.ts` with cwd set to the DEV CHECKOUT (verified live: pid 79427,
# cwd=/Volumes/ThunderBolt/Development/open-brain). Every uncommitted edit was
# one restart away from being the running memory service. This script puts a
# commit boundary between editing and running.
#
# Differences from scripts/core01-deploy-local.sh, which this mirrors:
#
#   1. NO ORIGIN GATE. core01 requires HEAD to be an ancestor of origin/main
#      because it is production. This is a local dogfood clone, so any local
#      commit is deployable and nothing touches the network.
#
#   2. `git archive`, NOT `tar` of the working tree. core01 tars $REPO_DIR
#      directly, which copies uncommitted edits along with everything else.
#      `git archive` reads git object storage, so the working tree is
#      structurally invisible. Proven 2026-07-30: appending a line to
#      src/index.ts and re-exporting HEAD produced an archive with zero
#      occurrences of it.
#
# Everything else -- staging dir, atomic swap, .previous rollback, health
# check -- is the core01 shape, deliberately.
#
# Usage:
#   scripts/local-clone-deploy.sh                 # deploy HEAD
#   scripts/local-clone-deploy.sh <ref>           # deploy any committed ref
#   scripts/local-clone-deploy.sh --rollback      # restore the previous runtime
#
# Environment:
#   OPENBRAIN_LOCAL_CLONE_ROOT  clone root (default /Volumes/ThunderBolt/open-brain-local)
#   OPENBRAIN_RUNTIME_NAME      runtime dir name under the root (default "app")
#   OPENBRAIN_CLONE_ENV_FILE    env file to migrate against (default <root>/local-clone.env)
#   OPENBRAIN_SERVICE_LABEL     launchd label to restart, if any
set -euo pipefail

REPO_DIR="${OPENBRAIN_REPO_DIR:-/Volumes/ThunderBolt/Development/open-brain}"
CLONE_ROOT="${OPENBRAIN_LOCAL_CLONE_ROOT:-/Volumes/ThunderBolt/open-brain-local}"
RUNTIME_NAME="${OPENBRAIN_RUNTIME_NAME:-app}"
RUNTIME_DIR="${CLONE_ROOT}/${RUNTIME_NAME}"
STAGING_DIR="${RUNTIME_DIR}.next"
PREVIOUS_DIR="${RUNTIME_DIR}.previous"
ENV_FILE="${OPENBRAIN_CLONE_ENV_FILE:-${CLONE_ROOT}/local-clone.env}"
SERVICE_LABEL="${OPENBRAIN_SERVICE_LABEL:-}"
BUN_BIN="${BUN_BIN:-/opt/homebrew/bin/bun}"

log() { printf '%s local-clone-deploy: %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$1"; }
fatal() { printf 'FATAL: %s\n' "$1" >&2; exit 1; }

restart_service() {
  [[ -n "$SERVICE_LABEL" ]] || { log "no service label set; not restarting"; return 0; }
  log "restarting ${SERVICE_LABEL}"
  launchctl kickstart -k "$SERVICE_LABEL" || log "WARN: could not restart ${SERVICE_LABEL}"
}

# Health is checked against the port the CLONE env declares, not a hardcoded
# 3100. A playground runtime on another port must not be validated by probing
# the live service and finding it healthy -- that would report success for a
# deploy that never started.
wait_for_health() {
  local port="$1" label="$2"
  for _ in $(seq 1 15); do
    if curl -fsS --max-time 5 "http://127.0.0.1:${port}/health" >/dev/null 2>&1; then
      log "${label} health check passed on port ${port}"
      return 0
    fi
    sleep 2
  done
  return 1
}

if [[ "${1:-}" == "--rollback" ]]; then
  [[ -d "$PREVIOUS_DIR" ]] || fatal "no previous runtime at ${PREVIOUS_DIR}"
  log "rolling back to ${PREVIOUS_DIR}"
  rm -rf "${RUNTIME_DIR}.rollback-discard"
  [[ -d "$RUNTIME_DIR" ]] && mv "$RUNTIME_DIR" "${RUNTIME_DIR}.rollback-discard"
  mv "$PREVIOUS_DIR" "$RUNTIME_DIR"
  restart_service
  log "rollback complete; discarded runtime kept at ${RUNTIME_DIR}.rollback-discard"
  exit 0
fi

REF="${1:-HEAD}"

[[ -d "/Volumes/ThunderBolt" ]] || fatal "/Volumes/ThunderBolt is not mounted"
[[ -d "$REPO_DIR/.git" ]] || fatal "not a git repository: ${REPO_DIR}"
[[ -r "$ENV_FILE" ]] || fatal "env file missing or unreadable: ${ENV_FILE}"
[[ -x "$BUN_BIN" ]] || fatal "bun not found at ${BUN_BIN}"

# Resolve the ref to a concrete commit BEFORE anything mutates. An unknown ref
# has to fail here, not halfway through a swap.
SHA="$(git -C "$REPO_DIR" rev-parse --verify "${REF}^{commit}" 2>/dev/null)" \
  || fatal "not a commit: ${REF}"
SHORT_SHA="$(git -C "$REPO_DIR" rev-parse --short "$SHA")"
SUBJECT="$(git -C "$REPO_DIR" log -1 --format=%s "$SHA")"

log "deploying ${SHORT_SHA} (${REF}) -- ${SUBJECT}"
log "runtime: ${RUNTIME_DIR}"

# Report uncommitted work rather than silently ignoring it. It is CORRECT that
# it will not ship -- that is the whole point -- but an operator who edited a
# file and expected it to deploy needs to be told, not left to discover it.
if ! git -C "$REPO_DIR" diff --quiet HEAD 2>/dev/null; then
  dirty_count="$(git -C "$REPO_DIR" status --porcelain | wc -l | tr -d ' ')"
  log "NOTE: ${dirty_count} uncommitted path(s) in the working tree; they are NOT deployed"
fi

set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a

CLONE_PORT="${PORT:-3100}"

rm -rf "$STAGING_DIR"
mkdir -p "$STAGING_DIR"

# The commit, not the working tree. .env and other gitignored files are absent
# from git objects and therefore cannot travel; the runtime uses ENV_FILE.
log "exporting ${SHORT_SHA} to ${STAGING_DIR}"
git -C "$REPO_DIR" archive "$SHA" | tar -x -C "$STAGING_DIR"

# Stamp the deployed revision so the runtime can be identified without guessing
# from file mtimes. Plain key=value, not JSON: the commit subject is arbitrary
# text and hand-escaping it into JSON from shell is a bug waiting to happen.
cat > "${STAGING_DIR}/.deployed-revision" <<EOF
sha=${SHA}
short_sha=${SHORT_SHA}
ref=${REF}
deployed_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
repo=${REPO_DIR}
subject=${SUBJECT}
EOF

log "installing dependencies"
"$BUN_BIN" install --cwd "$STAGING_DIR" --frozen-lockfile

log "running migrations against ${DB_NAME:-<unset>}"
(cd "$STAGING_DIR" && "$BUN_BIN" run migrate)

rm -rf "$PREVIOUS_DIR"
if [[ -d "$RUNTIME_DIR" ]]; then
  mv "$RUNTIME_DIR" "$PREVIOUS_DIR"
fi
mv "$STAGING_DIR" "$RUNTIME_DIR"
log "swapped ${SHORT_SHA} into ${RUNTIME_DIR}"

restart_service

if [[ -n "$SERVICE_LABEL" ]]; then
  if ! wait_for_health "$CLONE_PORT" "post-deploy"; then
    log "health check FAILED; rolling back"
    if [[ -d "$PREVIOUS_DIR" ]]; then
      rm -rf "${RUNTIME_DIR}.failed"
      mv "$RUNTIME_DIR" "${RUNTIME_DIR}.failed"
      mv "$PREVIOUS_DIR" "$RUNTIME_DIR"
      restart_service
      wait_for_health "$CLONE_PORT" "post-rollback" \
        || fatal "health check failed after rollback; service is down"
      fatal "deploy of ${SHORT_SHA} failed health check and was rolled back"
    fi
    fatal "deploy of ${SHORT_SHA} failed health check and there was no previous runtime"
  fi
fi

log "deployed ${SHORT_SHA} to ${RUNTIME_DIR}"
