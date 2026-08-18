#!/usr/bin/env bash
# Deploy a COMMITTED revision of this repo into the core01 runtime.
#
# Hardened 2026-08-09 for cutover-blocker B5 (issue #675). Before that, the
# only post-restart assertion here was wait_for_health(): a 20s poll of the
# :3100 AGGREGATE FRONT. That is unfalsifiable in the one way that matters.
# On 2026-08-02 the local clone — running this same shape — reported a
# successful deploy while the OLD runtime was still answering: the new
# entrypoint threw on config and died, launchd held the service down for its
# ThrottleInterval (LONGER than the poll), and `curl /health` was answered by
# the process that had never stopped. A deploy that cannot fail proves nothing
# when it passes. The clone was hardened then; core01 was not, and core01's
# poll window is SHORTER, so it was strictly more exposed.
#
# What #675 added, all ported from scripts/local-clone-deploy.sh's lineage:
#
#   1. A REVISION PROOF that runs BEFORE health and is the deploy's actual
#      success criterion — listening pid changed, its cwd is the runtime dir,
#      and .deployed-revision matches the sha this run shipped.
#   2. A FEATURE SIGNAL assertion. A revision proof is not a feature-live
#      proof: #659's clone redeploy passed its revision proof at the right SHA
#      while the merged feature stayed dark behind an env allowlist. The
#      deploy now reads the FEATURE's own key out of the served /health body.
#   3. PER-WORKER PORT checks. core01 runs two workers behind the :3100 front
#      (scripts/run-two-worker.ts), and the front AGGREGATES — polling it says
#      nothing about an individual dead worker.
#   4. Staging by `git archive` of the COMMIT, not a tar of the working tree
#      (scripts/core01-package-runtime.sh).
#   5. A BACKUP of the operator env file before the in-place rewrite, since
#      that file holds every AUTH_TOKEN_* and .previous covers only the
#      runtime.
#
# The launch shape itself is versioned at docs/deploy/com.rico.open-brain.plist.template
# (B2) — the polling windows below are set against the ThrottleInterval it
# declares, which is exactly the reasoning that was impossible while the plist
# lived only on the box.
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

# The revision to deploy. Defaults to HEAD, matching the previous behavior.
DEPLOY_REF="${DEPLOY_REF:-HEAD}"

# The aggregate front and the worker ports behind it. Defaults match
# scripts/run-two-worker.ts, which is what the plist starts; when the plist and
# these disagree the plist wins, so both read the same variable names.
PUBLIC_PORT="${OPEN_BRAIN_PUBLIC_PORT:-3100}"
WORKER_PORTS="${OPEN_BRAIN_WORKER_PORTS:-3101,3102}"

# The FEATURE the deploy must observe live in /health before declaring success.
# A top-level key of the /health body. Named per deploy rather than hardcoded:
# the point of a feature signal is that it tracks the feature currently being
# shipped, and a stale hardcoded key silently degrades to a liveness check.
# Empty = no feature assertion (announced loudly below, never assumed).
HEALTH_FEATURE_KEY="${OPENBRAIN_DEPLOY_HEALTH_FEATURE_KEY:-capture_health}"

# Poll windows, in 2s ticks. The revision-proof window must OUTLAST launchd's
# ThrottleInterval or a merely-delayed start reads as a permanent failure —
# the plist template declares 30s, so 30 ticks (60s) clears it with margin.
# This is the number that could not be reasoned about while the plist was
# unversioned (B2/B3 are one fix surface for exactly this reason).
REVISION_PROOF_TICKS="${OPENBRAIN_DEPLOY_REVISION_PROOF_TICKS:-30}"
HEALTH_TICKS="${OPENBRAIN_DEPLOY_HEALTH_TICKS:-30}"

log() { printf '%s core01-deploy: %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$1"; }

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

worker_port_list() {
  printf '%s' "$WORKER_PORTS" | tr ',' ' '
}

# Health on the aggregate front. Kept as a SECONDARY liveness assertion — it is
# no longer the success criterion, because the outgoing process can satisfy it.
wait_for_health() {
  local label="$1"

  for _ in $(seq 1 "$HEALTH_TICKS"); do
    if curl -fsS --max-time 5 "http://127.0.0.1:${PUBLIC_PORT}/health" >/dev/null 2>&1; then
      log "$label health check passed on the front (:${PUBLIC_PORT})"
      return 0
    fi
    sleep 2
  done

  return 1
}

# Each worker, on its OWN port, directly.
#
# The front at :3100 is a proxy that aggregates worker health
# (scripts/run-two-worker.ts workerHealth/`/health`). Whether it reports
# `degraded` for a dead worker depends on the front's own logic, and polling it
# is one indirection away from the question. A worker that never came back is a
# halving of capacity and, for the migration-running worker 0, a deploy that
# did not do what it said. Ask each port itself.
wait_for_worker_ports() {
  local label="$1" port ok
  for port in $(worker_port_list); do
    ok=0
    for _ in $(seq 1 "$HEALTH_TICKS"); do
      if curl -fsS --max-time 5 "http://127.0.0.1:${port}/health" >/dev/null 2>&1; then
        ok=1
        break
      fi
      sleep 2
    done
    if [[ "$ok" -ne 1 ]]; then
      log "${label} FAILED: worker port ${port} is not answering /health (the front at :${PUBLIC_PORT} can read green over this)"
      return 1
    fi
    log "${label}: worker port ${port} healthy"
  done
  return 0
}

# The FEATURE's own signal, not the revision's.
#
# Round 18 / issue #659: a revision proof passed at the right SHA while the
# merged feature stayed dark, because the launcher's env allowlist dropped the
# new config keys. The revision was right and the feature was absent, and only
# reading the feature's own signal could tell those apart. Asserted on every
# worker port, because a per-worker env difference is exactly how one worker
# ends up with the feature and one without.
assert_feature_live() {
  local label="$1" port body
  if [[ -z "$HEALTH_FEATURE_KEY" ]]; then
    log "${label}: NO feature-signal assertion (OPENBRAIN_DEPLOY_HEALTH_FEATURE_KEY is empty) — this deploy proves the revision only"
    return 0
  fi

  for port in $(worker_port_list) "$PUBLIC_PORT"; do
    body="$(curl -fsS --max-time 5 "http://127.0.0.1:${port}/health" 2>/dev/null || true)"
    if [[ -z "$body" ]]; then
      log "${label} FAILED: no /health body from port ${port}; cannot read feature '${HEALTH_FEATURE_KEY}'"
      return 1
    fi
    # Read the key with the JSON parser we already ship rather than matching
    # text: a substring match on the raw body is satisfied by the key appearing
    # anywhere at all, including inside an error string naming it (round 17).
    if ! FEATURE_KEY="$HEALTH_FEATURE_KEY" HEALTH_BODY="$body" "$BUN_BIN" -e '
      const key = process.env.FEATURE_KEY;
      let body;
      try { body = JSON.parse(process.env.HEALTH_BODY ?? ""); }
      catch { process.exit(3); }
      if (body === null || typeof body !== "object") process.exit(3);
      process.exit(Object.hasOwn(body, key) && body[key] != null ? 0 : 1);
    ' >/dev/null 2>&1; then
      log "${label} FAILED: /health on port ${port} does not report feature '${HEALTH_FEATURE_KEY}' — the revision may be right while the feature is dark (issue #659)"
      return 1
    fi
    log "${label}: feature '${HEALTH_FEATURE_KEY}' live on port ${port}"
  done
  return 0
}

# The pid of whatever is LISTENING on a port, or empty if nothing is.
#
# `lsof` on the port, deliberately, and not the two obvious alternatives
# (measured on the clone 2026-08-02):
#   - `launchctl print ... | grep pid` reports the SUPERVISED pid, which here
#     is the two-worker launcher, not the process that binds a worker socket.
#   - `pgrep -f 'bun run ...'` matches stray orphans holding no port.
# The question is "who is serving :PORT", and only the socket knows that.
# "Nothing is listening" is a NORMAL, expected answer here — it is the state of
# a first deploy, and of any deploy where the service is already down. `lsof`
# exits non-zero when it matches nothing, and this script runs under
# `set -euo pipefail`, so a bare command substitution would ABORT the deploy at
# exactly that case. Caught by this lane's own control clause: the happy-path
# deploy died silently one line after "swapped", with no error, because
# capturing the pre-restart pid on a free port killed the shell. Swallow the
# status explicitly and let an empty string mean "nobody".
listening_pid() {
  local port="$1"
  lsof -nP -iTCP:"${port}" -sTCP:LISTEN -t 2>/dev/null | head -1 || true
}

# The working directory of a running process, used to prove the listener is
# serving the tree we just swapped in rather than some other checkout.
# Same swallow as listening_pid: a process that vanished between the two calls
# makes lsof exit non-zero, and an aborted deploy is a worse answer than an
# empty cwd (which the caller already reports as '<unknown>').
pid_cwd() {
  local pid="$1"
  lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | head -1 || true
}

deployed_short_sha() {
  local dir="$1"
  [[ -r "${dir}/.deployed-revision" ]] || return 1
  sed -n 's/^short_sha=//p' "${dir}/.deployed-revision" | head -1
}

# Prove the NEW process is the one serving. THIS is the deploy's success
# criterion; health is a secondary liveness assertion afterwards.
#
# Three assertions, all required:
#   1. a listener exists and its pid DIFFERS from the pre-restart pid
#      (the old process really went away and a new one really bound the port)
#   2. that listener's cwd is the runtime directory
#      (it is serving the tree we swapped, not another checkout)
#   3. the runtime's .deployed-revision matches the sha this run deployed
#      (the tree it is serving is the revision we asked for)
#
# Applied to the FRONT port, whose pid is the launcher that owns the workers.
# Non-fatal by design so callers can decide whether a failure is recoverable;
# both callers here treat it as loud.
check_new_process_serving() {
  local port="$1" previous_pid="$2" expected_short_sha="$3"
  local pid="" cwd="" stamped=""

  # Poll rather than sleep-once: bun install/migrate timing varies, and launchd
  # may hold a restarted service down for ThrottleInterval (30s per the plist
  # template) before the new process even starts. The window has to outlast
  # that or a merely-delayed start reads as a permanent failure.
  for _ in $(seq 1 "$REVISION_PROOF_TICKS"); do
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

# The full post-restart verdict, in the order that makes it falsifiable:
# revision proof FIRST (can the outgoing process be mistaken for the new one?),
# then each worker port, then the feature signal, then front health. Reversing
# revision and health is the 2026-08-02 failure exactly.
verify_deploy() {
  local label="$1" port="$2" previous_pid="$3" expected_short_sha="$4"

  check_new_process_serving "$port" "$previous_pid" "$expected_short_sha" || return 1
  wait_for_worker_ports "$label" || return 1
  assert_feature_live "$label" || return 1
  wait_for_health "$label" || { log "${label} FAILED: front health check did not pass"; return 1; }
  return 0
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

# Stage the COMMIT. The ref is resolved inside the packaging script, which
# fails before writing anything if it is not a commit.
"$REPO_DIR/scripts/core01-package-runtime.sh" "$REPO_DIR" "$STAGING_DIR" "$DEPLOY_REF"

# The sha this run is shipping — read from the stamp the packaging script just
# wrote, so the value the revision proof compares against is the value that
# actually reached the staging tree, not a second independent rev-parse that
# could drift if the ref moved mid-run.
DEPLOY_SHORT_SHA="$(deployed_short_sha "$STAGING_DIR")" || {
  echo "FATAL: staging tree has no .deployed-revision; cannot prove what this deploy ships" >&2
  exit 1
}
log "deploying ${DEPLOY_SHORT_SHA} (${DEPLOY_REF}) to ${RUNTIME_DIR}"

"$BUN_BIN" install --cwd "$STAGING_DIR" --frozen-lockfile

if [[ -x "$STAGING_DIR/scripts/core01-qmd-bootstrap.sh" ]]; then
  "$STAGING_DIR/scripts/core01-qmd-bootstrap.sh"
fi

# BACK UP the operator env file before rewriting it in place (SHOULD-FIX 5 of
# issue #675). This file holds every AUTH_TOKEN_*, the in-place `perl -pi`
# truncates it if it fails mid-write, and the .previous rollback covers only
# the runtime directory — nothing else on the box has a copy. The backup is
# timestamped rather than a single .bak so a second deploy cannot overwrite the
# only good copy with an already-damaged one. Announced, per nothing-silent:
# the previous version rewrote an operator's file and said nothing at all.
ENV_BACKUP="${ENV_FILE}.bak-$(date -u +%Y%m%dT%H%M%SZ)"
cp -p "$ENV_FILE" "$ENV_BACKUP"
log "env file backed up: ${ENV_FILE} -> ${ENV_BACKUP}"

if rg -q "^QMD_PATH=" "$ENV_FILE" 2>/dev/null; then
  CURRENT_QMD_PATH="$(sed -n 's/^QMD_PATH=//p' "$ENV_FILE" | head -1)"
  if [[ "$CURRENT_QMD_PATH" != "$QMD_PATH_VALUE" ]]; then
    log "ADJUSTED: QMD_PATH in ${ENV_FILE}: ${CURRENT_QMD_PATH} -> ${QMD_PATH_VALUE}"
  fi
  perl -pi -e "s#^QMD_PATH=.*#QMD_PATH=$QMD_PATH_VALUE#" "$ENV_FILE"
else
  log "ADJUSTED: QMD_PATH absent from ${ENV_FILE}; appending ${QMD_PATH_VALUE}"
  printf '\nQMD_PATH=%s\n' "$QMD_PATH_VALUE" >> "$ENV_FILE"
fi

cd "$STAGING_DIR"
"$BUN_BIN" run migrate

if [[ -d "$RUNTIME_DIR" ]]; then
  mv "$RUNTIME_DIR" "$PREVIOUS_DIR"
fi
mv "$STAGING_DIR" "$RUNTIME_DIR"
log "swapped ${DEPLOY_SHORT_SHA} into ${RUNTIME_DIR}"

# Read the OUTGOING listener BEFORE the restart. This is the value that makes
# the revision proof possible at all: without a "before", "something is
# answering" and "the NEW thing is answering" are indistinguishable, which is
# precisely how the 2026-08-02 deploy reported success over a stale process.
PRE_RESTART_PID="$(listening_pid "$PUBLIC_PORT")"
log "pre-restart listener on :${PUBLIC_PORT}: pid ${PRE_RESTART_PID:-<none>}"

launchctl kickstart -k "$SERVICE_LABEL"
if ! launchctl kickstart -k "$NATS_WORKER_LABEL"; then
  echo "WARN: could not restart Open Brain NATS worker: $NATS_WORKER_LABEL" >&2
fi

if verify_deploy "Open Brain" "$PUBLIC_PORT" "$PRE_RESTART_PID" "$DEPLOY_SHORT_SHA"; then
  "$BUN_BIN" test src/tools/__tests__/search-all.test.ts
  cleanup_previous_dir post-health
  log "deployed ${DEPLOY_SHORT_SHA} to ${RUNTIME_DIR}"
  exit 0
fi

log "deploy verification FAILED for ${DEPLOY_SHORT_SHA}; rolling back"

if [[ -d "$PREVIOUS_DIR" ]]; then
  # The failed runtime is MOVED ASIDE, not deleted: it is the evidence for why
  # the deploy failed, and the previous code did `rm -rf "$RUNTIME_DIR"` here,
  # destroying it. Naming is timestamped so a second failed deploy cannot
  # clobber the first one's evidence.
  FAILED_DIR="${RUNTIME_DIR}.failed-$(date -u +%Y%m%dT%H%M%SZ)"
  mv "$RUNTIME_DIR" "$FAILED_DIR"
  log "failed runtime kept at ${FAILED_DIR}"
  mv "$PREVIOUS_DIR" "$RUNTIME_DIR"

  ROLLBACK_PRE_PID="$(listening_pid "$PUBLIC_PORT")"
  launchctl kickstart -k "$SERVICE_LABEL"
  if ! launchctl kickstart -k "$NATS_WORKER_LABEL"; then
    echo "WARN: could not restart Open Brain NATS worker after rollback: $NATS_WORKER_LABEL" >&2
  fi

  # The rollback gets the SAME standard of proof as the deploy. A rollback that
  # "succeeded" because the failed process still held the port would leave the
  # broken revision serving under a reassuring log line — and a rollback is
  # exactly when a false success is most expensive, because the operator stops
  # looking. The feature assertion is deliberately dropped here: the previous
  # revision predates the feature by definition, so demanding its signal would
  # fail every correct rollback.
  ROLLBACK_SHA="$(deployed_short_sha "$RUNTIME_DIR" || true)"
  if check_new_process_serving "$PUBLIC_PORT" "$ROLLBACK_PRE_PID" "$ROLLBACK_SHA" \
     && wait_for_worker_ports "Open Brain rollback" \
     && wait_for_health "Open Brain rollback"; then
    echo "FATAL: Open Brain deploy verification failed for ${DEPLOY_SHORT_SHA}; previous runtime (${ROLLBACK_SHA:-<unstamped>}) restored and verified" >&2
    exit 1
  fi

  echo "FATAL: Open Brain deploy verification failed for ${DEPLOY_SHORT_SHA}; rollback was attempted but did NOT verify — the service needs hands" >&2
  exit 1
fi

echo "FATAL: Open Brain deploy verification failed for ${DEPLOY_SHORT_SHA} and there was no previous runtime to roll back to" >&2
exit 1
