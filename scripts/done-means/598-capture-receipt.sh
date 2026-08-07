#!/usr/bin/env bash
# DONE-MEANS check for issue #598 — the acceptance gate, not the fix.
#
#   bash scripts/done-means/598-capture-receipt.sh
#
# Issue #598 acceptance, verbatim:
#   "operator-invoked capture either produces a durable receipt or exits
#    non-zero with the named reason; `kind` is either honored per contract or
#    rejected by name."
#
# This script drives the LIVE operator path — the installed console script
# `openbrain-memory` (python/openbrain-memory pyproject [project.scripts]) —
# with real credentials, under a THROWAWAY namespace it seeds and tears down
# itself, following the discipline of scripts/eval-open-brain-live.ts:1-30.
# The retired TS adapter (ob-memory-provider.ts) is NOT exercised: it lives in
# ~/.local/share/openbrain-memory/_archive/420-cutover-retired-20260801/ and is
# no longer the operator path.
#
# Output is content-free apart from a random run marker: statuses, keys, and
# counts only. No tokens, no memory bodies.
#
# EXPECTED TO FAIL until #598 is fixed. It is the reward function, not a test
# of the fix's author.
#
# ---------------------------------------------------------------------------
# What "durable receipt" means here, and why
# ---------------------------------------------------------------------------
# Clause 1 accepts EITHER of two outcomes, because the runtime itself defines
# two legitimate durable resting places:
#
#   (a) status `saved`/`fallback` with durable=true AND a matching row in
#       ob_session_events. This is the strong form: durable in the database.
#
#   (b) status `spooled` with durable=true AND a non-empty `spool_key`. The
#       runtime documents this as durable-on-disk, not durable-in-DB:
#       runtime.py:429-433 — "they report durable=True because the unit's
#       redacted lines still exist on disk ... the write was not delivered, but
#       it was not lost". runtime.py:988-998 emits it with the spool key. A
#       check that demanded a DB row for a spooled receipt would fail a
#       correctly-behaving offline capture, which is not what #598 asks for.
#
# Anything else must be a NON-ZERO exit carrying a NAMED reason — a non-empty
# `receipt.error` string. Exit code alone is not evidence in either direction:
# the defect being gated is precisely an exit code that disagrees with what was
# stored. So both the receipt JSON and the database are read.
#
# The FAIL conditions for clause 1 are therefore:
#   - exit 0 with no receipt on stdout at all (the observed silent no-op), or
#   - exit 0 with a receipt that is not durable by (a) or (b), or
#   - non-zero exit with an empty/absent error string (loud but unnamed).
#
# ---------------------------------------------------------------------------
# Clause 2: `kind`
# ---------------------------------------------------------------------------
# `kind` is not in the capture allowlist (cli.py:82-94), so _project_request
# (cli.py:394-408) drops it into `ignored_optional_request_keys` and
# _attach_compatibility_receipt (cli.py:413-431) merely names it in the
# receipt. Naming a dropped key is better than a bare count (#464) but it is
# still accept-and-ignore: the request succeeds, the event type is lost, and
# the exit code says fine.
#
# PASS requires one of:
#   (a) HONORED — `kind` did not land in ignored_optional_request_keys AND the
#       stored row reflects it (the row's event_type/type column carries the
#       requested value), or
#   (b) REJECTED BY NAME — non-zero exit and the error string contains the
#       literal token `kind`.
#
# FAIL: `kind` appears in receipt.ignored_optional_request_keys. That is the
# silent relegation #598 names, and it fails even if clause 1 passed.
#
# Note the two clauses are deliberately assessed from SEPARATE invocations.
# Clause 1 sends no `kind` so a `kind` rejection cannot be mistaken for the
# capture path working; clause 2 sends `kind` on an otherwise identical
# request.
set -uo pipefail

REPO_ROOT="/Volumes/ThunderBolt/Development/open-brain"
CLI="${OPENBRAIN_CLI:-$HOME/.local/bin/openbrain-memory}"
ENV_FILE="${OPENBRAIN_ENV_FILE:-$HOME/.local/share/openbrain-memory/env/claudex-observation.env}"

fail_hard() {
  printf 'HARNESS-ERROR: %s\n' "$1" >&2
  exit 3
}

[ -x "$CLI" ] || fail_hard "operator CLI not executable at $CLI"
[ -r "$ENV_FILE" ] || fail_hard "provider env file not readable at $ENV_FILE"
command -v python3 >/dev/null 2>&1 || fail_hard "python3 not on PATH (JSON reader)"

# Credentials for the live capture path.
set -a
# shellcheck disable=SC1090
. "$ENV_FILE"
set +a

RUN_ID="$(od -An -N6 -tx1 /dev/urandom | tr -d ' \n')"
MARKER="rlvr598-${RUN_ID}"

# ISOLATION IS BY THROWAWAY LANE, NOT THROWAWAY NAMESPACE — and that is forced,
# not a preference. The server derives namespace from the bearer token:
# a successful capture on 2026-08-07 returned `"namespace_source":"token"`, so
# OPENBRAIN_NAMESPACE does not steer the write. Overriding it to an unprovisioned
# value made every capture die at the scope gate with
# "session_start result did not prove exact Open Brain scope: namespace"
# (validate_started_lane, _runtime_validation.py:67-94) — which LOOKS like a
# clause-1 pass (loud, named, non-zero) while never exercising the capture path
# #598 is about. That is a false green, so the namespace is left alone and
# isolation comes from a unique session_key, which gets its own lane row.
THROWAWAY_SESSION_KEY="done-means-598-${RUN_ID}"

REQUESTED_KIND="decision"

SCOPE='{"agent":"done-means-598","platform":"cli","channel_id":"done-means","server_id":"done-means","session_key":"'"$THROWAWAY_SESSION_KEY"'"}'

# --- database access (teardown + row proof) --------------------------------
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
[ "$DB_OK" -eq 1 ] || fail_hard "cannot reach the dogfood database; row proof and teardown are both impossible, so a PASS could not be trusted"

# Namespace is NOT a column on ob_session_events; scope columns live on
# ob_session_lanes, reached through ob_session_events.lane_id. Verified against
# information_schema on the dogfood DB 2026-08-07.
LANE_PRED="lane_id in (select id from ob_session_lanes where session_key = '$THROWAWAY_SESSION_KEY')"

# Teardown removes exactly this run's lane and its events, and nothing else:
# session_key carries the random RUN_ID, so it cannot collide with real data.
teardown() {
  psql -At -c "delete from ob_session_events where $LANE_PRED;" >/dev/null 2>&1
  psql -At -c "delete from ob_session_lanes where session_key = '$THROWAWAY_SESSION_KEY';" >/dev/null 2>&1
}
trap teardown EXIT

# json_field <json> <python-expression-over-`r`(receipt dict)>
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

row_count_for() {
  psql -At -c "select count(*) from ob_session_events where $LANE_PRED and content like '%$1%';" 2>/dev/null | tr -d '[:space:]'
}

CLAUSE1=FAIL
CLAUSE1_EVIDENCE=""
CLAUSE2=FAIL
CLAUSE2_EVIDENCE=""

# ---------------------------------------------------------------------------
# Clause 1 — durable receipt, or non-zero with a named reason. No `kind` sent.
# ---------------------------------------------------------------------------
M1="${MARKER}-c1"
REQ1='{"operation":"capture","distilled":true,"event_type":"fact","content":"'"$M1"' done-means acceptance probe","scope":'"$SCOPE"'}'

OUT1="$(printf '%s' "$REQ1" | "$CLI" 2>/dev/null)"
EXIT1=$?

STATUS1="$(receipt_field "$OUT1" status)"
DURABLE1="$(receipt_field "$OUT1" durable)"
ERROR1="$(receipt_field "$OUT1" error)"
SPOOLKEY1="$(receipt_field "$OUT1" spool_key)"
ROWS1="$(row_count_for "$M1")"
[ -n "$ROWS1" ] || ROWS1=0

if [ -z "$(printf '%s' "$OUT1" | tr -d '[:space:]')" ]; then
  CLAUSE1=FAIL
  CLAUSE1_EVIDENCE="silent no-op: exit=$EXIT1, stdout empty, no receipt emitted at all; rows=$ROWS1"
elif [ "$EXIT1" -eq 0 ]; then
  if [ "$DURABLE1" = "true" ] && [ "$ROWS1" -ge 1 ]; then
    CLAUSE1=PASS
    CLAUSE1_EVIDENCE="exit=0 status=$STATUS1 durable=true, durable-in-DB: ob_session_events rows=$ROWS1 in lane session_key=$THROWAWAY_SESSION_KEY"
  elif [ "$DURABLE1" = "true" ] && [ "$STATUS1" = "spooled" ] && [ -n "$SPOOLKEY1" ]; then
    CLAUSE1=PASS
    CLAUSE1_EVIDENCE="exit=0 status=spooled durable=true spool_key=$SPOOLKEY1 (durable-on-disk per runtime.py:429-433); rows=$ROWS1"
  else
    CLAUSE1=FAIL
    CLAUSE1_EVIDENCE="exit=0 but nothing durable: status=$STATUS1 durable=$DURABLE1 spool_key='${SPOOLKEY1}' rows=$ROWS1"
  fi
else
  if [ -n "$ERROR1" ]; then
    CLAUSE1=PASS
    CLAUSE1_EVIDENCE="exit=$EXIT1 non-zero with named reason: status=$STATUS1 error=\"$ERROR1\"; rows=$ROWS1"
  else
    CLAUSE1=FAIL
    CLAUSE1_EVIDENCE="exit=$EXIT1 non-zero but UNNAMED: status=$STATUS1 error is empty/absent; rows=$ROWS1"
  fi
fi

# ---------------------------------------------------------------------------
# Clause 2 — `kind` honored, or rejected by name. Same request plus `kind`.
# ---------------------------------------------------------------------------
M2="${MARKER}-c2"
REQ2='{"operation":"capture","distilled":true,"event_type":"fact","kind":"'"$REQUESTED_KIND"'","content":"'"$M2"' done-means acceptance probe","scope":'"$SCOPE"'}'

OUT2="$(printf '%s' "$REQ2" | "$CLI" 2>/dev/null)"
EXIT2=$?

STATUS2="$(receipt_field "$OUT2" status)"
ERROR2="$(receipt_field "$OUT2" error)"
IGNORED2="$(receipt_field "$OUT2" ignored_optional_request_keys)"

KIND_IGNORED=0
case ",${IGNORED2}," in
  *,kind,*) KIND_IGNORED=1 ;;
esac

if [ "$KIND_IGNORED" -eq 1 ]; then
  CLAUSE2=FAIL
  CLAUSE2_EVIDENCE="silent relegation: exit=$EXIT2 status=$STATUS2 ignored_optional_request_keys=[$IGNORED2] — 'kind' accepted-and-dropped, neither honored nor rejected"
elif [ "$EXIT2" -ne 0 ] && printf '%s' "$ERROR2" | grep -q 'kind'; then
  CLAUSE2=PASS
  CLAUSE2_EVIDENCE="rejected by name: exit=$EXIT2 error=\"$ERROR2\" names 'kind'"
else
  STORED_KIND="$(psql -At -c "select coalesce(event_type,'') from ob_session_events where $LANE_PRED and content like '%$M2%' limit 1;" 2>/dev/null | tr -d '[:space:]')"
  if [ "$STORED_KIND" = "$REQUESTED_KIND" ]; then
    CLAUSE2=PASS
    CLAUSE2_EVIDENCE="honored: exit=$EXIT2 status=$STATUS2, stored row event_type='$STORED_KIND' matches requested kind='$REQUESTED_KIND'"
  else
    CLAUSE2=FAIL
    CLAUSE2_EVIDENCE="not honored and not rejected by name: exit=$EXIT2 status=$STATUS2 error=\"$ERROR2\" ignored=[$IGNORED2] stored event_type='${STORED_KIND}' != requested '$REQUESTED_KIND'"
  fi
fi

printf 'CLAUSE 1 (durable receipt or non-zero with named reason): %s — %s\n' "$CLAUSE1" "$CLAUSE1_EVIDENCE"
printf 'CLAUSE 2 (kind honored or rejected by name): %s — %s\n' "$CLAUSE2" "$CLAUSE2_EVIDENCE"

if [ "$CLAUSE1" = PASS ] && [ "$CLAUSE2" = PASS ]; then
  exit 0
fi
exit 1
