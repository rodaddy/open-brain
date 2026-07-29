#!/opt/homebrew/bin/bash
# Autostart wrapper for the local dogfood Open Brain clone.
#
# Dogfood-only. This exists because the clone must survive a reboot while we are
# developing against it; when the work moves to core01 this goes away with the
# clone. It is deliberately NOT the core01 deploy path (com.rico.open-brain) and
# uses its own label so the two can never be confused.
#
# The launcher does not read an env file by design, so this wrapper loads the
# private clone environment, then hands off. It runs the read-only preflight
# first: a failed preflight must stop the launch loudly rather than let launchd
# restart a server attached to the wrong database.
set -euo pipefail

CLONE_ROOT="${OPENBRAIN_LOCAL_CLONE_ROOT:-/Volumes/ThunderBolt/open-brain-local}"
ENV_FILE="${CLONE_ROOT}/local-clone.env"
REPO_DIR="${OPENBRAIN_REPO_DIR:-/Volumes/ThunderBolt/Development/open-brain}"
BUN_BIN="${BUN_BIN:-/opt/homebrew/bin/bun}"

log() { printf '%s local-clone-autostart: %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$1"; }

# The clone lives on an external volume. After a reboot launchd can start before
# the volume mounts, so wait rather than fail into a restart loop.
for _ in $(seq 1 60); do
  [[ -f "${ENV_FILE}" ]] && break
  log "waiting for ${ENV_FILE}"
  sleep 5
done

if [[ ! -f "${ENV_FILE}" ]]; then
  log "FATAL: ${ENV_FILE} not found after 5 minutes; volume never mounted"
  exit 1
fi

# GNU coreutils may shadow BSD stat on this box, and the two disagree on -f.
# Ask for the BSD binary explicitly so the mode check cannot silently break.
mode="$(/usr/bin/stat -f '%Lp' "${ENV_FILE}")"
if [[ "${mode}" != "600" ]]; then
  log "FATAL: ${ENV_FILE} is mode ${mode}, expected 600"
  exit 1
fi

set -a
# shellcheck disable=SC1090
source "${ENV_FILE}"
set +a

if [[ "${OPENBRAIN_LOCAL_CLONE:-0}" != "1" ]]; then
  log "FATAL: OPENBRAIN_LOCAL_CLONE is not 1; refusing to start a non-clone"
  exit 1
fi

cd "${REPO_DIR}"

# Read-only preflight. Proves database identity, Postgres 18, pgvector, and a
# healthy embedding provider before any server process starts.
log "running preflight"
if ! "${BUN_BIN}" run scripts/local-clone.ts --verify; then
  log "FATAL: preflight failed; not starting"
  exit 1
fi

log "preflight verified, starting launcher"
exec "${BUN_BIN}" run scripts/local-clone.ts --start
