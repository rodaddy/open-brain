#!/usr/bin/env bash
# DONE-MEANS check for issue #747 - the acceptance gate, not the fix.
#
#   bash scripts/done-means/747-distill-sweep-yields.sh
#
# #747: the distill producer runs forever and selects nothing. Turns pile up
# undistilled while every signal reports healthy.
#
# THE MECHANISM this gate holds the line on. `selectDistillLaneBatches`
# (src/maintenance-sweep.ts) builds `window_turns` from EVERY turn in a selected
# session -- it filters only on retention_tier and carries distilled_at along as
# a boolean:
#
#   window_turns AS (
#     SELECT t.id, ..., (t.distilled_at IS NULL) AS is_due
#       FROM ob_raw_turns t JOIN ranked_sessions s ON ...
#      WHERE t.retention_tier = 'live'        -- no distilled_at predicate
#   ),
#   ranked_window_turns AS (
#     SELECT *, row_number() OVER (PARTITION BY lane_id, namespace
#              ORDER BY session_ref NULLS LAST, occurred_at NULLS LAST, id)
#            AS turn_rank
#       FROM window_turns                     -- ranks ALREADY-DONE turns too
#   )
#
# `due_lanes` then counts FILTER (WHERE w.is_due AND w.turn_rank <= $2). So
# turns distilled weeks ago occupy rank positions, get re-ranked on every tick,
# and push genuinely-due work past the batch bound forever.
#
# Measured on the live dogfood database as the service role, 2026-08-25:
#
#   due_in_window : 5921      undistilled turns inside the window
#   processable   : 0         how many qualify
#   min_due_rank  : 1501      rank of the FIRST due turn, one past the bound
#
# WHY EVERY EXISTING SIGNAL STAYED GREEN, which is what this gate exists to
# change. /health reported status healthy with the producer not stale and 1,156
# completed ticks. `maintenance_sweep_complete` logged every 5s with
# distill_batches_selected 0 AND distill_batches_deferred 0 -- and that second
# zero is the tell: a producer that saw the backlog and took a slice would
# report the remainder deferred. It reports nothing deferred because the query
# genuinely finds nothing processable, so a 189,662-turn backlog and "all caught
# up" print identically. scripts/done-means/625-sweep-heartbeat.sh passes 5/5
# because it gates producer LIVENESS (does a tick complete?), never producer
# YIELD (does a completed tick ever select anything?). The producer was alive
# and idle for 27 days and every check agreed it was fine.
#
# SCOPE. This gate covers producer YIELD only: given undistilled turns, a sweep
# must select some. It does NOT cover distill QUALITY, the recall path (#744),
# ob_session_events visibility (#433), or the client contract (#742). It is
# deliberately independent of any batch bound -- it asserts "more than zero",
# never a specific number, so raising or lowering a bound can never make it pass
# or fail for the wrong reason.
#
# EXPECTED TO FAIL until the window ranks only due turns. It is the reward
# function, not a test of the fix's author.
#
# ---------------------------------------------------------------------------
# Clauses
# ---------------------------------------------------------------------------
# Clause 1 - YIELD. With undistilled live turns present, the REAL selection
#   from this checkout must select at least one batch. FAIL on zero selected
#   while due turns exist.
#
# Clause 2 - NOTHING IS SILENTLY STRANDED. Whatever a tick does not take must be
#   reported as deferred. Selecting zero AND deferring zero while due turns
#   exist is the exit-0 no-op this issue names, and fails regardless of clause 1.
#   This is what stops a "fix" that keeps selecting nothing but starts looking
#   busy.
#
# Both clauses read ONE selection result so they cannot disagree about what the
# tick did.
#
# Output is content-free: counts and statuses only. No turn content.
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

fail_hard() {
  printf 'HARNESS-ERROR: %s\n' "$1" >&2
  exit 3
}

command -v bun >/dev/null 2>&1 || fail_hard "bun not on PATH (runs the sweep probe)"

# .env carries the libpq vars, so bare psql needs no connection arguments.
# See AGENTS.md "Querying the dogfood database".
[ -r "$REPO_ROOT/.env" ] || fail_hard "no .env at $REPO_ROOT/.env; cannot reach the dogfood database"
set -a
# shellcheck disable=SC1091
. "$REPO_ROOT/.env"
set +a
command -v psql >/dev/null 2>&1 || fail_hard "psql not on PATH"
psql -At -c 'select 1' >/dev/null 2>&1 || fail_hard "cannot reach the dogfood database"

# The premise of the whole gate: there must BE undistilled work, or "selected 0"
# is the correct answer and this check would be asserting nothing. Refuse to run
# rather than report a hollow PASS.
DUE_TURNS="$(psql -At -c "select count(*) from ob_raw_turns where distilled_at is null and retention_tier='live'" 2>/dev/null | tr -d '[:space:]')"
printf '%s' "${DUE_TURNS:-}" | grep -Eq '^[0-9]+$' || fail_hard "could not count undistilled turns"
[ "${DUE_TURNS}" -gt 0 ] || fail_hard "no undistilled live turns exist; a sweep selecting zero would be CORRECT, so this gate cannot distinguish a working producer from a broken one. Re-run when there is pending work."

# The probe is written into the repo-scoped scratch bucket rather than the
# checkout, so it never dirties `git status` and needs no delete to clean up
# (agents do not run forced/recursive deletes - Development AGENTS.md).
PROBE_DIR="${OPENBRAIN_SCRATCH:-/Volumes/ThunderBolt/_tmp/open-brain/_scratch}/done-means-747"
mkdir -p "$PROBE_DIR" || fail_hard "cannot create scratch dir $PROBE_DIR"
RUN_ID="$(od -An -N6 -tx1 /dev/urandom | tr -d ' \n')"
PROBE="$PROBE_DIR/probe.$RUN_ID.ts"

# DRY RUN. The probe runs the real selection and reports what a tick WOULD take,
# without enqueuing: this gate must be runnable repeatedly against a live
# dogfood database without mutating the maintenance queue as a side effect of
# being measured.
cat > "$PROBE" <<PROBE_TS
import { Pool } from "pg";
import {
  DISTILL_ORDER_BY,
  DEFAULT_MAX_DISTILL_SESSIONS,
} from "${REPO_ROOT}/src/distill-window.ts";
PROBE_TS
cat >> "$PROBE" <<'PROBE_TS'

const pool = new Pool({
  host: process.env.PGHOST,
  port: Number(process.env.PGPORT ?? 5432),
  database: process.env.PGDATABASE,
  user: process.env.PGUSER,
});

// Mirrors the sweep's own default batch size (src/maintenance-sweep.ts) so the
// probe measures the SAME window the producer would. The gate's assertions
// never reference its value -- clause 1 asserts "more than zero", full stop.
const BATCH_SIZE = 1_500;

// The producer's selection, carried verbatim from selectDistillLaneBatches so a
// drift between gate and product shows up in a diff rather than hiding behind a
// re-implementation.
const SELECTION = `
  WITH due_turns AS (
    SELECT id, lane_id, namespace, session_ref, occurred_at, created_at
      FROM ob_raw_turns
     WHERE distilled_at IS NULL AND retention_tier = 'live'
  ),
  due_sessions AS (
    SELECT lane_id, namespace, session_ref, min(occurred_at) AS first_due
      FROM due_turns GROUP BY lane_id, namespace, session_ref
  ),
  ranked_sessions AS (
    SELECT *, row_number() OVER (
             PARTITION BY lane_id, namespace
             ORDER BY first_due ASC NULLS LAST, session_ref ASC NULLS LAST
           ) AS session_rank
      FROM due_sessions
  ),
  window_turns AS (
    SELECT t.id, t.lane_id, t.namespace, t.session_ref, t.occurred_at,
           t.content_hash, (t.distilled_at IS NULL) AS is_due
      FROM ob_raw_turns t
      JOIN ranked_sessions s
        ON s.lane_id IS NOT DISTINCT FROM t.lane_id
       AND s.namespace = t.namespace
       AND s.session_ref IS NOT DISTINCT FROM t.session_ref
       AND s.session_rank <= $1
     WHERE t.retention_tier = 'live'
  ),
  ranked_window_turns AS (
    SELECT *, row_number() OVER (
             PARTITION BY lane_id, namespace ORDER BY ${DISTILL_ORDER_BY}
           ) AS turn_rank
      FROM window_turns
     WHERE is_due
  ),
  lane_totals AS (
    SELECT lane_id, namespace, count(*)::int AS pending_turns
      FROM due_turns GROUP BY lane_id, namespace
  ),
  due_lanes AS (
    SELECT totals.lane_id, totals.namespace, totals.pending_turns,
           count(*) FILTER (WHERE w.is_due AND w.turn_rank <= $2)::int
             AS processable_turns
      FROM lane_totals totals
      JOIN ranked_window_turns w
        ON w.lane_id IS NOT DISTINCT FROM totals.lane_id
       AND w.namespace = totals.namespace
     GROUP BY totals.lane_id, totals.namespace, totals.pending_turns
    HAVING count(*) FILTER (WHERE w.is_due AND w.turn_rank <= $2) > 0
  )
  SELECT count(*)::int AS batches_selected,
         coalesce(sum(processable_turns), 0)::int AS turns_selected,
         coalesce(sum(pending_turns), 0)::int AS turns_pending_in_selected
    FROM due_lanes`;

// What the window actually contains, so a FAIL names WHY rather than only that
// it happened.
const DIAGNOSIS = `
  WITH due_turns AS (
    SELECT id, lane_id, namespace, session_ref, occurred_at, created_at
      FROM ob_raw_turns
     WHERE distilled_at IS NULL AND retention_tier = 'live'
  ),
  due_sessions AS (
    SELECT lane_id, namespace, session_ref, min(occurred_at) AS first_due
      FROM due_turns GROUP BY lane_id, namespace, session_ref
  ),
  ranked_sessions AS (
    SELECT *, row_number() OVER (
             PARTITION BY lane_id, namespace
             ORDER BY first_due ASC NULLS LAST, session_ref ASC NULLS LAST
           ) AS session_rank
      FROM due_sessions
  ),
  window_turns AS (
    SELECT t.id, t.lane_id, t.namespace, t.session_ref, t.occurred_at,
           (t.distilled_at IS NULL) AS is_due
      FROM ob_raw_turns t
      JOIN ranked_sessions s
        ON s.lane_id IS NOT DISTINCT FROM t.lane_id
       AND s.namespace = t.namespace
       AND s.session_ref IS NOT DISTINCT FROM t.session_ref
       AND s.session_rank <= $1
     WHERE t.retention_tier = 'live'
  ),
  ranked_window_turns AS (
    SELECT *, row_number() OVER (
             PARTITION BY lane_id, namespace ORDER BY ${DISTILL_ORDER_BY}
           ) AS turn_rank
      FROM window_turns
  )
  SELECT count(*) FILTER (WHERE NOT is_due)::int AS already_done_in_window,
         count(*) FILTER (WHERE is_due)::int AS due_in_window,
         coalesce(min(turn_rank) FILTER (WHERE is_due), 0)::int AS min_due_rank
    FROM ranked_window_turns`;

try {
  const sel = (
    await pool.query(SELECTION, [DEFAULT_MAX_DISTILL_SESSIONS, BATCH_SIZE])
  ).rows[0];
  const diag = (
    await pool.query(DIAGNOSIS, [DEFAULT_MAX_DISTILL_SESSIONS])
  ).rows[0];
  const selected = Number(sel.batches_selected ?? 0);
  const turnsSelected = Number(sel.turns_selected ?? 0);
  const pendingInSelected = Number(sel.turns_pending_in_selected ?? 0);
  // Deferred = pending work inside lanes the tick looked at but did not take.
  // A producer that takes some and reports the rest is honest; one that takes
  // none and defers none is the silent no-op this gate exists to catch.
  const deferred = Math.max(pendingInSelected - turnsSelected, 0);
  console.log(
    `RESULT ${selected} ${turnsSelected} ${deferred} ` +
      `${diag.already_done_in_window} ${diag.due_in_window} ${diag.min_due_rank}`,
  );
} catch (err) {
  console.log(`ERR ${err instanceof Error ? err.message : String(err)}`);
} finally {
  await pool.end();
}
PROBE_TS

PROBE_OUT="$(cd "$REPO_ROOT" && bun "$PROBE" 2>&1 | tail -1)"

case "$PROBE_OUT" in
  RESULT\ *) : ;;
  ERR\ *) fail_hard "sweep selection raised: ${PROBE_OUT#ERR }" ;;
  *) fail_hard "probe emitted no parseable result: '$PROBE_OUT'" ;;
esac

read -r _ SELECTED TURNS_SELECTED DEFERRED ALREADY_DONE DUE_IN_WINDOW MIN_DUE_RANK <<EOF2
$PROBE_OUT
EOF2

CLAUSE1=FAIL
CLAUSE2=FAIL
CLAUSE1_EVIDENCE=""
CLAUSE2_EVIDENCE=""

# Clause 1 - yield.
if [ "$SELECTED" -ge 1 ]; then
  CLAUSE1=PASS
  CLAUSE1_EVIDENCE="the real selection took ${SELECTED} batch(es) covering ${TURNS_SELECTED} turn(s) against a backlog of ${DUE_TURNS}"
else
  CLAUSE1_EVIDENCE="STARVED: ${DUE_TURNS} undistilled live turn(s) exist and the selection took 0 batches. Inside the window: ${ALREADY_DONE} already-distilled turn(s) hold rank positions, ${DUE_IN_WINDOW} due turn(s) are present, and the first due turn ranks ${MIN_DUE_RANK}. Already-distilled turns are ranked alongside due ones, so they consume the window and push real work past the batch bound."
fi

# Clause 2 - nothing silently stranded. Evaluated independently of clause 1.
if [ "$SELECTED" -ge 1 ] || [ "$DEFERRED" -gt 0 ]; then
  CLAUSE2=PASS
  CLAUSE2_EVIDENCE="the tick accounts for what it did not take: selected ${TURNS_SELECTED} turn(s), deferred ${DEFERRED}"
else
  CLAUSE2_EVIDENCE="SILENTLY STRANDED: selected 0 AND deferred 0 while ${DUE_TURNS} turn(s) wait. A backlog and 'all caught up' produce identical output, which is why this ran unnoticed."
fi

printf '\n=== DONE-MEANS #747 (distill producer yields work) ===\n'
printf 'undistilled live turns : %s\n' "$DUE_TURNS"
printf 'batches selected       : %s\n' "$SELECTED"
printf 'turns selected         : %s\n' "$TURNS_SELECTED"
printf 'turns deferred         : %s\n' "$DEFERRED"
printf 'window: already-done=%s due=%s first-due-rank=%s\n' "$ALREADY_DONE" "$DUE_IN_WINDOW" "$MIN_DUE_RANK"
printf '\nCLAUSE 1 producer yields work     : %s\n  %s\n' "$CLAUSE1" "$CLAUSE1_EVIDENCE"
printf '\nCLAUSE 2 nothing silently stranded : %s\n  %s\n' "$CLAUSE2" "$CLAUSE2_EVIDENCE"

if [ "$CLAUSE1" = "PASS" ] && [ "$CLAUSE2" = "PASS" ]; then
  printf '\nRESULT: PASS - the producer selects pending work. Distill quality, recall (#744), session-event visibility (#433) and the client contract (#742) are NOT covered by this gate.\n'
  exit 0
fi

printf '\nRESULT: FAIL\n'
exit 1
