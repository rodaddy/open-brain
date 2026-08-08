#!/usr/bin/env bash
# DONE-MEANS check for issue #612 — the acceptance gate, not the fix.
#
#   bash scripts/done-means/612-component-lines-reach-logs.sh
#
# Issue #612 acceptance, verbatim:
#   An executable check that greps the clone log file for a child-logger line
#   with a `component` field emitted during the run, red on current behavior.
#
# This drives the LIVE local dogfood service. core01/hosted is NOT touched
# (two-host rule); this lane is the local half.
#
# ---------------------------------------------------------------------------
# What is actually broken, measured 2026-08-08 before any fix
# ---------------------------------------------------------------------------
# The issue frames this as child-logger lines being dropped. Measured against
# the live clone, the defect is BROADER: not one pino line of any kind reaches
# the clone's log file. In /Volumes/ThunderBolt/open-brain-local/log/open-brain.log:
#
#   - `"component"` lines:                            0
#   - pino server lines (mcp_tracing_configured,
#     migrations_complete, server_shutdown_*):        0
#   - `graph_derivation_enqueue_sweep` lines:     3,465
#
# The 3,465 surviving lines are the reason this looked like a child-logger
# problem. They do not come from pino at all: `graph_derivation_enqueue_sweep`
# is emitted by the LEGACY module logger `src/logger.ts`
# (src/graph-derivation-handler.ts:297), which writes LOG_FILE itself through
# its own rotating sink. Every pino line — module and child alike — is lost.
#
# Mechanism, isolated by bisecting loggerOptions field by field:
#
#   `formatters.level` (server/logging/logger.ts:49) rewrites the serialized
#   `level` field from pino's numeric 30 to the string "info". That is required
#   by the shared envelope (_DOCS/STANDARDS-observability.md:58). It is also
#   fatal in combination with a MULTI-TARGET pino.transport:
#
#     - pino/lib/worker.js:126 — a SINGLE target returns its stream directly,
#       with no level routing. Multiple targets go through build(..., metadata)
#       and pino.multistream instead.
#     - pino-abstract-transport/index.js:49 — `stream.lastLevel = value.level`,
#       taken raw off the parsed JSON. Unmapped.
#     - pino/lib/multistream.js:61 — routes on `dest.level <= level`.
#
#   So the comparison performed for every line is `30 <= "info"`, which is
#   false for every destination, and multistream silently writes the line
#   nowhere. No error, no warning, no dropped-line counter.
#
# The unit tests could never have caught it: server/logging/logging.test.ts:31
# injects an in-memory Writable via createLogger(CONFIG, stream), which is the
# single-destination path where formatters.level works correctly. Only the
# production default — createLogTransport()'s two targets — takes the broken
# path. The test and production disagreed about which pino code ran.
#
# ---------------------------------------------------------------------------
# Why this check observes the sweep rather than emitting its own line
# ---------------------------------------------------------------------------
# The observation point has to be a line the SERVER emits on its own, through
# the real composed logger, in the serving process. A check that constructs a
# logger and asserts it wrote proves the library works; it cannot distinguish
# that from a server whose composed transport drops everything — which is
# exactly the bug.
#
# So this seeds one real derivable ob_sources row, enqueues NOTHING, and waits
# for the server's own maintenance sweep to run and emit
# `maintenance_sweep_complete` through logger.child({component:"maintenance"})
# (server/main.ts:310 -> src/maintenance-sweep.ts:257). The sweep is the
# documented instance named in the issue.
#
# Every row this check creates is tagged with a run marker and removed in the
# trap on every exit path.
#
# NOT-RUNNING IS LOUD, NOT VACUOUS. If the clone is not serving, this exits 3
# with an explicit message rather than reporting a pass over an empty file.
# A grep over a log nobody is writing to succeeds at examining nothing, and
# that silent-success shape is the class this check exists to avoid
# (AGENTS.md Coding Standards, 2026-08-08).
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "${REPO_ROOT}"

MARKER="done-means-612-$(date +%s)-$$"
NS="done-means-612"
HEALTH_URL="${OPEN_BRAIN_HEALTH_URL:-http://127.0.0.1:3100/health}"
CLONE_LOG_DIR="${OPENBRAIN_CLONE_LOG_DIR:-/Volumes/ThunderBolt/open-brain-local/log}"
# The sweep ticks on OPEN_BRAIN_MAINTENANCE_POLL_MS (default 5000). Allow
# several ticks plus handler and file-flush time.
WAIT_SECONDS="${DONE_MEANS_612_WAIT_SECONDS:-90}"

EXIT_NOT_RUNNING=3

FAILURES=0
fail() { printf 'FAIL  %s\n' "$*"; FAILURES=$((FAILURES + 1)); }
pass() { printf 'PASS  %s\n' "$*"; }
info() { printf 'INFO  %s\n' "$*"; }

# Loud, distinct exit for "there was nothing to examine". Never a pass.
abort_not_running() {
  printf '\n'
  printf 'ABORT (exit %d) — PRECONDITION NOT MET, NOTHING WAS EXAMINED\n' "${EXIT_NOT_RUNNING}"
  printf '  %s\n' "$*"
  printf '  This is NOT a pass and NOT a fail: the check could not observe the\n'
  printf '  serving process at all. Start the local clone and re-run.\n'
  exit "${EXIT_NOT_RUNNING}"
}

# `.env` is untracked, so it is absent from a fresh worktree. Fall back to the
# canonical checkout's copy: the dogfood database is a property of the machine,
# not of which worktree you happen to be standing in.
ENV_FILE=".env"
if [[ ! -f "${ENV_FILE}" ]]; then
  ENV_FILE="${DONE_MEANS_612_ENV_FILE:-/Volumes/ThunderBolt/Development/open-brain/.env}"
fi
if [[ ! -f "${ENV_FILE}" ]]; then
  abort_not_running "no .env found (looked in ${REPO_ROOT} and ${ENV_FILE}); cannot reach the dogfood database"
fi
set -a
# shellcheck disable=SC1091
. "${ENV_FILE}"
set +a

SIZES_FILE=""

cleanup() {
  [[ -n "${SIZES_FILE}" && -f "${SIZES_FILE}" ]] && mv -f "${SIZES_FILE}" "${SIZES_FILE}.done" 2>/dev/null
  psql -q -c "DELETE FROM maintenance_jobs WHERE namespace = '${NS}' OR idempotency_key LIKE '%${MARKER}%';" >/dev/null 2>&1
  psql -q -c "DELETE FROM ob_entities WHERE namespace = '${NS}';" >/dev/null 2>&1
  psql -q -c "DELETE FROM ob_sources WHERE namespace = '${NS}';" >/dev/null 2>&1
}
trap cleanup EXIT

printf '=== done-means #612: do component child-logger lines reach the clone log? ===\n'
printf 'run marker: %s\n\n' "${MARKER}"

# ---------------------------------------------------------------------------
# Preconditions. Each one, unmet, means nothing can be observed.
# ---------------------------------------------------------------------------
HEALTH="$(curl -s -m 5 "${HEALTH_URL}" 2>/dev/null)"
if [[ -z "${HEALTH}" ]]; then
  abort_not_running "no response from ${HEALTH_URL}; the local clone is not serving"
fi
HEALTH_STATUS="$(printf '%s' "${HEALTH}" | sed -n 's/.*"status":"\([^"]*\)".*/\1/p')"
if [[ "${HEALTH_STATUS}" != "healthy" ]]; then
  abort_not_running "local clone status=${HEALTH_STATUS:-unparseable}; refusing to grep logs of an unhealthy service"
fi
pass "(pre1) local clone serving, status=healthy"

SERVER_PID="$(lsof -nP -iTCP:3100 -sTCP:LISTEN -t 2>/dev/null | head -1)"
if [[ -z "${SERVER_PID}" ]]; then
  abort_not_running "nothing is listening on 3100"
fi
pass "(pre2) serving pid ${SERVER_PID}"

if [[ ! -d "${CLONE_LOG_DIR}" ]]; then
  abort_not_running "clone log dir ${CLONE_LOG_DIR} does not exist"
fi

# The pino file destination is derived per worker (workerLogPath), so the exact
# filename is not knowable from here. Consider every log file in the clone log
# dir; the assertion is that SOME clone log file carries the line.
LOG_FILE_COUNT="$(fd -t f -e log . "${CLONE_LOG_DIR}" 2>/dev/null | wc -l | tr -d ' ')"
if [[ "${LOG_FILE_COUNT}" -eq 0 ]]; then
  abort_not_running "no *.log files at all under ${CLONE_LOG_DIR}; nothing to examine"
fi
info "watching ${LOG_FILE_COUNT} log file(s) under ${CLONE_LOG_DIR}"

# Only lines written from THIS run count. Record each file's current size so a
# historical line can never satisfy the assertion. A file created after this
# point has no recorded size and is therefore scanned from byte 0, which is
# correct: all of its content is new.
# Deliberately NOT mktemp/$TMPDIR: those are sandbox-local, so a runner, a
# sandbox, and the host each see a different one (Development AGENTS.md, hard
# rule). The scratch bucket is a real shared path.
SCRATCH_DIR="${DONE_MEANS_612_SCRATCH_DIR:-/Volumes/ThunderBolt/_tmp/open-brain/_scratch}"
mkdir -p "${SCRATCH_DIR}" 2>/dev/null
SIZES_FILE="${SCRATCH_DIR}/done-means-612-sizes.$$"
: > "${SIZES_FILE}"
while IFS= read -r f; do
  printf '%s\t%s\n' "$(wc -c < "$f" 2>/dev/null || echo 0)" "$f" >> "${SIZES_FILE}"
done < <(fd -t f -e log . "${CLONE_LOG_DIR}" 2>/dev/null)

start_size_of() {
  local target="$1"
  awk -F'\t' -v t="${target}" '$2 == t { print $1; found = 1; exit } END { if (!found) print 0 }' \
    "${SIZES_FILE}"
}

# Scan only the bytes appended since the run started, across all clone log
# files, plus any log file created after the run started.
scan_new_lines() {
  local pattern="$1" f start now hits
  local total=0
  while IFS= read -r f; do
    start="$(start_size_of "$f")"
    now="$(wc -c < "$f" 2>/dev/null || echo 0)"
    [[ "${now}" -le "${start}" ]] && continue
    hits="$(tail -c "+$((start + 1))" "$f" 2>/dev/null | rg -c -- "${pattern}" 2>/dev/null || echo 0)"
    total=$((total + hits))
  done < <(fd -t f -e log . "${CLONE_LOG_DIR}" 2>/dev/null)
  printf '%s' "${total}"
}

# ---------------------------------------------------------------------------
# Seed one real derivable source. Enqueue nothing. Let the server's own sweep
# run and emit its child-logger line.
# ---------------------------------------------------------------------------
SEED_HASH="$(printf '%s' "${MARKER}" | shasum -a 256 | cut -d' ' -f1)"
if ! psql -q -c "INSERT INTO ob_sources
     (namespace, source_kind, external_id, title, approval_state, approved_by,
      approved_at, lifecycle_state, content_hash, created_by)
   VALUES
     ('${NS}', 'drop', '${MARKER}', 'done-means 612 probe', 'approved',
      'done-means-612', now(), 'active', '${SEED_HASH}', 'done-means-612');" 2>&1
then
  fail "could not seed probe source; cannot drive the sweep (error above)"
  printf '\n=== RESULT: FAIL (%d failing clause(s)) ===\n' "${FAILURES}"
  exit 1
fi
info "seeded 1 approved/active source in namespace ${NS}; enqueued nothing"

info "waiting up to ${WAIT_SECONDS}s for the server's own sweep to log..."

COMPONENT_HITS=0
SWEEP_HITS=0
DEADLINE=$((SECONDS + WAIT_SECONDS))
while [[ "${SECONDS}" -lt "${DEADLINE}" ]]; do
  COMPONENT_HITS="$(scan_new_lines '"component":"maintenance"')"
  SWEEP_HITS="$(scan_new_lines 'maintenance_sweep_complete')"
  if [[ "${COMPONENT_HITS}" -gt 0 && "${SWEEP_HITS}" -gt 0 ]]; then
    break
  fi
  sleep 5
done
LEGACY_HITS="$(scan_new_lines 'graph_derivation_enqueue_sweep')"

# ---------------------------------------------------------------------------
# (z) Control clause: prove the observation window itself was live.
# ---------------------------------------------------------------------------
# Without this, "no component line appeared" is ambiguous between the defect
# and a run in which the server happened to log nothing at all. The legacy
# module-logger sweep line is known to land today, so its ABSENCE means the
# window was dead and the other clauses are not interpretable.
if [[ "${LEGACY_HITS}" -gt 0 ]]; then
  pass "(z) observation window live: ${LEGACY_HITS} legacy module-logger line(s) appeared during the run"
else
  abort_not_running "no module-logger lines appeared during the ${WAIT_SECONDS}s window either; the window was dead, so the component result is not interpretable"
fi

# ---------------------------------------------------------------------------
# (a) The child-logger line reaches the clone log file. THE ACCEPTANCE CLAUSE.
# ---------------------------------------------------------------------------
if [[ "${COMPONENT_HITS}" -gt 0 ]]; then
  pass "(a) ${COMPONENT_HITS} line(s) carrying \"component\":\"maintenance\" reached the clone log"
else
  fail "(a) no \"component\":\"...\" line reached any clone log file during the run"
fi

# ---------------------------------------------------------------------------
# (b) That line is specifically the documented child-logger instance.
# ---------------------------------------------------------------------------
if [[ "${SWEEP_HITS}" -gt 0 ]]; then
  pass "(b) ${SWEEP_HITS} maintenance_sweep_complete line(s) reached the clone log"
else
  fail "(b) maintenance_sweep_complete never reached any clone log file"
fi

if [[ "${FAILURES}" -eq 0 ]]; then
  printf '\n=== RESULT: PASS — component child-logger lines reach the clone logs ===\n'
  exit 0
fi
printf '\n=== RESULT: FAIL (%d failing clause(s)) ===\n' "${FAILURES}"
exit 1
