#!/usr/bin/env bash
# DONE-MEANS check for issue #747, SECOND LOCATION - the acceptance gate.
#
#   bash scripts/done-means/747-distill-claim-yields.sh
#
# THE DEFECT, and it is the #747 shape one layer down. `selectDistillLaneBatches`
# (src/maintenance-sweep.ts) decides WHICH lanes have work; `claimDistillBatch`
# (src/distill-window.ts) then claims the actual turns a handler will consume.
# Fixing the first without the second buys nothing: the producer enqueues, the
# handler claims a batch containing no due turns, stamps nothing, and reports
# success.
#
# The claim reads each due session WHOLE and then bounds the result:
#
#     SELECT t.id, ..., (t.distilled_at IS NULL) AS is_due
#       FROM ob_raw_turns t JOIN due_sessions d ON ...
#      WHERE t.retention_tier = 'live'...
#      ORDER BY session_ref NULLS LAST, occurred_at NULLS LAST, id
#      LIMIT <maxTurns>
#
# Reading whole sessions is CORRECT and deliberate: already-distilled turns are
# the read-only context that makes a short current turn interpretable, which is
# the entire premise of distill-window.ts (a 9-character "go for it" carries no
# claim alone and is an authorization after the two turns before it). The defect
# is that the bound is applied to the COMBINED set, so in a long-running session
# the context fills the window and the due turns fall off the end.
#
# Measured on the live dogfood corpus as the service role, 2026-08-25, with the
# production parameters (maxSessions=4, maxTurns=1500):
#
#     due_in_claim     : 0
#     context_in_claim : 1500
#     total_in_claim   : 1500
#
# A claim of 1,500 turns containing nothing to do.
#
# WHAT IT COSTS, and why it looks like success. `runDistillSweep` stamps
# `distilled_at` only `if (consumedTurnIds.length > 0)`
# (src/distill-handler.ts). An empty claim skips stamping, the job completes,
# and the queue records `succeeded`. Measured: 392 succeeded `memory.distill`
# jobs against ZERO turns stamped since 2026-08-24.
#
# It also wedges the producer, which is the part that hides it completely. The
# enqueue key is `<batchHash>:s<maxSessions>:t<maxTurns>` over the DUE turns, and
# the queue is `ON CONFLICT (job_kind, idempotency_key) DO NOTHING`
# (src/maintenance-queue.ts). The code says the quiet part out loud: "consuming
# any due turn changes the watermark, so a succeeded job cannot block the lane's
# next window." That is true only if something consumes. Nothing does, so the
# hash never changes, every subsequent enqueue is silently dropped, and the
# sweep still logs `distill_jobs_enqueued: 1` on every tick. Newest job row:
# 02:19, four hours before a deploy whose logs claimed an enqueue every 5s.
#
# SCOPE. The CLAIM boundary only: given due turns, a claim must contain some.
# Does NOT cover producer selection (747-distill-sweep-yields.sh), distill
# QUALITY, recall (#744), session-event visibility (#433), or the client
# contract (#742). Asserts "more than zero" and never a specific number, so no
# bound change can make it pass or fail for the wrong reason.
#
# EXPECTED TO FAIL until the claim guarantees due turns in its window. It is the
# reward function, not a test of the fix's author.
#
# ---------------------------------------------------------------------------
# Clauses
# ---------------------------------------------------------------------------
# Clause 1 - THE CLAIM CONTAINS WORK. With undistilled live turns present, a
#   claim must contain at least one due turn. FAIL on a claim that is entirely
#   context.
#
# Clause 2 - CONTEXT SURVIVES. The claim must still carry already-distilled
#   turns as context. This is what stops a "fix" that simply filters the claim
#   to due turns only: that would make clause 1 pass and silently destroy the
#   interpretability the windowing exists for.
#
# Output is content-free: counts and statuses only. No turn content.
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

fail_hard() {
  printf 'HARNESS-ERROR: %s\n' "$1" >&2
  exit 3
}

command -v bun >/dev/null 2>&1 || fail_hard "bun not on PATH (runs the claim probe)"

[ -r "$REPO_ROOT/.env" ] || fail_hard "no .env at $REPO_ROOT/.env; cannot reach the dogfood database"
set -a
# shellcheck disable=SC1091
. "$REPO_ROOT/.env"
set +a
command -v psql >/dev/null 2>&1 || fail_hard "psql not on PATH"
psql -At -c 'select 1' >/dev/null 2>&1 || fail_hard "cannot reach the dogfood database"

# The premise: there must BE due work in a session that also has context, or an
# empty claim is the correct answer and this gate asserts nothing.
DUE_TURNS="$(psql -At -c "select count(*) from ob_raw_turns where distilled_at is null and retention_tier='live'" 2>/dev/null | tr -d '[:space:]')"
printf '%s' "${DUE_TURNS:-}" | grep -Eq '^[0-9]+$' || fail_hard "could not count undistilled turns"
[ "${DUE_TURNS}" -gt 0 ] || fail_hard "no undistilled live turns exist; an empty claim would be CORRECT, so this gate cannot distinguish a working claim from a broken one."

PROBE_DIR="${OPENBRAIN_SCRATCH:-/Volumes/ThunderBolt/_tmp/open-brain/_scratch}/done-means-747-claim"
mkdir -p "$PROBE_DIR" || fail_hard "cannot create scratch dir $PROBE_DIR"
RUN_ID="$(od -An -N6 -tx1 /dev/urandom | tr -d ' \n')"
PROBE="$PROBE_DIR/probe.$RUN_ID.ts"

# Drives the REAL claimDistillBatch. It claims nothing durably -- the function
# reads and returns units; stamping happens in the handler -- so this gate is
# repeatable against the live dogfood database without consuming work.
cat > "$PROBE" <<PROBE_TS
import { Pool } from "pg";
import * as window from "${REPO_ROOT}/src/distill-window.ts";
PROBE_TS
cat >> "$PROBE" <<'PROBE_TS'

const pool = new Pool({
  host: process.env.PGHOST,
  port: Number(process.env.PGPORT ?? 5432),
  database: process.env.PGDATABASE,
  user: process.env.PGUSER,
});

// The namespace carrying the backlog, chosen from the data rather than named
// here: this gate must hold for every user, not one.
const target = (
  await pool.query(
    `SELECT namespace FROM ob_raw_turns
      WHERE distilled_at IS NULL AND retention_tier = 'live'
      GROUP BY namespace ORDER BY count(*) DESC LIMIT 1`,
  )
).rows[0]?.namespace as string | undefined;

const claim =
  (window as any).claimDistillBatch ?? (window as any).claimDistillTurns ?? null;

try {
  if (!target) {
    console.log("RESULT 0 0 none");
  } else if (!claim) {
    console.log("RESULT ERR ERR no-claim-export");
  } else {
    const batch = await claim(pool, {
      namespace: target,
      laneId: null,
      maxSessions: 4,
      maxTurns: 1500,
      contextWindow: (window as any).DEFAULT_CONTEXT_WINDOW ?? 3,
    });
    // A claim returns units (current + context) or a flat turn list depending
    // on the shape; count due and context across whichever came back.
    const units: any[] = Array.isArray(batch)
      ? batch
      : (batch?.units ?? batch?.turns ?? []);
    let due = 0;
    let context = 0;
    const seen = new Set<string>();
    for (const unit of units) {
      const current = unit?.current ?? unit;
      if (current?.id && !seen.has(current.id)) {
        seen.add(current.id);
        due++;
      }
      for (const c of unit?.context ?? []) {
        if (c?.id && !seen.has(c.id)) {
          seen.add(c.id);
          context++;
        }
      }
    }
    console.log(`RESULT ${due} ${context} ${target}`);
  }
} catch (err) {
  console.log(`RESULT ERR ERR ${err instanceof Error ? err.message : String(err)}`);
} finally {
  await pool.end();
}
PROBE_TS

PROBE_OUT="$(cd "$REPO_ROOT" && bun "$PROBE" 2>&1 | tail -1)"
case "$PROBE_OUT" in
  RESULT\ *) : ;;
  *) fail_hard "probe emitted no parseable result: '$PROBE_OUT'" ;;
esac

read -r _ DUE_IN_CLAIM CONTEXT_IN_CLAIM TARGET <<EOF2
$PROBE_OUT
EOF2

[ "$DUE_IN_CLAIM" = "ERR" ] && fail_hard "claim raised or is unavailable: ${TARGET}"

# What the raw claim window looks like, so a FAIL names why. This mirrors the
# claim's own bounding so the numbers are comparable.
RAW="$(psql -At -F' ' -c "
  WITH due_sessions AS (
    SELECT session_ref, min(occurred_at) AS first_due
      FROM ob_raw_turns
     WHERE distilled_at IS NULL AND retention_tier='live'
       AND namespace='${TARGET}' AND lane_id IS NULL
     GROUP BY session_ref ORDER BY first_due ASC NULLS LAST LIMIT 4)
  SELECT count(*) FILTER (WHERE t.distilled_at IS NULL),
         count(*) FILTER (WHERE t.distilled_at IS NOT NULL)
    FROM (SELECT t.* FROM ob_raw_turns t JOIN due_sessions d
            ON t.session_ref IS NOT DISTINCT FROM d.session_ref
           WHERE t.retention_tier='live' AND t.namespace='${TARGET}'
             AND t.lane_id IS NULL
           ORDER BY session_ref NULLS LAST, occurred_at NULLS LAST, id
           LIMIT 1500) t" 2>/dev/null)"
RAW_DUE="$(printf '%s' "$RAW" | awk '{print $1}')"
RAW_CONTEXT="$(printf '%s' "$RAW" | awk '{print $2}')"

CLAUSE1=FAIL; CLAUSE1_EVIDENCE=""
CLAUSE2=FAIL; CLAUSE2_EVIDENCE=""

if [ "${DUE_IN_CLAIM:-0}" -ge 1 ]; then
  CLAUSE1=PASS
  CLAUSE1_EVIDENCE="the claim carries ${DUE_IN_CLAIM} due turn(s) against a backlog of ${DUE_TURNS} in namespace ${TARGET}"
else
  CLAUSE1_EVIDENCE="EMPTY OF WORK: ${DUE_TURNS} undistilled live turn(s) exist and the claim contains 0 due turns. The raw claim window holds ${RAW_DUE:-?} due and ${RAW_CONTEXT:-?} already-distilled turn(s): already-distilled context fills the bound and the due turns fall off the end. The handler stamps only when consumedTurnIds is non-empty, so the job completes as 'succeeded' having done nothing, and its unchanged batch hash then blocks every later enqueue via ON CONFLICT DO NOTHING."
fi

if [ "${CONTEXT_IN_CLAIM:-0}" -ge 1 ]; then
  CLAUSE2=PASS
  CLAUSE2_EVIDENCE="context is preserved: ${CONTEXT_IN_CLAIM} already-distilled turn(s) accompany the due work, so a short current turn stays interpretable"
elif [ "${DUE_IN_CLAIM:-0}" -ge 1 ]; then
  CLAUSE2_EVIDENCE="CONTEXT LOST: the claim carries due turns but no already-distilled context. Filtering the claim to due turns only would satisfy clause 1 and destroy the interpretability distill-window.ts exists to provide."
else
  CLAUSE2_EVIDENCE="not assessed: the claim carries no due work, so whether context accompanies it is not yet a meaningful question."
fi

printf '\n=== DONE-MEANS #747 (the distill CLAIM carries work) ===\n'
printf 'namespace under test  : %s\n' "$TARGET"
printf 'undistilled live turns: %s\n' "$DUE_TURNS"
printf 'due turns in claim    : %s\n' "$DUE_IN_CLAIM"
printf 'context turns in claim: %s\n' "$CONTEXT_IN_CLAIM"
printf 'raw claim window      : due=%s context=%s\n' "${RAW_DUE:-?}" "${RAW_CONTEXT:-?}"
printf '\nCLAUSE 1 claim contains work : %s\n  %s\n' "$CLAUSE1" "$CLAUSE1_EVIDENCE"
printf '\nCLAUSE 2 context survives    : %s\n  %s\n' "$CLAUSE2" "$CLAUSE2_EVIDENCE"

if [ "$CLAUSE1" = "PASS" ] && [ "$CLAUSE2" = "PASS" ]; then
  printf '\nRESULT: PASS - the claim carries due work with its context. Producer selection, distill quality, recall (#744), session-event visibility (#433) and the client contract (#742) are NOT covered by this gate.\n'
  exit 0
fi

printf '\nRESULT: FAIL\n'
exit 1
