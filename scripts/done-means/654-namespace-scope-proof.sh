#!/usr/bin/env bash
# DONE-MEANS check for issue #654 — the acceptance gate, not the fix.
#
#   bash scripts/done-means/654-namespace-scope-proof.sh
#
# Issue #654, as measured live against the running dogfood service (revision
# 212f916) on 2026-08-08:
#
#   OPENBRAIN_NAMESPACE=e2e-654-probe  +  a non-delegating token
#     -> capture fails with
#        "session_start result did not prove exact Open Brain scope: namespace"
#        status=lost, durable=false
#     -> AND the lane it created landed in namespace 'rico' (the TOKEN's
#        namespace), not in the requested one.
#
# This is #646's disease on a different key. #646 (PR #650) fixed the
# demand/reject contradiction on `source` and taught the SERVING tree to
# establish exact scope on an existing lane. `namespace` survived that fix
# because it is not a lane column the server backfills — it is the predicate
# the server derives from identity, so the client and server can silently
# disagree about it.
#
# ---------------------------------------------------------------------------
# Root cause (from source + controlled live reproduction, both recorded)
# ---------------------------------------------------------------------------
# `namespace` is env-carried and NEVER a request key (ledger item 28; the
# provider's own `--help` says so verbatim: "OPENBRAIN_NAMESPACE -- namespace
# for every request; NOT a request key"). The only wire mechanism that binds a
# request to a namespace other than the token's is the `X-Namespace` header,
# which the server honors ONLY for admin/ob-admin and 403s for every other role
# (server/auth/middleware.ts:79-89). Its own comment names the failure mode
# this issue is an instance of: "Silently ignoring the header is the dangerous
# variant: the caller believes it wrote somewhere it did not."
#
# The client did exactly that. `FirstClassMemoryRuntime` constructs its direct
# client with a hardcoded `delegate_namespace=False`
# (runtime.py:520, unchanged since #294), so `X-Namespace` is NEVER sent
# (client.py:1542-1543). The server therefore falls back to `identity.clientId`
# (server/tools/memory-helpers.ts:125) and the lane is created under the
# TOKEN's namespace — while the client validates the response against
# `config.namespace` (runtime.py:1165), the namespace it was asked for. The two
# disagree, and `validate_started_lane` correctly refuses to prove the scope.
#
# So the scope-proof error is a TRUE report of a real mis-scope, and it is the
# only thing standing between the operator and a silent write into the wrong
# namespace. THE VALIDATOR IS NOT THE BUG AND MUST NOT BE WEAKENED. The bug is
# that the runtime never asks for the namespace it was configured with, and
# then reports the resulting divergence as an opaque scope-proof failure
# instead of naming the cause.
#
# The fix must therefore do BOTH, which is why (b) and (d) are separate:
#   - request the configured namespace over the wire when it differs from the
#     one the token would supply, so a delegation-authorized token lands in the
#     namespace the operator asked for; and
#   - when the request is NOT authorized to bind that namespace, fail LOUDLY
#     and by name rather than writing somewhere else.
#
# ---------------------------------------------------------------------------
# Clauses
# ---------------------------------------------------------------------------
#   (a) RED ANCHOR — with a delegation-capable token and a throwaway
#       namespace, capture fails on `namespace` today. This clause INVERTS at
#       the fix: pre-fix the failure is PRESENT (gate FAILS); post-fix it must
#       be ABSENT. It is the anchor, not a test that the bug persists.
#
#   (b) SCOPE PROVEN + CAPTURE DURABLE — the same request returns
#       durable:true / status=saved, AND the row lands in the REQUESTED
#       namespace. The namespace check is the point: a "fix" that made capture
#       succeed while still writing to the token's namespace is the exact
#       silent mis-scope the middleware comment warns about, so (b) reads the
#       database, not just the receipt.
#
#   (c) CONTROL, ISOLATION HELD — a token WITHOUT delegation authority asking
#       for a foreign namespace is still REFUSED, and writes nothing into it.
#       Namespace isolation is a security boundary (AGENTS.md Coding
#       Standards); this clause exists so the gate cannot be passed by
#       loosening the validator or by having the client accept whatever the
#       server returns. It must pass BOTH pre-fix and post-fix.
#
#   (d) CONTROL, FAILURE IS NAMED — when the namespace cannot be bound, the
#       operator-visible error names `namespace` and the cause, rather than
#       succeeding silently into the wrong one. Guards the "adjusted silently"
#       failure (AGENTS.md: nothing is adjusted silently).
#
#   (e) CONTROL, HEALTHY PATH UNTOUCHED — an ordinary capture with NO namespace
#       override still succeeds. Without this, breaking the default path to
#       satisfy (a)-(d) would score as progress.
#
# Output is content-free apart from a random run marker: statuses, keys, and
# counts only. No tokens, no memory bodies.
#
# EXPECTED TO FAIL until #654 is fixed. It is the reward function, not a test
# of the fix's author.
set -uo pipefail

REPO_ROOT="${OPENBRAIN_REPO_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
ENV_FILE="${OPENBRAIN_ENV_FILE:-$HOME/.local/share/openbrain-memory/env/claudex-observation.env}"
PKG_DIR="$REPO_ROOT/python/openbrain-memory"

fail_hard() {
  printf 'HARNESS-ERROR: %s\n' "$1" >&2
  exit 3
}

[ -r "$ENV_FILE" ] || fail_hard "provider env file not readable at $ENV_FILE"
[ -d "$PKG_DIR" ] || fail_hard "python package not found at $PKG_DIR"
command -v python3 >/dev/null 2>&1 || fail_hard "python3 not on PATH (JSON reader)"
command -v uv >/dev/null 2>&1 || fail_hard "uv not on PATH (provider runner)"

set -a
# shellcheck disable=SC1090
. "$ENV_FILE"
set +a

[ -n "${OPENBRAIN_BASE_URL:-}" ] || fail_hard "OPENBRAIN_BASE_URL unset"
[ -n "${OPENBRAIN_TOKEN:-}" ] || fail_hard "OPENBRAIN_TOKEN unset"

TOKEN_NS="${OPENBRAIN_NAMESPACE:-rico}"

# --- database access (row proof + teardown) --------------------------------
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
[ "$DB_OK" -eq 1 ] || fail_hard "cannot reach the dogfood database; the namespace row proof and teardown are both impossible, so a PASS could not be trusted"

RUN_ID="$(od -An -N6 -tx1 /dev/urandom | tr -d ' \n')"
PROBE_NS="e2e654-${RUN_ID}"

# A delegation-capable token is REQUIRED, not optional. The whole issue is
# about binding a namespace other than the token's, and the only authorized way
# to do that is admin/ob-admin delegation. Without one there is no honest way
# to distinguish "the fix works" from "the request was refused", so the gate
# refuses to run rather than emit a green that examined nothing (#583).
#
# The token must be the one the RUNNING service accepts, which is not
# necessarily this checkout's `.env`: the dogfood service is served from a
# deploy clone and takes its tokens from the launchd environment, so the
# repo's `AUTH_TOKEN_ADMIN` answers 401 while the live one answers 200
# (observed 2026-08-08). Preferring the repo value would make the gate refuse
# on a healthy system, so the live process environment is read first and the
# repo `.env` is only a fallback for a service started from this checkout.
ADMIN_TOKEN="${OPENBRAIN_654_ADMIN_TOKEN:-}"
if [ -z "$ADMIN_TOKEN" ]; then
  OB_PID="$(pgrep -f 'bun run server/main.ts' 2>/dev/null | head -1)"
  if [ -n "$OB_PID" ]; then
    ADMIN_TOKEN="$(ps eww "$OB_PID" 2>/dev/null | tr ' ' '\n' | grep '^AUTH_TOKEN_ADMIN=' | head -1 | cut -d= -f2-)"
  fi
fi
[ -n "$ADMIN_TOKEN" ] || ADMIN_TOKEN="${AUTH_TOKEN_ADMIN:-}"
[ -n "$ADMIN_TOKEN" ] || fail_hard "no delegation-capable token available (set OPENBRAIN_654_ADMIN_TOKEN); a gate that cannot bind a foreign namespace cannot measure this issue"

# Prove the token really can delegate BEFORE measuring anything. Without this,
# a 403 on every request would make clause (a) look green — the bug "absent"
# because nothing was ever attempted. A gate that examined nothing is not a
# pass (#583).
DELEG_CODE="$(curl -s -o /dev/null -w '%{http_code}' -X POST "$OPENBRAIN_BASE_URL/mcp" \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "X-Namespace: $PROBE_NS" \
  -H 'Accept: application/json, text/event-stream' -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"done-means-654","version":"1"}}}' 2>/dev/null)"
[ "$DELEG_CODE" = "200" ] || fail_hard "the supplied token cannot delegate X-Namespace (HTTP $DELEG_CODE); this gate would measure a refusal instead of the issue"

DELEGATE_KEY="done-means-654-delegate-${RUN_ID}"
REFUSED_KEY="done-means-654-refused-${RUN_ID}"
HEALTHY_KEY="done-means-654-healthy-${RUN_ID}"
REQ_AGENT="done-means-654"

# Teardown removes exactly this run's namespace and lanes, and nothing else:
# the probe namespace and every session_key carry the random RUN_ID, so
# collision with real data is not possible.
teardown() {
  for k in "$DELEGATE_KEY" "$REFUSED_KEY" "$HEALTHY_KEY"; do
    psql -At -c "delete from ob_session_events where lane_id in (select id from ob_session_lanes where session_key = '$k');" >/dev/null 2>&1
    psql -At -c "delete from ob_session_lanes where session_key = '$k';" >/dev/null 2>&1
  done
  psql -At -c "delete from ob_session_events where lane_id in (select id from ob_session_lanes where namespace = '$PROBE_NS');" >/dev/null 2>&1
  psql -At -c "delete from ob_session_lanes where namespace = '$PROBE_NS';" >/dev/null 2>&1
}
trap teardown EXIT

# --- provider invocation ----------------------------------------------------
# Runs the SHIPPED provider entry point exactly as a real caller does: one JSON
# object on stdin, identity from the environment. Nothing is imported or
# monkey-patched, so what passes here is what an operator gets.
#
# The 4th argument is the OPENBRAIN_DELEGATE_NAMESPACE value. It is passed
# EXPLICITLY per call rather than exported once, so each clause states the
# posture it is measuring: (a)/(b) ask for delegation, (c) deliberately does
# not, and (e) is the untouched default path. An inherited value would let one
# clause silently change another's meaning.
run_capture() { # run_capture <namespace> <token> <session_key> <delegate 0|1>
  ( cd "$PKG_DIR" \
    && OPENBRAIN_BASE_URL="$OPENBRAIN_BASE_URL" \
       OPENBRAIN_TOKEN="$2" \
       OPENBRAIN_NAMESPACE="$1" \
       OPENBRAIN_DELEGATE_NAMESPACE="${4:-0}" \
       uv run python -m openbrain_memory ) <<JSON 2>/dev/null
{"operation":"capture",
 "content":"done-means 654 probe ${RUN_ID}",
 "event_type":"fact",
 "distilled":true,
 "scope":{"agent":"${REQ_AGENT}","platform":"cli","channel_id":"done-means","server_id":"done-means","session_key":"$3"}}
JSON
}

receipt_field() { # receipt_field <json> <field>
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
elif isinstance(v,bool):
    print("true" if v else "false")
else:
    print(v)
' "$2"
}

lane_ns() { # lane_ns <session_key> -> the namespace the lane actually landed in
  psql -At -c "select namespace from ob_session_lanes where session_key='$1' order by created_at desc limit 1;" 2>/dev/null | tr -d '[:space:]'
}

event_count_in_ns() { # event_count_in_ns <namespace>
  psql -At -c "select count(*) from ob_session_events where lane_id in (select id from ob_session_lanes where namespace='$1');" 2>/dev/null | tr -d '[:space:]'
}

FAILURES=0
pass() { printf '%-34s: PASS — %s\n' "$1" "$2"; }
fail() { printf '%-34s: FAIL — %s\n' "$1" "$2"; FAILURES=$((FAILURES+1)); }

printf 'run marker : %s\n' "$RUN_ID"
printf 'probe ns   : %s (throwaway, removed at exit)\n' "$PROBE_NS"
printf 'token ns   : %s\n' "$TOKEN_NS"
printf 'service    : %s\n\n' "$OPENBRAIN_BASE_URL"

# ---------------------------------------------------------------------------
# (a) RED ANCHOR + (b) SCOPE PROVEN — one delegated capture, read two ways.
# ---------------------------------------------------------------------------
DELEGATE_OUT="$(run_capture "$PROBE_NS" "$ADMIN_TOKEN" "$DELEGATE_KEY" 1)"
D_STATUS="$(receipt_field "$DELEGATE_OUT" status)"
D_DURABLE="$(receipt_field "$DELEGATE_OUT" durable)"
D_ERROR="$(receipt_field "$DELEGATE_OUT" error)"
D_LANE_NS="$(lane_ns "$DELEGATE_KEY")"

if printf '%s' "$D_ERROR" | grep -q 'did not prove exact Open Brain scope: namespace'; then
  fail "(a) namespace scope proof" "RED ANCHOR PRESENT — [$D_ERROR] status=$D_STATUS durable=$D_DURABLE lane_namespace=${D_LANE_NS:-<none>}"
else
  pass "(a) namespace scope proof" "no namespace scope-proof failure (status=$D_STATUS durable=$D_DURABLE)"
fi

if [ "$D_STATUS" = "saved" ] && [ "$D_DURABLE" = "true" ] && [ "$D_LANE_NS" = "$PROBE_NS" ]; then
  pass "(b) capture durable in requested ns" "status=saved durable=true lane_namespace=$PROBE_NS"
else
  fail "(b) capture durable in requested ns" "status=${D_STATUS:-<none>} durable=${D_DURABLE:-<none>} lane_namespace=${D_LANE_NS:-<none>} expected_namespace=$PROBE_NS"
fi

# ---------------------------------------------------------------------------
# (c)+(d) CONTROL — a non-delegating token must still be REFUSED a foreign
# namespace, by name, and must not write into it. Must hold pre- AND post-fix.
# ---------------------------------------------------------------------------
BEFORE_REFUSED="$(event_count_in_ns "$PROBE_NS")"
# Delegation is REQUESTED here, with a token that has no authority to it. That
# is the adversarial shape: post-fix the header is actually sent, so this is a
# live test of the server's role gate rather than of the client declining to
# ask. A token that could bind a foreign namespace merely by asking would be
# the isolation breach.
REFUSED_OUT="$(run_capture "$PROBE_NS" "$OPENBRAIN_TOKEN" "$REFUSED_KEY" 1)"
R_STATUS="$(receipt_field "$REFUSED_OUT" status)"
R_DURABLE="$(receipt_field "$REFUSED_OUT" durable)"
R_ERROR="$(receipt_field "$REFUSED_OUT" error)"
R_LANE_NS="$(lane_ns "$REFUSED_KEY")"

# The security property: the unauthorized request did not land in the foreign
# namespace. It may fail; it may not succeed there, and it may not silently
# succeed in the token's own namespace either — that is the mis-scope itself.
if [ "$R_DURABLE" != "true" ] && [ "$R_LANE_NS" != "$PROBE_NS" ]; then
  pass "(c) isolation held for weak token" "refused (durable=${R_DURABLE:-false}); nothing written to $PROBE_NS (lane_namespace=${R_LANE_NS:-<none>})"
else
  fail "(c) isolation held for weak token" "ISOLATION BREACH — durable=${R_DURABLE:-<none>} lane_namespace=${R_LANE_NS:-<none>} reached $PROBE_NS without delegation authority"
fi

if printf '%s' "$R_ERROR" | grep -qi 'namespace'; then
  pass "(d) refusal names the cause" "error names namespace: [$R_ERROR]"
else
  fail "(d) refusal names the cause" "refusal did not name 'namespace' — status=${R_STATUS:-<none>} error=[${R_ERROR:-<none>}]; an operator cannot tell why the write went elsewhere"
fi

# ---------------------------------------------------------------------------
# (e) CONTROL — the ordinary path, no namespace override, must stay healthy.
# ---------------------------------------------------------------------------
HEALTHY_OUT="$(run_capture "$TOKEN_NS" "$OPENBRAIN_TOKEN" "$HEALTHY_KEY" 0)"
H_STATUS="$(receipt_field "$HEALTHY_OUT" status)"
H_DURABLE="$(receipt_field "$HEALTHY_OUT" durable)"
H_LANE_NS="$(lane_ns "$HEALTHY_KEY")"

if [ "$H_STATUS" = "saved" ] && [ "$H_DURABLE" = "true" ] && [ "$H_LANE_NS" = "$TOKEN_NS" ]; then
  pass "(e) control, default path healthy" "status=saved durable=true lane_namespace=$TOKEN_NS"
else
  fail "(e) control, default path healthy" "status=${H_STATUS:-<none>} durable=${H_DURABLE:-<none>} lane_namespace=${H_LANE_NS:-<none>}"
fi

printf '\n'
if [ "$FAILURES" -eq 0 ]; then
  printf '=== DONE-MEANS 654: PASS — the configured namespace is requested over the wire and proven in the response, an unauthorized namespace bind is still refused by name, and the default path is unchanged. ===\n'
  exit 0
fi
printf '=== DONE-MEANS 654: FAIL (%d failing clause(s)) ===\n' "$FAILURES"
exit 1
