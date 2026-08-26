#!/usr/bin/env bash
# DONE-MEANS check for issue #685 (deploy-blocking half) - the acceptance gate.
#
#   bash scripts/done-means/685-live-roles-not-accept-roles.sh
#
# THE DEFECT. `server/capture/liveness-observer.ts` seeds its expected-role set
# from `RAW_TURN_ROLES` (server/domain/raw-turn-roles.ts), which is the set the
# ingest boundary ACCEPTS: user, assistant, tool. Those are two different
# questions, and conflating them is what breaks deploys:
#
#   ACCEPT  - what may arrive. Correctly includes `tool`: the bulk importer
#             emits it (python/openbrain/src/openbrain/apps/bulk/formats.py:345)
#             and the column's CHECK constraint admits it.
#   EXPECT  - what a healthy LIVE lane must be delivering. Cannot include
#             `tool`: the live capture parser has exactly two branches and
#             `else: return None`
#             (python/openbrain/src/openbrain/apps/capture/records.py:365-381),
#             and that is DELIBERATE per
#             docs/decisions/capture-never-drops-a-turn.md:242-253, which parks
#             the question of the machinery underneath and says in terms:
#             "Do not resolve this by inference, and do not let it be resolved
#             by accident."
#
# So the observer permanently and CORRECTLY reports that `tool` delivered
# nothing, and permanently and WRONGLY calls that a fault. Measured 2026-08-25:
# newest `tool` row is 2026-08-01, 24 days stale, zero arrivals in any recent
# window, while user and assistant flow normally.
#
# WHAT IT COSTS. `/health` returns 503 when degraded
# (server/transport/http-app.ts:98) and scripts/local-clone-deploy.sh
# health-checks with `curl -fsS`, which fails on 503. A #747 deploy on
# 2026-08-25 passed its revision proof, ran correctly in production for ~80s
# (selected_batches 1, deferred_turns 188396), then auto-rolled back on this
# check. The rollback machinery worked exactly as designed; the health verdict
# it acted on was wrong.
#
# WORSE, IT IS A COIN FLIP. `silent_roles` is only evaluated when
# sessionsObserved >= MIN_SESSIONS_FOR_SILENCE (liveness-observer.ts:189), so
# whether any given restart lands green depends on session traffic inside the
# observation window. The same deploy rolled back on one restart and passed on
# the next, with no code difference. A deploy gate that depends on traffic
# timing is not a gate.
#
# THE THIRD STREAM IS NOT BEING DROPPED. The agent's own unspoken work -
# reasoning, tool invocations, tool output - ships to Langfuse, which is the
# home the decision doc names at :244. Verified live 2026-08-25: traces
# `session_start`, `claude-code-exchange`, and `ingest_raw_turn` arriving at the
# configured endpoint. This gate asserts that the two SPOKEN roles must be live;
# it takes no position on where the third belongs, which stays parked.
#
# SCOPE. Liveness expectations only. Does NOT change what ingest accepts, does
# NOT change the column constraint, does NOT resolve the parked tool-capture
# question, and does NOT touch the #681 lesson that a role set is declared once
# rather than retyped beside an enum - the live set is DERIVED and pinned as a
# subset of the accept set, not hand-maintained beside it.
#
# EXPECTED TO FAIL until the observer expects live roles instead of accepted
# roles. It is the reward function, not a test of the fix's author.
#
# ---------------------------------------------------------------------------
# Clauses
# ---------------------------------------------------------------------------
# Clause 1 - LIVENESS EXPECTS ONLY SPOKEN ROLES. The observer's expected set is
#   exactly the roles the live lane produces. FAIL if it expects a role no live
#   producer emits.
#
# Clause 2 - THE SETS STAY RELATED. The live-expected set must be a strict
#   subset of the accept set. This is what keeps #681 fixed: a role added to
#   ingest still cannot escape liveness silently, because a live role that is
#   not an accepted role is a contradiction and fails here. FAIL if the live set
#   contains anything the accept set does not.
#
# Clause 3 - A DEGRADED VERDICT REFLECTS A REAL FAULT. With the live lane
#   delivering user and assistant turns and no tool turns, the observer must
#   NOT report a silent-role fault. FAIL if a healthy lane is judged degraded.
#
# Output is content-free: role names and statuses only.
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

fail_hard() {
  printf 'HARNESS-ERROR: %s\n' "$1" >&2
  exit 3
}

command -v bun >/dev/null 2>&1 || fail_hard "bun not on PATH (runs the observer probe)"

PROBE_DIR="${OPENBRAIN_SCRATCH:-/Volumes/ThunderBolt/_tmp/open-brain/_scratch}/done-means-685"
mkdir -p "$PROBE_DIR" || fail_hard "cannot create scratch dir $PROBE_DIR"
RUN_ID="$(od -An -N6 -tx1 /dev/urandom | tr -d ' \n')"
PROBE="$PROBE_DIR/probe.$RUN_ID.ts"

# The probe drives the REAL judgement function with a synthetic observation, so
# it needs no database and cannot be perturbed by live traffic - which is the
# whole point, given the defect is that the current verdict DOES depend on live
# traffic timing.
cat > "$PROBE" <<PROBE_TS
import * as roles from "${REPO_ROOT}/server/domain/raw-turn-roles.ts";
import * as observer from "${REPO_ROOT}/server/capture/liveness-observer.ts";
const RAW_TURN_ROLES = (roles as any).RAW_TURN_ROLES;
PROBE_TS
cat >> "$PROBE" <<'PROBE_TS'

// The live-expected set is read from the module if it exports one. Its ABSENCE
// is the pre-fix state and must read as "still seeded from the accept set",
// never as a crash.
const declaredLive = (roles as any).EXPECTED_LIVE_ROLES;
const liveRoles: string[] =
  declaredLive !== undefined ? [...declaredLive] : [...RAW_TURN_ROLES];

// A healthy lane: both spoken roles delivering, no tool turns, enough sessions
// that the silent-role fault is actually evaluated rather than suppressed.
const judge =
  (observer as any).judgeCaptureObservation ??
  (observer as any).readCaptureLiveness ??
  null;

let silentRoles: string[] | null = null;
if (judge) {
  try {
    const turnsByRole: Record<string, number> = {};
    for (const role of liveRoles) turnsByRole[role] = 0;
    turnsByRole.user = 12;
    turnsByRole.assistant = 40;
    const verdict = judge({
      sessionsObserved: 24,
      watermarkBytesAdvanced: 4096,
      spoolPending: 0,
      outageAnnouncements: 0,
      turnsByRole,
      silenceSeconds: 5,
    });
    silentRoles = [...(verdict?.silent_roles ?? [])];
  } catch {
    silentRoles = null;
  }
}

console.log(
  JSON.stringify({
    accept: [...RAW_TURN_ROLES],
    live: liveRoles,
    exportsLiveSet: declaredLive !== undefined,
    silentRoles,
  }),
);
PROBE_TS

PROBE_OUT="$(cd "$REPO_ROOT" && bun "$PROBE" 2>&1 | tail -1)"
case "$PROBE_OUT" in
  \{*) : ;;
  *) fail_hard "probe emitted no parseable result: '$PROBE_OUT'" ;;
esac

read_field() {
  printf '%s' "$PROBE_OUT" | python3 -c "import json,sys;d=json.load(sys.stdin);v=d.get('$1');print('' if v is None else (','.join(v) if isinstance(v,list) else v))"
}

ACCEPT="$(read_field accept)"
LIVE="$(read_field live)"
EXPORTS_LIVE="$(read_field exportsLiveSet)"
SILENT="$(read_field silentRoles)"

# The roles the live capture lane actually produces, read from the parser rather
# than asserted here: records.py has exactly two role branches.
PARSER="python/openbrain/src/openbrain/apps/capture/records.py"
[ -r "$REPO_ROOT/$PARSER" ] || fail_hard "cannot read $PARSER to determine which roles the live lane produces"
PRODUCES_TOOL=no
grep -q 'TurnRole\.TOOL' "$REPO_ROOT/$PARSER" && PRODUCES_TOOL=yes

CLAUSE1=FAIL; CLAUSE1_EVIDENCE=""
CLAUSE2=FAIL; CLAUSE2_EVIDENCE=""
CLAUSE3=FAIL; CLAUSE3_EVIDENCE=""

# Clause 1 - liveness expects only roles a live producer emits.
UNPRODUCED=""
case ",$LIVE," in
  *,tool,*)
    if [ "$PRODUCES_TOOL" = "no" ]; then UNPRODUCED="tool"; fi
    ;;
esac
if [ -z "$UNPRODUCED" ]; then
  CLAUSE1=PASS
  CLAUSE1_EVIDENCE="the observer expects [${LIVE}], and every one of those roles has a live producer"
else
  CLAUSE1_EVIDENCE="EXPECTS AN UNPRODUCED ROLE: the observer expects [${LIVE}] but ${PARSER} has no TurnRole.${UNPRODUCED} branch, so the live lane cannot emit '${UNPRODUCED}' by design (capture-never-drops-a-turn.md:242-253 parks it). The observer will report it silent forever, /health will return 503, and every deploy rolls back."
fi

# Clause 2 - the live set stays a subset of the accept set (#681 stays fixed).
ORPHAN=""
OLDIFS="$IFS"; IFS=','
for role in $LIVE; do
  case ",$ACCEPT," in
    *,"$role",*) : ;;
    *) ORPHAN="$role" ;;
  esac
done
IFS="$OLDIFS"
if [ -z "$ORPHAN" ]; then
  CLAUSE2=PASS
  CLAUSE2_EVIDENCE="live [${LIVE}] is a subset of accept [${ACCEPT}]; a role added to ingest still cannot escape liveness silently"
else
  CLAUSE2_EVIDENCE="ORPHANED ROLE: live expects '${ORPHAN}', which the ingest boundary does not accept. A role the observer demands and the boundary rejects can never arrive."
fi

# Clause 3 - a healthy lane is not judged degraded.
if [ -z "$SILENT" ]; then
  CLAUSE3=PASS
  CLAUSE3_EVIDENCE="a lane delivering user and assistant turns, with no tool turns, raises no silent-role fault"
else
  CLAUSE3_EVIDENCE="HEALTHY LANE JUDGED DEGRADED: silent_roles=[${SILENT}] while both spoken roles were delivering. This is the 503 that rolls back deploys."
fi

printf '\n=== DONE-MEANS #685 (liveness expects live roles, not accepted roles) ===\n'
printf 'accept set (ingest)   : %s\n' "$ACCEPT"
printf 'live-expected set     : %s\n' "$LIVE"
printf 'module exports it     : %s\n' "$EXPORTS_LIVE"
printf 'live lane emits tool  : %s (from %s)\n' "$PRODUCES_TOOL" "$PARSER"
printf 'silent_roles verdict  : %s\n' "${SILENT:-none}"
printf '\nCLAUSE 1 expects only produced roles : %s\n  %s\n' "$CLAUSE1" "$CLAUSE1_EVIDENCE"
printf '\nCLAUSE 2 live is a subset of accept  : %s\n  %s\n' "$CLAUSE2" "$CLAUSE2_EVIDENCE"
printf '\nCLAUSE 3 healthy lane is not degraded: %s\n  %s\n' "$CLAUSE3" "$CLAUSE3_EVIDENCE"

if [ "$CLAUSE1" = "PASS" ] && [ "$CLAUSE2" = "PASS" ] && [ "$CLAUSE3" = "PASS" ]; then
  printf '\nRESULT: PASS - liveness reasons over what the live lane produces. Where the third stream (reasoning, tool calls, tool output) belongs is NOT decided by this gate; it ships to Langfuse and the question stays parked.\n'
  exit 0
fi

printf '\nRESULT: FAIL\n'
exit 1
