#!/opt/homebrew/bin/bash
# Standing check (issue 1525): the scheduled dream.route, running as the real
# server on a disposable clone of the dogfood database, routes at least 2x
# Dana's measured real peak, and the thoughts it writes are embedded.
# Usage: scripts/route-throughput-proof.sh [--measure-only]
set -euo pipefail

# System-invoked entrypoints run the node@24 keg, never a bare node off PATH;
# npm (for the migration) comes from the same keg.
NODE_BIN=/opt/homebrew/opt/node@24/bin
export PATH="$NODE_BIN:$PATH"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC_DB="${ROUTE_PROOF_SOURCE_DB:-open_brain_local_20260724}"
WINDOW_MIN="${ROUTE_PROOF_WINDOW_MIN:-6}"
PGCONN=(-h 127.0.0.1 -p 5432 -U dana)
MEASURE_ONLY=0
[[ "${1:-}" == "--measure-only" ]] && MEASURE_ONLY=1

q() { psql "${PGCONN[@]}" -d "$1" -XAtq -v ON_ERROR_STOP=1 -c "$2"; }

# --- a. Target (read-only on the source) ---
LIVE="namespace = 'dana' AND created_at > now() - interval '60 days' AND occurred_at IS NOT NULL AND occurred_at > created_at - interval '1 hour'"
peak_hour=$(q "$SRC_DB" "SELECT coalesce(max(c),0) FROM (SELECT count(*) c FROM ob_raw_turns WHERE $LIVE GROUP BY date_trunc('hour', created_at)) s")
cands=$(q "$SRC_DB" "SELECT count(*) FROM candidate_memory WHERE namespace = 'dana' AND parent_id IS NULL AND embedding IS NOT NULL")
turns=$(q "$SRC_DB" "SELECT count(*) FROM ob_raw_turns WHERE namespace = 'dana'")
if (( turns > 0 )); then
  ratio=$(q "$SRC_DB" "SELECT round($cands::numeric / $turns, 4)")
  target_per_hour=$(q "$SRC_DB" "SELECT ceil(2 * $peak_hour * $cands::numeric / $turns)::bigint")
else
  ratio=0; target_per_hour=0
fi
echo "peak_hour=$peak_hour"
echo "ratio=$ratio"
echo "target_per_hour=$target_per_hour"
if (( MEASURE_ONLY )); then
  (( target_per_hour > 0 )) && exit 0 || exit 1
fi

# --- b. Clone ---
EPOCH=$(date +%s)
WORKDIR="${ROUTE_PROOF_WORKDIR:-/srv/_tmp/open-brain/_validation-runs/route-throughput-$EPOCH}"
CLONE="open_brain_route_throughput_$EPOCH"
SERVER_PID=""
CLONE_CREATED=0
teardown() {
  if [[ -n "$SERVER_PID" ]]; then kill "$SERVER_PID" 2>/dev/null || true; wait "$SERVER_PID" 2>/dev/null || true; fi
  if (( CLONE_CREATED )); then dropdb "${PGCONN[@]}" --if-exists "$CLONE" || echo "WARN: dropdb failed: dropdb -h 127.0.0.1 -p 5432 -U dana $CLONE" >&2; fi
  # The delete gate refuses rm on a $VAR path; hand the literal line to the operator.
  echo "operator cleanup: rm -r $WORKDIR"
}
trap teardown EXIT

src_reg=$(q "$SRC_DB" "SELECT coalesce(to_regclass('public.routing_decisions')::text, '')")
src_count=""
[[ -n "$src_reg" ]] && src_count=$(q "$SRC_DB" "SELECT count(*) FROM routing_decisions")
echo "source routing_decisions: present='${src_reg}' rows='${src_count}'"

mkdir -p "$(dirname "$WORKDIR")"
pg_dump "${PGCONN[@]}" -Fd -j 2 --exclude-table='zz_test_*' -f "$WORKDIR" "$SRC_DB"
createdb "${PGCONN[@]}" -E UTF8 -T template0 "$CLONE"
CLONE_CREATED=1
pg_restore "${PGCONN[@]}" -j 2 --no-owner -d "$CLONE" "$WORKDIR"
(cd "$ROOT" && DB_NAME="$CLONE" PGDATABASE="$CLONE" npm run migrate)

# --- c. Run ---
PORT=""
for p in $(seq 7100 7199); do
  [[ $p == 7141 ]] && continue
  if ! lsof -nP -iTCP:"$p" -sTCP:LISTEN >/dev/null 2>&1; then PORT=$p; break; fi
done
[[ -n "$PORT" ]] || { echo "FAIL no free port in 7100-7199"; exit 1; }
(
  cd "$ROOT"
  # The server refuses to start without LOG_FILE and an auth token; .env
  # carries neither, so the run supplies a throwaway token and its own log path.
  LOG_FILE="$WORKDIR.server.jsonl" \
  AUTH_TOKEN_ADMIN="$(openssl rand -hex 24)" DB_NAME="$CLONE" PGDATABASE="$CLONE" PORT="$PORT" \
  OPEN_BRAIN_BIND_HOST=127.0.0.1 OPEN_BRAIN_MAINTENANCE_ROUTE_ENABLED=1 \
  OPEN_BRAIN_MAINTENANCE_ROUTE_BACKEND=fake OPEN_BRAIN_MAINTENANCE_ROUTE_SLICE_SIZE=200 \
  OPEN_BRAIN_MAINTENANCE_ROUTE_MAX_USD_PER_RUN=1 \
  exec "$NODE_BIN/node" --env-file-if-exists=.env server/main.ts
) >"$WORKDIR.server.log" 2>&1 &
SERVER_PID=$!
echo "server pid=$SERVER_PID port=$PORT log=$WORKDIR.server.log"

for _ in $(seq 1 120); do
  if ! kill -0 "$SERVER_PID" 2>/dev/null; then
    echo "FAIL server exited during startup; log tail:"
    tail -n 20 "$WORKDIR.server.log"
    exit 1
  fi
  curl -fsS "http://127.0.0.1:$PORT/health" 2>/dev/null | rg -q '"healthy"|"ok"' && break
  sleep 1
done
curl -fsS "http://127.0.0.1:$PORT/health" >/dev/null || { echo "FAIL server never healthy"; exit 1; }
for _ in $(seq 1 600); do
  [[ "$(q "$CLONE" "SELECT count(*) FROM routing_runs")" -gt 0 ]] && break
  sleep 1
done
n0=$(q "$CLONE" "SELECT count(*) FROM routing_decisions")
echo "t0=$(date -u +%FT%TZ) decisions=$n0"
sleep $(( WINDOW_MIN * 60 ))
n1=$(q "$CLONE" "SELECT count(*) FROM routing_decisions")
echo "t1=$(date -u +%FT%TZ) decisions=$n1"
rate_per_hour=$(( (n1 - n0) * 60 / WINDOW_MIN ))

# --- d. Clauses ---
fail=0
clause() { if [[ "$2" == 1 ]]; then echo "PASS $1 $3"; else echo "FAIL $1 $3"; fail=1; fi; }
clause target-measured $(( target_per_hour > 0 ? 1 : 0 )) "target_per_hour=$target_per_hour"
clause capacity-at-2x $(( rate_per_hour >= target_per_hour ? 1 : 0 )) "rate_per_hour=$rate_per_hour target_per_hour=$target_per_hour"
routed=$(q "$CLONE" "SELECT count(*) FROM thoughts WHERE source = 'dream-route'")
unembedded=$(q "$CLONE" "SELECT count(*) FROM thoughts WHERE source = 'dream-route' AND embedding IS NULL")
clause routed-thoughts-embedded $(( routed > 0 && unembedded == 0 ? 1 : 0 )) "routed=$routed unembedded=$unembedded"
now_reg=$(q "$SRC_DB" "SELECT coalesce(to_regclass('public.routing_decisions')::text, '')")
now_count=""
[[ -n "$now_reg" ]] && now_count=$(q "$SRC_DB" "SELECT count(*) FROM routing_decisions")
clause source-untouched "$([[ "$now_reg" == "$src_reg" && "$now_count" == "$src_count" ]] && echo 1 || echo 0)" "present='$now_reg' rows='$now_count'"
if (( fail )); then echo "RESULT FAIL"; exit 1; fi
echo "RESULT PASS"
