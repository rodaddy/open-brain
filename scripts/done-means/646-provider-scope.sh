#!/usr/bin/env bash
# DONE-MEANS check for issue #646 — the acceptance gate, not the fix.
#
#   bash scripts/done-means/646-provider-scope.sh
#
# Issue #646, as measured live from a head session on 2026-08-08:
#
#   capture fails with
#     "session_start result did not prove exact Open Brain scope:
#      agent, channel_id, server_id, source"
#   but adding `source` to the scope — the key that error names — fails with
#     "scope contains unsupported keys: source"
#
# The provider demands a key it rejects, so a head session cannot capture by
# ANY spelling. That is the contradiction this gate measures.
#
# ---------------------------------------------------------------------------
# The existing design, and the delta
# ---------------------------------------------------------------------------
# docs/agent-context-pack-contract.md:99-105 defines the exact scope key as
#   namespace + agent + platform + server_id + channel_id + thread_id + session_key
# and :671-674 restates it as a CLOSED set ("not a subset"). `platform` is the
# contract vocabulary; `source` is not in it. `source` is the server's storage
# spelling of the same element (src/tools/session-start.ts:9,45,58,84). So a
# user-facing error naming `source` is naming a key the contract does not have
# and the request allowlist cannot accept. Nothing here proposes a new
# vocabulary — the gate holds the provider to the one already written down.
#
# ---------------------------------------------------------------------------
# The mechanism (from source + a controlled live reproduction)
# ---------------------------------------------------------------------------
# There is no single "source vs platform" typo. Two facts combine:
#
#   1. validate_started_lane mirrors the rename before comparing
#      (_runtime_validation.py:93-94: expected["source"] = expected.pop("platform")),
#      so the COMPARISON is right — but validate_exact_fields reports mismatched
#      names using the RESPONSE vocabulary (_runtime_validation.py:682-690).
#      The operator is therefore told to supply `source`, while the request
#      allowlist `_SCOPE_KEYS` accepts only `platform` (runtime.py:109-116).
#      The message is a FALSE INSTRUCTION: it names a key no request may carry.
#
#   2. The mismatch itself is real, and is NOT caused by the naming. A lane
#      that already exists with a CONFLICTING `agent` and NULL scope columns —
#      exactly the shape head sessions leave behind, `agent='openbrain-capture'`
#      with source/channel_id/server_id NULL — cannot be backfilled, because
#      establishExactStartScope guards on
#      `(agent IS NULL OR agent = $3)` (src/tools/session-start.ts:57).
#      The UPDATE matches zero rows, and the four fields stay unproven.
#
# So a fix that only renames the message is not enough to make capture work,
# and a fix that only makes capture work still leaves the misleading message.
# This gate requires BOTH, which is why clause (c) exists separately from (b).
#
# ---------------------------------------------------------------------------
# Clauses
# ---------------------------------------------------------------------------
#   (a) RED-ANCHOR — the contradiction, captured verbatim from the live path:
#       a capture into a partial-scope lane fails naming `source`, AND a
#       capture that supplies `source` is rejected for containing it. Both
#       halves are observed in the SAME run, from separate invocations, since
#       either half alone proves nothing.
#
#       This clause INVERTS at the fix: pre-fix both halves are observed and
#       the clause reports the contradiction as PRESENT (gate FAILS); post-fix
#       the contradiction must be ABSENT. It is the red anchor, not a test
#       that the bug still exists.
#
#   (b) CAPTURE SUCCEEDS — a capture with a DOCUMENTED scope spelling, into
#       the very lane shape that fails today, returns durable:true and lands a
#       real row in ob_session_events. End-to-end against the live service.
#
#   (c) ERRORS NAME ONLY ACCEPTED KEYS — any scope-proof error the provider
#       emits names keys drawn from the REQUEST vocabulary (_SCOPE_KEYS), never
#       `source`. Driven by a deliberately-unsatisfiable scope so a real error
#       string is produced rather than assumed.
#
#   (d) CONTROL — the healthy path stays healthy: a capture into a fresh lane
#       with full scope still succeeds. Without this, "fixing" the gate by
#       loosening the validator into a no-op would pass (a)-(c).
#
# Output is content-free apart from a random run marker: statuses, keys, and
# counts only. No tokens, no memory bodies.
#
# EXPECTED TO FAIL until #646 is fixed. It is the reward function, not a test
# of the fix's author.
set -uo pipefail

REPO_ROOT="${OPENBRAIN_REPO_ROOT:-/Volumes/ThunderBolt/Development/open-brain}"
CLI="${OPENBRAIN_CLI:-$HOME/.local/bin/openbrain-memory}"
ENV_FILE="${OPENBRAIN_ENV_FILE:-$HOME/.local/share/openbrain-memory/env/claudex-observation.env}"

fail_hard() {
  printf 'HARNESS-ERROR: %s\n' "$1" >&2
  exit 3
}

[ -x "$CLI" ] || fail_hard "operator CLI not executable at $CLI"
[ -r "$ENV_FILE" ] || fail_hard "provider env file not readable at $ENV_FILE"
command -v python3 >/dev/null 2>&1 || fail_hard "python3 not on PATH (JSON reader)"

set -a
# shellcheck disable=SC1090
. "$ENV_FILE"
set +a

RUN_ID="$(od -An -N6 -tx1 /dev/urandom | tr -d ' \n')"
MARKER="rlvr646-${RUN_ID}"

# Isolation is by throwaway LANE, not throwaway namespace. The server derives
# namespace from the bearer token (`"namespace_source":"token"`), so overriding
# OPENBRAIN_NAMESPACE does not steer the write — it only makes every capture
# die at the scope gate on `namespace`, which LOOKS like a red-anchor hit while
# never exercising the path #646 is about. That false green is documented in
# scripts/done-means/598-capture-receipt.sh and is deliberately avoided here.
PARTIAL_KEY="done-means-646-partial-${RUN_ID}"
FRESH_KEY="done-means-646-fresh-${RUN_ID}"
IMPOSSIBLE_KEY="done-means-646-impossible-${RUN_ID}"

# The shape head sessions actually leave behind, verified on the dogfood DB
# 2026-08-08: 2011 lanes with `agent` SET and source/channel_id/server_id NULL.
#
# The partial lane carries the SAME agent the capture will send. That is the
# real-world case and the one the fix must serve: the agent identity is the one
# scope field a lane does get at creation, and the contract is explicit that a
# DIFFERENT agent must be denied working-set context
# (docs/agent-context-pack-contract.md:537). An earlier draft of this gate
# seeded a CONFLICTING agent and then read the resulting (correct) refusal as a
# clause-(b) failure — the fixture was wrong, not the server. The conflicting
# case is still exercised, deliberately, by the IMPOSSIBLE lane in clause (c).
REQ_AGENT="done-means-646"
STALE_AGENT="$REQ_AGENT"

scope_json() { # scope_json <session_key> [extra_kv_json]
  printf '{"agent":"%s","platform":"cli","channel_id":"done-means","server_id":"done-means","session_key":"%s"%s}' \
    "$REQ_AGENT" "$1" "${2:-}"
}

# --- database access (fixture + row proof + teardown) -----------------------
# .env carries the libpq vars, so bare psql needs no connection arguments.
# See AGENTS.md "Querying the dogfood database".
DB_OK=0
if [ -r "$REPO_ROOT/.env" ]; then
  set -a
  # shellcheck disable=SC1091
  . "$REPO_ROOT/.env"
  set +a
  if command -v psql >/dev/null 2>&1 && psql -At -c 'select 1' >/dev/null 2>&1; then
    DB_OK=1
  fi
fi
[ "$DB_OK" -eq 1 ] || fail_hard "cannot reach the dogfood database; the partial-lane fixture, the row proof, and teardown are all impossible, so a PASS could not be trusted"

NS="${OPENBRAIN_NAMESPACE:-rico}"

lane_pred() { printf "lane_id in (select id from ob_session_lanes where session_key = '%s')" "$1"; }

# Teardown removes exactly this run's lanes and their events, and nothing else:
# every session_key carries the random RUN_ID, so collision with real data is
# not possible.
teardown() {
  for k in "$PARTIAL_KEY" "$FRESH_KEY" "$IMPOSSIBLE_KEY"; do
    psql -At -c "delete from ob_session_events where $(lane_pred "$k");" >/dev/null 2>&1
    psql -At -c "delete from ob_session_lanes where session_key = '$k';" >/dev/null 2>&1
  done
}
trap teardown EXIT

# Seed the partial-scope lane: the exact shape a head session leaves behind.
psql -At -c "insert into ob_session_lanes (session_key, namespace, status, agent, created_by) values ('$PARTIAL_KEY', '$NS', 'active', '$STALE_AGENT', 'done-means-646');" >/dev/null 2>&1 \
  || fail_hard "could not seed the partial-scope lane fixture"

SEEDED="$(psql -At -c "select count(*) from ob_session_lanes where session_key='$PARTIAL_KEY' and agent='$STALE_AGENT' and source is null and channel_id is null;" 2>/dev/null | tr -d '[:space:]')"
[ "$SEEDED" = "1" ] || fail_hard "partial-scope fixture did not materialize as expected (count=${SEEDED:-0})"

# A lane whose scope columns are populated with values that can never match the
# request: the backfill guard cannot rewrite a non-NULL conflicting value, so a
# real scope-proof error is produced for clause (c) to read.
psql -At -c "insert into ob_session_lanes (session_key, namespace, status, agent, source, channel_id, created_by) values ('$IMPOSSIBLE_KEY', '$NS', 'active', 'not-the-requested-agent', 'not-cli', 'not-done-means', 'done-means-646');" >/dev/null 2>&1 \
  || fail_hard "could not seed the unsatisfiable-scope lane fixture"

receipt_field() {
  printf '%s' "$1" | python3 -c '
import json,sys
raw=sys.stdin.read()
try:
    d=json.loads(raw)
except Exception:
    print(""); sys.exit(0)
r=d.get("receipt") if isinstance(d,dict) else None
if not isinstance(r,dict):
    print(""); sys.exit(0)
v=r.get(sys.argv[1])
if v is None:
    print("")
elif isinstance(v,(list,tuple)):
    print(",".join(str(x) for x in v))
elif isinstance(v,bool):
    print("true" if v else "false")
else:
    print(v)
' "$2" 2>/dev/null
}

row_count_for() { # row_count_for <session_key> <marker>
  local n
  n="$(psql -At -c "select count(*) from ob_session_events where $(lane_pred "$1") and content like '%$2%';" 2>/dev/null | tr -d '[:space:]')"
  printf '%s' "${n:-0}"
}

capture() { # capture <session_key> <marker> [extra_scope_kv]
  printf '{"operation":"capture","distilled":true,"event_type":"fact","content":"%s done-means 646 probe","scope":%s}' \
    "$2" "$(scope_json "$1" "${3:-}")" | "$CLI" 2>/dev/null
}

printf '=== done-means #646 — provider scope contradiction (run %s) ===\n' "$RUN_ID"

# ---------------------------------------------------------------------------
# Clause (a) — the contradiction, both halves, same run.
# ---------------------------------------------------------------------------
M_A="${MARKER}-a"
OUT_DEMAND="$(capture "$PARTIAL_KEY" "$M_A")"
ERR_DEMAND="$(receipt_field "$OUT_DEMAND" error)"

OUT_REJECT="$(capture "$PARTIAL_KEY" "${MARKER}-a2" ',"source":"cli"')"
ERR_REJECT="$(receipt_field "$OUT_REJECT" error)"

DEMANDS_SOURCE=0
case "$ERR_DEMAND" in
  *"did not prove exact Open Brain scope"*source*) DEMANDS_SOURCE=1 ;;
esac

REJECTS_SOURCE=0
case "$ERR_REJECT" in
  *"unsupported keys"*source*) REJECTS_SOURCE=1 ;;
esac

if [ "$DEMANDS_SOURCE" -eq 1 ] && [ "$REJECTS_SOURCE" -eq 1 ]; then
  CLAUSE_A=FAIL
  CLAUSE_A_EVIDENCE="CONTRADICTION PRESENT — demand: [$ERR_DEMAND] / reject: [$ERR_REJECT]"
elif [ "$DEMANDS_SOURCE" -eq 1 ]; then
  CLAUSE_A=FAIL
  CLAUSE_A_EVIDENCE="scope proof still demands 'source': [$ERR_DEMAND]"
elif [ "$REJECTS_SOURCE" -eq 1 ]; then
  # Rejecting an unknown key is CORRECT on its own; it is only half of a
  # contradiction when something also demands it. Not a failure alone.
  CLAUSE_A=PASS
  CLAUSE_A_EVIDENCE="no demand for 'source'; rejecting the unknown key remains correct: [$ERR_REJECT]"
else
  CLAUSE_A=PASS
  CLAUSE_A_EVIDENCE="contradiction absent — demand-half error: [${ERR_DEMAND:-<none>}]"
fi

# ---------------------------------------------------------------------------
# Clause (b) — capture into the partial lane succeeds, durable + real row.
# ---------------------------------------------------------------------------
STATUS_B="$(receipt_field "$OUT_DEMAND" status)"
DURABLE_B="$(receipt_field "$OUT_DEMAND" durable)"
ROWS_B="$(row_count_for "$PARTIAL_KEY" "$M_A")"

if [ "$DURABLE_B" = "true" ] && [ "$ROWS_B" -ge 1 ]; then
  CLAUSE_B=PASS
  CLAUSE_B_EVIDENCE="status=$STATUS_B durable=true, ob_session_events rows=$ROWS_B in the partial-scope lane"
else
  CLAUSE_B=FAIL
  CLAUSE_B_EVIDENCE="status=${STATUS_B:-<none>} durable=${DURABLE_B:-<none>} rows=$ROWS_B error=[${ERR_DEMAND:-<none>}]"
fi

# ---------------------------------------------------------------------------
# Clause (c) — scope-proof errors name only REQUEST-vocabulary keys.
# ---------------------------------------------------------------------------
OUT_C="$(capture "$IMPOSSIBLE_KEY" "${MARKER}-c")"
ERR_C="$(receipt_field "$OUT_C" error)"
DURABLE_C="$(receipt_field "$OUT_C" durable)"

case "$ERR_C" in
  *"did not prove exact Open Brain scope"*)
    case "$ERR_C" in
      *source*)
        CLAUSE_C=FAIL
        CLAUSE_C_EVIDENCE="scope-proof error names 'source', which no request may carry: [$ERR_C]"
        ;;
      *)
        CLAUSE_C=PASS
        CLAUSE_C_EVIDENCE="scope-proof error names only request-vocabulary keys: [$ERR_C]"
        ;;
    esac
    ;;
  "")
    if [ "$DURABLE_C" = "true" ]; then
      # The unsatisfiable lane was somehow satisfied. That is a loosened
      # validator, not a fix — this is the mutation clause (d) cannot catch.
      CLAUSE_C=FAIL
      CLAUSE_C_EVIDENCE="a deliberately-unsatisfiable scope captured durably; the validator appears loosened into a no-op"
    else
      CLAUSE_C=FAIL
      CLAUSE_C_EVIDENCE="no error string surfaced for a deliberately-unsatisfiable scope, and nothing was stored; the failure is unnamed"
    fi
    ;;
  *)
    CLAUSE_C=PASS
    CLAUSE_C_EVIDENCE="failure surfaced without the misleading scope-proof wording: [$ERR_C]"
    ;;
esac

# ---------------------------------------------------------------------------
# Clause (d) — CONTROL: the healthy path stays healthy.
# ---------------------------------------------------------------------------
M_D="${MARKER}-d"
OUT_D="$(capture "$FRESH_KEY" "$M_D")"
STATUS_D="$(receipt_field "$OUT_D" status)"
DURABLE_D="$(receipt_field "$OUT_D" durable)"
ROWS_D="$(row_count_for "$FRESH_KEY" "$M_D")"

if [ "$DURABLE_D" = "true" ] && [ "$ROWS_D" -ge 1 ]; then
  CLAUSE_D=PASS
  CLAUSE_D_EVIDENCE="fresh-lane capture still healthy: status=$STATUS_D durable=true rows=$ROWS_D"
else
  CLAUSE_D=FAIL
  CLAUSE_D_EVIDENCE="fresh-lane capture REGRESSED: status=${STATUS_D:-<none>} durable=${DURABLE_D:-<none>} rows=$ROWS_D error=[$(receipt_field "$OUT_D" error)]"
fi

printf '  (a) contradiction absent       : %s — %s\n' "$CLAUSE_A" "$CLAUSE_A_EVIDENCE"
printf '  (b) capture succeeds end-to-end: %s — %s\n' "$CLAUSE_B" "$CLAUSE_B_EVIDENCE"
printf '  (c) errors name accepted keys  : %s — %s\n' "$CLAUSE_C" "$CLAUSE_C_EVIDENCE"
printf '  (d) control, healthy stays ok  : %s — %s\n' "$CLAUSE_D" "$CLAUSE_D_EVIDENCE"

if [ "$CLAUSE_A" = PASS ] && [ "$CLAUSE_B" = PASS ] && [ "$CLAUSE_C" = PASS ] && [ "$CLAUSE_D" = PASS ]; then
  printf 'DONE-MEANS 646: PASS\n'
  exit 0
fi
printf 'DONE-MEANS 646: FAIL\n'
exit 1
