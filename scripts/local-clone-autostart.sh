#!/opt/homebrew/bin/bash
# Autostart wrapper for the local dogfood Open Brain clone.
#
# This launches the real Open Brain on the Mini, surviving a reboot, until the
# k3s move (epic 762), under its own launchd label
# (com.rico.open-brain-local-clone).
#
# The launcher does not read an env file by design, so this wrapper loads the
# private clone environment, then hands off. It runs the read-only preflight
# first: a failed preflight must stop the launch loudly rather than let launchd
# restart a server attached to the wrong database.
set -euo pipefail

CLONE_ROOT="${OPENBRAIN_LOCAL_CLONE_ROOT:-/srv/open-brain-local}"
ENV_FILE="${CLONE_ROOT}/local-clone.env"
NODE_BIN="${NODE_BIN:-/opt/homebrew/opt/node@24/bin/node}"

# The DEPLOYED runtime, not the dev checkout.
#
# Until 2026-07-30 this was REPO_DIR=/srv/dev/open-brain,
# and `cd "${REPO_DIR}"` below meant the clone served whatever was in the working
# tree at restart time -- verified live: pid 79427 ran `bun run src/index.ts`
# with cwd set to the dev checkout. Every uncommitted edit was one restart away
# from being the running memory service.
#
# scripts/local-clone-deploy.sh populates this directory from a COMMITTED
# revision via `git archive`, so what runs here is always something that exists
# in git history. Editing the checkout can no longer change the running service.
RUNTIME_DIR="${OPENBRAIN_RUNTIME_DIR:-${CLONE_ROOT}/app}"

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

# GNU coreutils and BSD stat use different format flags. Preserve the explicit
# BSD binary on Darwin; Linux CI uses its native GNU stat spelling.
case "$(uname -s)" in
  Darwin) mode="$(/usr/bin/stat -f '%Lp' "${ENV_FILE}")" ;;
  *) mode="$(stat -c '%a' "${ENV_FILE}")" ;;
esac
if [[ "${mode}" != "600" ]]; then
  log "FATAL: ${ENV_FILE} is mode ${mode}, expected 600"
  exit 1
fi

set -a
# shellcheck disable=SC1090
source "${ENV_FILE}"
set +a

# The server child's output goes through the app's rotating file sink into
# this directory (1 MB per file, 3 rolled files; issues 1526 and 754), not
# through launchd's unbounded StandardOutPath/StandardErrorPath redirect. Same
# directory and file names the LaunchAgent uses, so operators look where they
# always have. This wrapper's and the launcher's own few lines stay on launchd.
export OPENBRAIN_LOCAL_CLONE_LOG_DIR="${OPENBRAIN_LOCAL_CLONE_LOG_DIR:-${HOME}/Library/Logs/open-brain-local}"

if [[ -n "${BUN_BIN:-}" ]]; then
  log "NOTE: BUN_BIN is retired and ignored; NODE_BIN selects the runtime"
fi
[[ -x "$NODE_BIN" ]] || { log "FATAL: node not found at ${NODE_BIN}"; exit 1; }
log "runtime: node=${NODE_BIN}"

if [[ "${OPENBRAIN_LOCAL_CLONE:-0}" != "1" ]]; then
  log "FATAL: OPENBRAIN_LOCAL_CLONE is not 1; refusing to start a non-clone"
  exit 1
fi

# Prove the deployed tree actually contains what will be started. This checks
# server/main.ts because the Phase 6 cutover made it the serving entrypoint
# (scripts/local-clone.ts SERVING_ENTRYPOINT); checking src/index.ts would now
# pass against a deploy that predates the rewrite and then fail inside bun.
if [[ ! -f "${RUNTIME_DIR}/server/main.ts" ]]; then
  log "FATAL: no deployed runtime at ${RUNTIME_DIR} (server/main.ts missing)"
  log "deploy one first: scripts/local-clone-deploy.sh [<ref>]"
  exit 1
fi

cd "${RUNTIME_DIR}"

# Shell builtins only: launchd runs with a minimal PATH, and a log line is not
# worth a hard dependency that could fail the service at boot.
if [[ -r "${RUNTIME_DIR}/.deployed-revision" ]]; then
  deployed_sha=""
  while IFS='=' read -r key value; do
    [[ "$key" == "short_sha" ]] && deployed_sha="$value"
  done < "${RUNTIME_DIR}/.deployed-revision"
  log "serving ${deployed_sha:-unknown} from ${RUNTIME_DIR}"
else
  log "WARN: ${RUNTIME_DIR} carries no .deployed-revision stamp"
fi

# Read-only preflight. Proves database identity, Postgres 18, pgvector, and a
# healthy embedding provider before any server process starts.
log "running preflight"
if ! "${NODE_BIN}" scripts/local-clone.ts --verify; then
  log "FATAL: preflight failed; not starting"
  exit 1
fi

log "preflight verified, starting launcher"

# OPENBRAIN_DEVELOPMENT_ROOT and OPENBRAIN_TEMP_WORKSPACE come from the global
# launchd user environment that Development agent tooling sets for every
# process. No server code reads them (issue 755 ruling 2026-09-26); unset them
# here so the launcher's dropped-key report stays meaningful.
unset OPENBRAIN_DEVELOPMENT_ROOT OPENBRAIN_TEMP_WORKSPACE

# Hand off to the launcher as a CHILD of this shell, not via exec.
#
# Why (measured 2026-08-25, #757): macOS Local Network privacy attributes the
# LAN grant to the launchd job's MAIN process. With `exec`, bun became that
# process and its fetch to the fleet embedder (10.0.1.11) was refused with
# "Was there a typo in the url or port?", while the same fetch from a bun child
# of this bash succeeded. That is exactly why the --verify preflight above
# passed under launchd and --start then died on "embedding preflight failed"
# every 30 seconds. Keeping bash as the main process keeps the grant. TERM and
# INT are forwarded so `launchctl kickstart -k` still stops the launcher, which
# in turn stops its server child.
"${NODE_BIN}" scripts/local-clone.ts --start &
launcher_pid=$!
forward_signal() { kill -s "$1" "${launcher_pid}" 2>/dev/null || true; }
trap 'forward_signal TERM' TERM
trap 'forward_signal INT' INT
# The only observable point after the traps exist: a TERM sent before this
# line kills this shell outright instead of reaching the launcher (issue 1700).
log "forwarding TERM and INT to launcher pid ${launcher_pid}"
status=0
wait "${launcher_pid}" || status=$?
# A trapped signal returns from `wait` before the child has exited; keep
# waiting so the exit status below is the launcher's, not the signal's.
while kill -0 "${launcher_pid}" 2>/dev/null; do
  wait "${launcher_pid}" || status=$?
done
exit "${status}"
