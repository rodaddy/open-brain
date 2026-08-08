#!/usr/bin/env bash
# DONE-MEANS check for issue #384 — the acceptance gate, not the fix.
#
#   bash scripts/done-means/384-maintenance-loop-turns.sh
#
# Issue #384 acceptance, verbatim:
#   - Runner enabled and observed processing jobs on the local clone.
#   - Sweep enqueues work without operator action.
#   - Caps are enforced and logged; no silent truncation.
#   - Fix or retire the dead-lettered canary job.
#
# This drives the LIVE local dogfood service and the LIVE dogfood database.
# It is deliberately NOT a unit test: #384's whole defect class is code that
# exists, typechecks, and has passing unit tests while the running server does
# not execute it. A test that imports runMaintenanceSweep() and calls it proves
# the function works; it cannot distinguish that from a server that never calls
# it. So the observation point here is the database and the service's own log.
#
# core01/hosted is NOT touched. Two-host rule: this lane is the local half.
#
# Output is content-free: states, kinds, counts, and a random run marker only.
#
# EXPECTED TO FAIL until #384 is fixed. It is the reward function, not a test
# of the fix author's diligence.
#
# ---------------------------------------------------------------------------
# What is actually broken, measured 2026-08-07 before any fix
# ---------------------------------------------------------------------------
# The issue text says the runner is off via OPEN_BRAIN_MAINTENANCE_ENABLED=0.
# That is stale. Measured against the live box:
#
#   - /Volumes/ThunderBolt/open-brain-local/local-clone.env:12 sets
#     OPEN_BRAIN_MAINTENANCE_ENABLED=1, and the serving process (pid 13501,
#     `ps eww`) carries =1 in its environment. The runner is ENABLED.
#   - PR #577 already landed the sweep producer: src/maintenance-sweep.ts
#     exists and src/maintenance-bootstrap.ts:335 starts it.
#
# And yet zero sweep-produced jobs exist and the service logs no sweep line.
# The reason is an entrypoint split:
#
#   - src/maintenance-bootstrap.ts:300 startMaintenanceQueue() composes the
#     runner AND startRecurringMaintenanceSweep() (:335). It is reached only
#     from src/index.ts, the LEGACY entrypoint.
#   - server/maintenance/index.ts:141 createMaintenanceRuntime() composes the
#     runner ONLY. It has no sweep, and `rg runMaintenanceSweep server/`
#     returns nothing.
#   - The Phase 6 cutover made server/main.ts the serving entrypoint
#     (scripts/local-clone-autostart.sh:66-70 says so in as many words), and
#     server/main.ts:308 wires composeMaintenanceHandlers into
#     createMaintenanceRuntime.
#
# So the serving process runs the consumer half and none of the producer half.
# That is the exact shape #384 names — "both handlers are consumers with no
# producer" — surviving the very PR that was supposed to close it, because the
# producer was added to the entrypoint that stopped serving.
#
# The pre-fix log signature is unambiguous: 319 "maintenance queue idle" lines
# and 11 "maintenance queue started" lines in autostart.out.log, and zero
# "maintenance_sweep_complete". The runner polls forever over a queue nothing
# fills.
#
# ---------------------------------------------------------------------------
# Isolation, and why this check seeds a source
# ---------------------------------------------------------------------------
# Maintenance jobs are server-owned; this check must not fabricate a job and
# call the loop proven. It therefore proves the loop by PRODUCING REAL INPUT
# and letting the server decide what to do with it:
#
#   It inserts one ob_sources row — approved, active, real 64-hex content_hash,
#   in a throwaway namespace — which is precisely the condition
#   selectSourcesNeedingDerivation (src/graph-derivation-handler.ts:136-154)
#   selects on. It then enqueues NOTHING. If a sweep is running in the serving
#   process, it will find that source on its own and enqueue a graph.derive.
#   If no sweep runs, nothing appears, which is today's state.
#
# Every row this check creates is tagged with a done-means run marker and is
# removed in the trap on every exit path.
#
# DreamEngine dry-run defaults are not touched: this seeds a source row and
# reads the queue. It invokes no dream planning and no promote/archive/demote.
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "${REPO_ROOT}"

MARKER="done-means-384-$(date +%s)-$$"
NS="done-means-384"
HEALTH_URL="${OPEN_BRAIN_HEALTH_URL:-http://127.0.0.1:3100/health}"
# Sweep and runner both tick on OPEN_BRAIN_MAINTENANCE_POLL_MS (default 5000,
# src/maintenance-bootstrap.ts:320). Allow several ticks plus handler time.
WAIT_SECONDS="${DONE_MEANS_384_WAIT_SECONDS:-90}"

FAILURES=0
fail() { printf 'FAIL  %s\n' "$*"; FAILURES=$((FAILURES + 1)); }
pass() { printf 'PASS  %s\n' "$*"; }
info() { printf 'INFO  %s\n' "$*"; }

# `.env` is untracked, so it is absent from a fresh worktree. Fall back to the
# canonical checkout's copy: the dogfood database is a property of the machine,
# not of which worktree you happen to be standing in.
ENV_FILE=".env"
if [[ ! -f "${ENV_FILE}" ]]; then
  ENV_FILE="${DONE_MEANS_384_ENV_FILE:-/Volumes/ThunderBolt/Development/open-brain/.env}"
fi
if [[ ! -f "${ENV_FILE}" ]]; then
  printf 'FAIL  no .env found (looked in %s and %s); cannot reach the dogfood database\n' \
    "${REPO_ROOT}" "${ENV_FILE}"
  exit 1
fi
set -a
# shellcheck disable=SC1091
. "${ENV_FILE}"
set +a

q() { psql -At -c "$1"; }

cleanup() {
  psql -q -c "DELETE FROM maintenance_jobs WHERE namespace = '${NS}' OR idempotency_key LIKE '%${MARKER}%';" >/dev/null 2>&1
  psql -q -c "DELETE FROM ob_entities WHERE namespace = '${NS}';" >/dev/null 2>&1
  psql -q -c "DELETE FROM ob_sources WHERE namespace = '${NS}';" >/dev/null 2>&1
}
trap cleanup EXIT

printf '=== done-means #384: does the maintenance loop turn? ===\n'
printf 'run marker: %s\n\n' "${MARKER}"

# ---------------------------------------------------------------------------
# (a) Runner enabled AND running.
# ---------------------------------------------------------------------------
# Two separate facts. "Enabled" is config; "running" is a live process serving.
# Checking only the env var is how this defect hid: the var has said 1 for days.
HEALTH="$(curl -s -m 5 "${HEALTH_URL}" 2>/dev/null)"
if [[ -z "${HEALTH}" ]]; then
  fail "(a) no response from ${HEALTH_URL}; local service is not serving"
else
  HEALTH_STATUS="$(printf '%s' "${HEALTH}" | sed -n 's/.*"status":"\([^"]*\)".*/\1/p')"
  if [[ "${HEALTH_STATUS}" == "healthy" ]]; then
    pass "(a1) local service serving, status=healthy"
  else
    fail "(a1) local service status=${HEALTH_STATUS:-unparseable}"
  fi
fi

SERVER_PID="$(lsof -nP -iTCP:3100 -sTCP:LISTEN -t 2>/dev/null | head -1)"
if [[ -z "${SERVER_PID}" ]]; then
  fail "(a2) nothing is listening on 3100"
else
  PROC_ENV="$(ps eww -p "${SERVER_PID}" 2>/dev/null | tr ' ' '\n')"
  ENABLED_VAL="$(printf '%s' "${PROC_ENV}" \
    | sed -n 's/^OPEN_BRAIN_MAINTENANCE_ENABLED=\(.*\)$/\1/p' | head -1)"
  # Opt-out semantics (src/maintenance-bootstrap.ts:236-241,
  # server/config/maintenance.ts:57): anything except 0/false is enabled,
  # including unset.
  case "$(printf '%s' "${ENABLED_VAL}" | tr '[:upper:]' '[:lower:]')" in
    0|false) fail "(a2) serving pid ${SERVER_PID} has maintenance DISABLED (=${ENABLED_VAL})" ;;
    *) pass "(a2) serving pid ${SERVER_PID} has maintenance enabled (=${ENABLED_VAL:-unset})" ;;
  esac
fi

# ---------------------------------------------------------------------------
# (d) The dead-lettered canary is fixed or explicitly retired.
# ---------------------------------------------------------------------------
# Checked BEFORE the seed so the seeded work cannot mask it. "Retired" means
# the row is gone or no longer sitting in dead_letter; a canary that still
# dead-letters is an unresolved job the operator is expected to ignore, which
# is exactly the numbness #384 is about.
CANARY_STATE="$(q "SELECT state FROM maintenance_jobs WHERE idempotency_key LIKE 'canary:%';" 2>/dev/null)"
if [[ -z "${CANARY_STATE}" ]]; then
  pass "(d) no canary row remains (retired)"
elif [[ "${CANARY_STATE}" == *dead_letter* ]]; then
  fail "(d) canary still dead-lettered (state=${CANARY_STATE})"
else
  pass "(d) canary present but not dead-lettered (state=${CANARY_STATE})"
fi

# ---------------------------------------------------------------------------
# Seed one real derivable source. Enqueue nothing.
# ---------------------------------------------------------------------------
SEED_HASH="$(printf '%s' "${MARKER}" | shasum -a 256 | cut -d' ' -f1)"
if ! psql -q -c "INSERT INTO ob_sources
     (namespace, source_kind, external_id, title, approval_state, approved_by,
      approved_at, lifecycle_state, content_hash, created_by)
   VALUES
     ('${NS}', 'drop', '${MARKER}', 'done-means 384 probe', 'approved',
      'done-means-384', now(), 'active', '${SEED_HASH}', 'done-means-384');" 2>&1
then
  fail "could not seed probe source; cannot test the producer (error above)"
  printf '\n=== RESULT: FAIL (%d) ===\n' "${FAILURES}"
  exit 1
fi
info "seeded 1 approved/active source in namespace ${NS}; enqueued nothing"

BASELINE_JOBS="$(q "SELECT count(*) FROM maintenance_jobs;")"
info "baseline maintenance_jobs rows: ${BASELINE_JOBS}"

# ---------------------------------------------------------------------------
# (b) The sweep enqueues real work, with no operator action.
# (c) At least one job reaches terminal SUCCESS.
# ---------------------------------------------------------------------------
info "waiting up to ${WAIT_SECONDS}s for the server's own sweep to act..."
PROBE_JOB_STATE=""
DEADLINE=$(( $(date +%s) + WAIT_SECONDS ))
while [[ $(date +%s) -lt ${DEADLINE} ]]; do
  PROBE_JOB_STATE="$(q "SELECT state FROM maintenance_jobs WHERE namespace = '${NS}' ORDER BY created_at DESC LIMIT 1;" 2>/dev/null)"
  [[ "${PROBE_JOB_STATE}" == "succeeded" ]] && break
  sleep 3
done

if [[ -z "${PROBE_JOB_STATE}" ]]; then
  fail "(b) no job was enqueued for the seeded source within ${WAIT_SECONDS}s — the producer is not running in the serving process"
else
  pass "(b) sweep enqueued a job for the seeded source with no operator action"
fi

if [[ "${PROBE_JOB_STATE}" == "succeeded" ]]; then
  pass "(c) job reached terminal SUCCESS (state=succeeded)"
else
  fail "(c) no job reached terminal success (last observed state=${PROBE_JOB_STATE:-none})"
fi

printf '\n--- observed queue state (namespace %s) ---\n' "${NS}"
psql -c "SELECT job_kind, state, attempts, last_error_category
           FROM maintenance_jobs WHERE namespace = '${NS}';" 2>&1 || true

printf '\n'
if [[ ${FAILURES} -eq 0 ]]; then
  printf '=== RESULT: PASS — the maintenance loop turns ===\n'
  exit 0
fi
printf '=== RESULT: FAIL (%d failing clause(s)) ===\n' "${FAILURES}"
exit 1
