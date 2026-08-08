#!/usr/bin/env bash
# DONE-MEANS check for issue #605 — the acceptance gate, not the fix.
#
#   bash scripts/done-means/605-chunk-write-routing.sh
#
# Issue #605 asks for ONE shared thought-write boundary used by both serving
# trees, REST creation, and lane graduation. `writeEntryChunks`
# (src/chunk-write.ts) is that boundary; #605's evidence is that only
# src/tools/log-thought.ts reaches it.
#
# ACCEPTANCE, as this script enforces it: a thought longer than
# CHUNK_THRESHOLD (src/chunking.ts, 2000 chars) written through ANY of the
# three named paths must land as a parent row PLUS chunk rows linked by
# parent_id. Zero chunk rows on a long thought is the defect.
#
# The three paths, each driven at its REAL entry point by the companion
# driver (605-chunk-write-routing.driver.ts) — not by calling the chunk
# writer directly, which would prove nothing about routing:
#
#   capture     server/tools/capture.ts  — the rewrite-tree `log_thought` MCP
#               tool, invoked through a real McpServer over an in-memory
#               transport. Rows land with source='mcp'.
#   rest        src/rest-api.ts          — POST /api/v1/thoughts on a real
#               express app over real HTTP. Rows land with source='rest'.
#   graduation  src/tiering.ts           — graduateLaneEvent(). Rows land with
#               source='lane-tiering'.
#
# The three distinct `source` values are what prove the driver exercised three
# separate production writers rather than one shared helper three times.
#
# DELIBERATELY NOT COVERED, per #605's own "Intentionally separate paths":
# decompose-entry replacement semantics (src/chunk-write.ts:21-26 states the
# opposite intent explicitly), ingest-raw-turn, and append-session-event. A
# check that demanded chunk rows from those would be enforcing the wrong
# design.
#
# EXPECTED TO FAIL until #605 is fixed. It is the reward function, not a test
# of the fix's author.
#
# ---------------------------------------------------------------------------
# Isolation and teardown
# ---------------------------------------------------------------------------
# Unlike the #598 check — where the server derives namespace from the bearer
# token and OPENBRAIN_NAMESPACE does not steer the write — these paths take
# namespace as a call/request parameter, so a throwaway namespace IS available
# and is the cleanest isolation: one random namespace per run, deleted on exit
# whatever the verdict. The random RUN_ID makes collision with real data
# impossible, so the teardown DELETE cannot reach anything else.
#
# The embedding provider is stubbed in the driver with a deterministic vector,
# so a down MLX endpoint cannot turn a routing defect into a false PASS or a
# working fix into a false FAIL. Routing, SQL, and parent linkage are all real.
#
# Output is content-free: path names, ids, and counts only.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
DRIVER="$SCRIPT_DIR/605-chunk-write-routing.driver.ts"

fail_hard() {
  printf 'HARNESS-ERROR: %s\n' "$1" >&2
  exit 3
}

command -v bun >/dev/null 2>&1 || fail_hard "bun not on PATH"
[ -r "$DRIVER" ] || fail_hard "driver not readable at $DRIVER"
command -v python3 >/dev/null 2>&1 || fail_hard "python3 not on PATH (JSON reader)"

# .env carries the libpq vars, so bare psql needs no connection arguments, and
# the driver's `new Pool()` reads the same PG* vars. See AGENTS.md "Querying
# the dogfood database". A worktree has no .env of its own; fall back to the
# canonical checkout's copy so this runs from either.
ENV_FILE="$REPO_ROOT/.env"
[ -r "$ENV_FILE" ] || ENV_FILE="$HOME/Development/open-brain/.env"
[ -r "$ENV_FILE" ] || fail_hard "no readable .env for dogfood DB credentials"
set -a
# shellcheck disable=SC1090
. "$ENV_FILE"
set +a

command -v psql >/dev/null 2>&1 || fail_hard "psql not on PATH"
psql -At -c 'select 1' >/dev/null 2>&1 ||
  fail_hard "cannot reach the dogfood database; row proof and teardown are both impossible, so a PASS could not be trusted"

RUN_ID="$(od -An -N6 -tx1 /dev/urandom | tr -d ' \n')"
NS="done-means-605-${RUN_ID}"
MARKER="rlvr605-${RUN_ID}"

# The driver reports into a FILE rather than stdout. The production code it
# drives logs JSON lines to stdout through the app logger -- including the
# `entry_chunk_write_*` lines the fix itself emits -- so reading stdout made the
# harness parse a log line as the result and report "no parent id" for paths
# that had succeeded: a false FAIL manufactured by the check, not by the code.
SCRATCH="${TEMP_WORKSPACE:-$HOME/.cache/open-brain}/open-brain/_scratch"
mkdir -p "$SCRATCH" 2>/dev/null || fail_hard "cannot create scratch dir $SCRATCH"
OUT_FILE="$SCRATCH/done-means-605-${RUN_ID}.json"

teardown() {
  psql -At -c "delete from thoughts where namespace = '$NS';" >/dev/null 2>&1
  mv -f "$OUT_FILE" "$OUT_FILE.done" 2>/dev/null
}
trap teardown EXIT

DONE_MEANS_605_NS="$NS" DONE_MEANS_605_MARKER="$MARKER" \
  DONE_MEANS_605_OUT="$OUT_FILE" bun "$DRIVER" >/dev/null 2>&1
DRIVER_EXIT=$?

OUT="$(cat "$OUT_FILE" 2>/dev/null)"

if [ "$DRIVER_EXIT" -ne 0 ] || [ -z "$(printf '%s' "$OUT" | tr -d '[:space:]')" ]; then
  fail_hard "driver exited $DRIVER_EXIT without writing usable JSON to $OUT_FILE"
fi

# field <path> <key> -> value, or empty
field() {
  printf '%s' "$OUT" | python3 -c '
import json,sys
try:
    d=json.loads(sys.stdin.read())
except Exception:
    print(""); sys.exit(0)
v=d.get(sys.argv[1])
if not isinstance(v,dict):
    print(""); sys.exit(0)
x=v.get(sys.argv[2])
print("" if x is None else x)
' "$1" "$2" 2>/dev/null
}

# Independent proof, read from the database rather than from the driver's own
# report: the tally of chunk rows carrying this parent. A driver that
# misreported its own count cannot move this number.
db_chunks_for() {
  psql -At -c "select count(*) from thoughts where parent_id = '$1';" 2>/dev/null |
    tr -d '[:space:]'
}

db_source_for() {
  psql -At -c "select source from thoughts where id = '$1';" 2>/dev/null |
    tr -d '[:space:]'
}

OVERALL=PASS
RESULTS=""

for path in capture rest graduation; do
  PARENT="$(field "$path" parent_id)"
  ERR="$(field "$path" error)"

  if [ -n "$ERR" ]; then
    OVERALL=FAIL
    RESULTS="${RESULTS}${path}: FAIL — path could not be driven: ${ERR}"$'\n'
    continue
  fi
  if [ -z "$PARENT" ]; then
    OVERALL=FAIL
    RESULTS="${RESULTS}${path}: FAIL — driver returned no parent id"$'\n'
    continue
  fi

  SRC="$(db_source_for "$PARENT")"
  CHUNKS="$(db_chunks_for "$PARENT")"
  [ -n "$CHUNKS" ] || CHUNKS=0

  if [ "$CHUNKS" -ge 1 ]; then
    RESULTS="${RESULTS}${path}: PASS — parent=${PARENT} source=${SRC} chunk rows with parent_id=${CHUNKS}"$'\n'
  else
    OVERALL=FAIL
    RESULTS="${RESULTS}${path}: FAIL — parent=${PARENT} source=${SRC} wrote a long thought but ZERO chunk rows link to it (bypasses writeEntryChunks)"$'\n'
  fi
done

# A run where all three paths reported the same `source` would mean the driver
# collapsed them into one writer, so the per-path verdicts would be measuring
# one path three times. Reported so a reader can see the three writers were
# distinct.
SOURCES="$(psql -At -c "select string_agg(distinct source, ',' order by source) from thoughts where namespace = '$NS' and parent_id is null;" 2>/dev/null | tr -d '[:space:]')"

printf '\n=== DONE-MEANS #605: every thought write routes through chunk-write ===\n\n'
printf '%s' "$RESULTS"
printf '\nparent-row sources exercised: %s (expect capture=mcp, rest=rest, graduation=lane-tiering)\n' "${SOURCES:-none}"
printf 'throwaway namespace: %s (removed on exit)\n' "$NS"
printf '\nVERDICT: %s\n\n' "$OVERALL"

[ "$OVERALL" = PASS ] || exit 1
exit 0
