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
#   3. A REVISION PROOF, which core01's script does not have. The deploy only
#      succeeds if the process LISTENING on the clone port changed pid, is
#      running out of the runtime directory, and that directory is stamped with
#      the revision this run shipped. Added 2026-08-02 after a deploy reported
#      success while the previous process still held the port and served the
#      previous revision; see `check_new_process_serving` for the receipt.
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
  local uid
  uid="$(id -u)"
  log "restarting ${SERVICE_LABEL}"
  launchctl kickstart -k "gui/${uid}/${SERVICE_LABEL}" \
    || fatal "could not restart ${SERVICE_LABEL}"
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

# The pid of whatever is LISTENING on the clone port, or empty if nothing is.
#
# `lsof` on the port, deliberately, and not the two obvious alternatives:
#   - `launchctl print ... | grep pid` reports the SUPERVISED pid, which here is
#     the `local-clone.ts --start` wrapper, not the server that binds the socket
#     (measured 2026-08-02: wrapper 2407, listener 2476, its child).
#   - `pgrep -f 'bun run ...'` matches stray orphans from earlier sessions that
#     hold no port (measured: pid 37600, running since the previous day).
# The question this must answer is "who is serving :PORT", and only the socket
# knows that.
listening_pid() {
  local port="$1"
  lsof -nP -iTCP:"${port}" -sTCP:LISTEN -t 2>/dev/null | head -1
}

# The working directory of a running process, used to prove the listener is
# serving the tree we just swapped in rather than some other checkout.
pid_cwd() {
  local pid="$1"
  lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | head -1
}

deployed_short_sha() {
  local dir="$1"
  [[ -r "${dir}/.deployed-revision" ]] || return 1
  sed -n 's/^short_sha=//p' "${dir}/.deployed-revision" | head -1
}

# Prove the NEW process is the one serving. THIS is the deploy's success
# criterion; the health check below is a secondary liveness assertion.
#
# A health check the previous process can satisfy is not a proof. On 2026-08-02
# this exact script reported a successful deploy while the OLD runtime was still
# answering :3100: the restart was accepted, the new entrypoint threw on config
# and died, launchd held the service down for its ThrottleInterval (30s here)
# before retrying -- longer than the 15x2s health poll ran -- and `curl /health`
# was answered by the process that had never stopped. The stamp on disk said one
# revision; the running code was another. A deploy that cannot tell those apart
# cannot fail, and one that cannot fail proves nothing when it passes.
#
# Three assertions, all required, all fatal:
#   1. a listener exists and its pid DIFFERS from the pre-restart pid
#      (the old process really went away and a new one really bound the port)
#   2. that listener's cwd is the runtime directory
#      (it is serving the tree we swapped, not another checkout)
#   3. the runtime's .deployed-revision matches the sha this run deployed
#      (the tree it is serving is the revision we asked for)
# Returns 0 only if all three assertions hold; logs the exact reason otherwise.
# Non-fatal by design so the deploy path can roll back on failure -- the callers
# decide whether a failure is recoverable, and both of them treat it as loud.
check_new_process_serving() {
  local port="$1" previous_pid="$2" expected_short_sha="$3"
  local pid="" cwd="" stamped=""

  # Poll rather than sleep-once: bun install/migrate timing varies, and launchd
  # may hold a restarted service down for ThrottleInterval (30s on this service)
  # before the new process even starts. The polling window has to outlast that
  # or a merely-delayed start reads as a permanent failure.
  for _ in $(seq 1 30); do
    pid="$(listening_pid "$port")"
    if [[ -n "$pid" && "$pid" != "$previous_pid" ]]; then
      break
    fi
    sleep 2
  done

  if [[ -z "$pid" ]]; then
    log "revision proof FAILED: nothing is listening on port ${port} after restart"
    return 1
  fi
  if [[ "$pid" == "$previous_pid" ]]; then
    log "revision proof FAILED: port ${port} is still held by the PRE-DEPLOY process (pid ${pid}); the new runtime never took over"
    return 1
  fi

  cwd="$(pid_cwd "$pid")"
  if [[ "$cwd" != "$RUNTIME_DIR" ]]; then
    log "revision proof FAILED: listener pid ${pid} is serving '${cwd:-<unknown>}', not the deployed runtime ${RUNTIME_DIR}"
    return 1
  fi

  if ! stamped="$(deployed_short_sha "$RUNTIME_DIR")"; then
    log "revision proof FAILED: no .deployed-revision in ${RUNTIME_DIR}"
    return 1
  fi
  if [[ "$stamped" != "$expected_short_sha" ]]; then
    log "revision proof FAILED: runtime is stamped ${stamped} but this deploy shipped ${expected_short_sha}"
    return 1
  fi

  log "revision proof PASSED: pid ${previous_pid:-<none>} -> ${pid}, cwd ${cwd}, revision ${stamped}"
  return 0
}

# Fatal wrapper for callers with nowhere left to fall back to.
assert_new_process_serving() {
  check_new_process_serving "$@" \
    || fatal "revision proof failed and there is no further fallback"
}

if [[ "${1:-}" == "--rollback" ]]; then
  [[ -d "$PREVIOUS_DIR" ]] || fatal "no previous runtime at ${PREVIOUS_DIR}"
  [[ -r "$ENV_FILE" ]] || fatal "env file missing or unreadable: ${ENV_FILE}"
  # Sourced here too, not only on the deploy path: the rollback needs the clone
  # port to know which listener to prove. A rollback that cannot check the port
  # is the same unfalsifiable success the deploy path used to report.
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
  ROLLBACK_PORT="${PORT:-3100}"

  log "rolling back to ${PREVIOUS_DIR}"
  rm -rf "${RUNTIME_DIR}.rollback-discard"
  [[ -d "$RUNTIME_DIR" ]] && mv "$RUNTIME_DIR" "${RUNTIME_DIR}.rollback-discard"
  mv "$PREVIOUS_DIR" "$RUNTIME_DIR"

  PRE_ROLLBACK_PID="$(listening_pid "$ROLLBACK_PORT")"
  log "pre-rollback listener on port ${ROLLBACK_PORT}: pid ${PRE_ROLLBACK_PID:-<none>}"
  restart_service

  if [[ -n "$SERVICE_LABEL" ]]; then
    # Same standard of proof as a deploy. Rolling back is exactly when a false
    # success is most expensive: the operator stops looking because the log said
    # the old revision is back, while the broken one is still serving.
    assert_new_process_serving "$ROLLBACK_PORT" "$PRE_ROLLBACK_PID" \
      "$(deployed_short_sha "$RUNTIME_DIR")"
    wait_for_health "$ROLLBACK_PORT" "post-rollback" \
      || fatal "health check failed after rollback; service is down"
  else
    log "NOTE: no service label set, so nothing was restarted and the rollback is UNVERIFIED."
  fi

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

# Read the OUTGOING listener before the restart. This is the value that makes
# the proof below possible: without a "before", "something is answering" and
# "the new thing is answering" are indistinguishable.
PRE_RESTART_PID="$(listening_pid "$CLONE_PORT")"
log "pre-restart listener on port ${CLONE_PORT}: pid ${PRE_RESTART_PID:-<none>}"

restart_service

if [[ -n "$SERVICE_LABEL" ]]; then
  # Order matters: prove the process FIRST, then check health. Reversing these
  # is the 2026-08-02 failure -- health passed against the outgoing process and
  # the deploy exited 0 with the old revision still serving.
  deploy_ok=1
  if ! check_new_process_serving "$CLONE_PORT" "$PRE_RESTART_PID" "$SHORT_SHA"; then
    deploy_ok=0
  elif ! wait_for_health "$CLONE_PORT" "post-deploy"; then
    log "health check FAILED"
    deploy_ok=0
  fi

  if [[ "$deploy_ok" -eq 0 ]]; then
    log "deploy verification FAILED; rolling back"
    if [[ -d "$PREVIOUS_DIR" ]]; then
      rm -rf "${RUNTIME_DIR}.failed"
      mv "$RUNTIME_DIR" "${RUNTIME_DIR}.failed"
      mv "$PREVIOUS_DIR" "$RUNTIME_DIR"
      rollback_pid="$(listening_pid "$CLONE_PORT")"
      restart_service
      # The rollback gets the same standard of proof as the deploy. A rollback
      # that "succeeded" because the failed process still held the port would
      # leave the broken revision serving under a reassuring log line.
      assert_new_process_serving "$CLONE_PORT" "$rollback_pid" \
        "$(deployed_short_sha "$RUNTIME_DIR")"
      wait_for_health "$CLONE_PORT" "post-rollback" \
        || fatal "health check failed after rollback; service is down"
      fatal "deploy of ${SHORT_SHA} failed verification and was rolled back"
    fi
    fatal "deploy of ${SHORT_SHA} failed verification and there was no previous runtime"
  fi
else
  log "NOTE: no service label set, so nothing was restarted and NO revision proof was possible."
  log "NOTE: ${RUNTIME_DIR} now holds ${SHORT_SHA} but the running process is unverified."
fi

log "deployed ${SHORT_SHA} to ${RUNTIME_DIR}"
