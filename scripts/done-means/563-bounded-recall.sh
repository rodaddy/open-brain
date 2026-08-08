#!/usr/bin/env bash
# DONE-MEANS check for issue #563 — the acceptance gate, not the fix.
#
#   bash scripts/done-means/563-bounded-recall.sh
#
# THE RULING THIS ENFORCES (operator, 2026-08-08; ledger item 23 in
# docs/issue-graph.md; the two newest comments on #563):
#
#   "I don't see any reason why this whole thing would ship in a single shot to
#    anywhere. It defeats the whole purpose of this"
#
#   "it still should come through as single input outputs or maybe bursts of
#    5 to 10 input outputs that are sent from the server to the client, but not
#    ever as the whole file."
#
# So a budgetless, broad `durable_memory` request must not be answerable as one
# whole-corpus payload. It answers with a BOUNDED BURST plus the pointer pool
# the pack already builds, and a caller that legitimately wants all of it walks
# those pointers in further bursts until it holds everything.
#
# THIS IS RESPONSE SHAPE, NOT DATA REDUCTION. Every seeded record must still be
# retrievable; clause 4 fails the whole check if the walk ends holding fewer
# records than were seeded. Storage is untouched (#604/#606 settled that side).
#
# ACCEPTANCE, as this script enforces it — five clauses:
#
#   1. CONTROL: the probe corpus is real and broadly matchable — the first
#      budgetless request recalls something. A dead corpus or a failed seed
#      would hand every later clause a free pass, exactly the failure mode the
#      #624 lane's control clause was added for.
#   2. BOUNDED: the first (budgetless, broad) reply's durable_memory item count
#      is a burst, not the corpus — at most BURST_MAX of the seeded records, and
#      strictly fewer than were seeded.
#   3. REACHABLE: that same reply carries the remainder's identities as
#      pointers and/or a continuation handle. Bounded WITHOUT a way onward would
#      be data loss, which the ruling explicitly forbids.
#   4. COMPLETE WALK: following the continuation retrieves the rest in further
#      bursts, and the union of every burst covers the full seeded corpus. Each
#      individual burst is also checked to be a burst.
#   5. NO WHOLE-FILE SHAPE: no single reply in the walk serializes the whole
#      corpus (its byte size stays well under a full-corpus serialization).
#
# EXPECTED TO FAIL before the change: today the budgetless path emits every
# recalled record in one durable_memory section
# (DURABLE_MEMORY_MAX_ITEMS = Number.MAX_SAFE_INTEGER,
# src/tools/agent-context-pack-durable-memory.ts), so clause 2 fails on the
# first reply. It is the reward function, not a test of the fix's author.
#
# ---------------------------------------------------------------------------
# Isolation and teardown
# ---------------------------------------------------------------------------
# One random throwaway NAMESPACE per run, seeded by the driver and deleted here
# on exit whatever the verdict. The random RUN_ID makes collision with real data
# impossible, so the teardown DELETE structurally cannot reach anything this run
# did not create (ledger item 20's prefix-guarded, self-created, session-scoped
# auto-removal exception — all three hold).
#
# The embedding provider is stubbed in the driver with a deterministic vector,
# so this needs Postgres but no live MLX endpoint.
#
# Output is content-free: counts, byte sizes, and verdicts only. No record
# bodies are printed.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
DRIVER="$SCRIPT_DIR/563-bounded-recall.driver.ts"

# The ruling's own words: "bursts of 5 to 10 input outputs". A burst at or under
# 10 satisfies it; the corpus is 60, so a reply carrying the corpus cannot pass.
BURST_MAX=10

fail_hard() {
  printf 'HARNESS-ERROR: %s\n' "$1" >&2
  exit 3
}

command -v bun >/dev/null 2>&1 || fail_hard "bun not on PATH"
command -v psql >/dev/null 2>&1 || fail_hard "psql not on PATH"
[ -r "$DRIVER" ] || fail_hard "driver missing: $DRIVER"

# .env carries the libpq vars, so bare psql needs no connection arguments (see
# AGENTS.md "Querying the dogfood database"). A bare worktree may lack .env;
# fall back to the canonical checkout's copy so this runs from either.
ENV_FILE="$REPO_ROOT/.env"
[ -r "$ENV_FILE" ] || ENV_FILE="/path/to/open-brain/Development/open-brain/.env"
[ -r "$ENV_FILE" ] || fail_hard "no readable .env for Postgres credentials"
set -a
# shellcheck disable=SC1090
. "$ENV_FILE"
set +a

# An isolated lane database, when one is exported, is what the lane's own suite
# runs against; honour it so this check measures the same tree/database pair.
if [ -n "${OPENBRAIN_TEST_DATABASE_URL:-}" ]; then
  export PGDATABASE="${OPENBRAIN_TEST_DATABASE_URL##*/}"
fi

psql -At -c 'select 1' >/dev/null 2>&1 ||
  fail_hard "cannot reach Postgres (${PGDATABASE:-unset}); a PASS could not be trusted"

RUN_ID="$(od -An -N6 -tx1 /dev/urandom | tr -d ' \n')"
NS="dm563_${RUN_ID}"
MARKER="dm563probe${RUN_ID}"
SCRATCH="${TEMP_WORKSPACE:-/path/to/open-brain/_tmp}/open-brain/_scratch"
mkdir -p "$SCRATCH" 2>/dev/null || fail_hard "cannot create scratch dir $SCRATCH"
OUT_JSON="$SCRATCH/done-means-563-${RUN_ID}.json"
OUT_LOG="$SCRATCH/done-means-563-${RUN_ID}.log"

teardown() {
  # Self-created, prefix-guarded, session-scoped: the namespace name contains
  # this run's random id, so this statement cannot name anything else.
  psql -At -c "DELETE FROM decisions WHERE namespace = '${NS}';" >/dev/null 2>&1
  mv -f "$OUT_JSON" "$OUT_JSON.done" 2>/dev/null
  mv -f "$OUT_LOG" "$OUT_LOG.done" 2>/dev/null
}
trap teardown EXIT

DONE_MEANS_563_NS="$NS" \
  DONE_MEANS_563_MARKER="$MARKER" \
  DONE_MEANS_563_OUT="$OUT_JSON" \
  bun "$DRIVER" >"$OUT_LOG" 2>&1
DRIVER_EXIT=$?

[ -r "$OUT_JSON" ] ||
  fail_hard "driver wrote no result file (exit ${DRIVER_EXIT}); see $OUT_LOG"

if rg -q '"driver_error"' "$OUT_JSON" 2>/dev/null; then
  fail_hard "driver errored (exit ${DRIVER_EXIT}); see $OUT_LOG and $OUT_JSON"
fi

read_json() {
  bun -e '
    const fs = require("node:fs");
    const data = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    const bursts = data.bursts ?? [];
    const first = bursts[0] ?? {};
    const counts = bursts.map((b) => b.item_count);
    const maxBurst = counts.length ? Math.max(...counts) : 0;
    const maxBytes = bursts.length
      ? Math.max(...bursts.map((b) => b.serialized_bytes))
      : 0;
    const firstReach =
      (first.pointer_identities ?? []).length + (first.has_continuation ? 1 : 0);
    process.stdout.write(
      [
        data.seeded ?? 0,
        data.requests ?? 0,
        data.union_size ?? 0,
        first.item_count ?? 0,
        maxBurst,
        maxBytes,
        firstReach,
        data.walk_ceiling_hit ? 1 : 0,
      ].join(" "),
    );
  ' "$OUT_JSON"
}

read -r SEEDED REQUESTS UNION FIRST_COUNT MAX_BURST MAX_BYTES FIRST_REACH CEILING_HIT <<<"$(read_json)"
[ -n "${SEEDED:-}" ] || fail_hard "could not parse $OUT_JSON"

OVERALL=PASS
RESULTS=""
record_fail() {
  OVERALL=FAIL
  RESULTS="${RESULTS}$1"$'\n'
}
record_pass() { RESULTS="${RESULTS}$1"$'\n'; }

# ---------------------------------------------------------------------------
# Clause 1 — CONTROL: the corpus is real and the broad query reaches it.
# ---------------------------------------------------------------------------
if [ "$SEEDED" -lt 1 ]; then
  record_fail "1 control: FAIL — the driver seeded ${SEEDED} records; every later clause would pass vacuously"
elif [ "$FIRST_COUNT" -lt 1 ]; then
  record_fail "1 control: FAIL — the budgetless broad request recalled 0 items from a ${SEEDED}-record corpus; boundedness cannot be distinguished from a dead query"
else
  record_pass "1 control: PASS — ${SEEDED} records seeded, the budgetless broad request recalled ${FIRST_COUNT}"
fi

# ---------------------------------------------------------------------------
# Clause 2 — BOUNDED: the budgetless broad reply is a burst, not the corpus.
# ---------------------------------------------------------------------------
if [ "$FIRST_COUNT" -ge "$SEEDED" ]; then
  record_fail "2 bounded: FAIL — the budgetless broad reply carried ${FIRST_COUNT} of ${SEEDED} records: the whole corpus shipped in a single shot"
elif [ "$FIRST_COUNT" -gt "$BURST_MAX" ]; then
  record_fail "2 bounded: FAIL — the budgetless broad reply carried ${FIRST_COUNT} records, past the ${BURST_MAX}-per-burst shape the ruling names"
else
  record_pass "2 bounded: PASS — the budgetless broad reply carried ${FIRST_COUNT} records (a burst), not the ${SEEDED}-record corpus"
fi

# ---------------------------------------------------------------------------
# Clause 3 — REACHABLE: the first reply says how to get the rest.
# ---------------------------------------------------------------------------
if [ "$FIRST_REACH" -lt 1 ]; then
  record_fail "3 reachable: FAIL — the first reply offered neither pointers nor a continuation handle; a bounded reply with no way onward is data loss, which the ruling forbids"
else
  record_pass "3 reachable: PASS — the first reply carried the remainder's reach (pointers and/or a continuation handle)"
fi

# ---------------------------------------------------------------------------
# Clause 4 — COMPLETE WALK: bursts reconstruct the whole corpus, nothing lost.
# ---------------------------------------------------------------------------
if [ "$CEILING_HIT" = "1" ]; then
  record_fail "4 complete-walk: FAIL — the walk hit its request ceiling; a continuation that never terminates is not a walk"
elif [ "$UNION" -lt "$SEEDED" ]; then
  record_fail "4 complete-walk: FAIL — the walk retrieved ${UNION} of ${SEEDED} records across ${REQUESTS} requests: bounding dropped data instead of re-shaping delivery"
elif [ "$MAX_BURST" -gt "$BURST_MAX" ]; then
  record_fail "4 complete-walk: FAIL — the walk retrieved all ${UNION} records, but its largest burst carried ${MAX_BURST}, past the ${BURST_MAX}-per-burst shape"
elif [ "$REQUESTS" -lt 2 ]; then
  record_fail "4 complete-walk: FAIL — the whole corpus arrived in ${REQUESTS} request; bursts sent server-to-client are the ruled shape"
else
  record_pass "4 complete-walk: PASS — ${REQUESTS} bursts retrieved all ${UNION}/${SEEDED} records, largest burst ${MAX_BURST}"
fi

# ---------------------------------------------------------------------------
# Clause 5 — NO WHOLE-FILE SHAPE: a reply's size is set by the burst, not by
#            how much the query matched.
# ---------------------------------------------------------------------------
# The property that actually distinguishes the two shapes is SCALING. A
# whole-corpus reply grows with the corpus — that is why the live namespace
# reached 60.4 MiB (measured 2026-08-05) and why no broker will carry it. A
# burst reply is the size of BURST_MAX whole records plus a fixed envelope, and
# stays there whether the query matched sixty records or sixty thousand.
#
# So the ceiling is expressed per-DELIVERED-RECORD, never as a fraction of the
# corpus: the largest reply must fit within the bytes a burst legitimately
# needs. Records are delivered WHOLE (the standing no-reduction rule), so this
# clause must leave generous room for full bodies, their source_refs, and their
# citations — measured at ~4.4 KB per delivered record for this corpus's
# ~1200-char bodies. The allowance below is well above that and still an order
# of magnitude below a whole-corpus serialization, so it separates the two
# shapes without ever pressuring the implementation to trim a body.
BYTES_PER_DELIVERED_RECORD=8000
BURST_ALLOWANCE=$((BURST_MAX * BYTES_PER_DELIVERED_RECORD))
WHOLE_CORPUS_BYTES=$((SEEDED * 4400))
if [ "$MAX_BYTES" -ge "$BURST_ALLOWANCE" ]; then
  record_fail "5 no-whole-file: FAIL — the largest single reply was ${MAX_BYTES} bytes, past the ${BURST_ALLOWANCE} a ${BURST_MAX}-record burst needs: reply size is tracking the corpus (~${WHOLE_CORPUS_BYTES} bytes), not the burst"
else
  record_pass "5 no-whole-file: PASS — the largest single reply was ${MAX_BYTES} bytes, within the ${BURST_ALLOWANCE} a ${BURST_MAX}-record burst needs and far below a ~${WHOLE_CORPUS_BYTES}-byte whole corpus"
fi

printf '\n=== DONE-MEANS #563: budgetless broad recall is bounded-plus-pointers, walked in bursts ===\n\n'
printf '%s' "$RESULTS"
printf '\nnamespace: %s (deleted on exit)   database: %s\n' "$NS" "${PGDATABASE:-default}"
printf 'transcripts: %s.done  %s.done\n' "$OUT_JSON" "$OUT_LOG"
printf '\nVERDICT: %s\n\n' "$OVERALL"

[ "$OVERALL" = PASS ] || exit 1
exit 0
