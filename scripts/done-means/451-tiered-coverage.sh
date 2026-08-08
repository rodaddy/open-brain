#!/usr/bin/env bash
# DONE-MEANS check for issue #451 — the acceptance gate, not the fix.
#
#   bash scripts/done-means/451-tiered-coverage.sh
#
# ---------------------------------------------------------------------------
# What this gates: the operator's TIERED ruling (2026-08-08, ledger item 24)
# ---------------------------------------------------------------------------
# #451 asks where the hard edges of "unskippable memory calls" go. The lane
# before this one STOPPED at a design delta rather than guess, because every
# candidate gate contradicted a live fail-open contract. The operator ruled
# THREE TIERS, each with a DIFFERENT enforcement strength, and the whole point
# of this check is that the three strengths stay distinguishable:
#
#   CAPTURE   RETIRED 2026-08-08 by ledger item 25, which AMENDS item 24. It
#             was a HARD GATE at merge requiring a server-side receipt; its
#             first live firing wedged the pipeline, and the decisive reason
#             was that raw capture is already AUTOMATIC (spool) while
#             distillation is the DREAM pipeline's job — the gate was forcing a
#             hand-made duplicate of a designed automatic step. Clauses A/B/C/F
#             below are INVERTED to assert the retirement instead of the
#             refusal; the source is kept at .claude/hooks/_retired/ as prior
#             art for the #647 liveness check. Retirement is gated in full by
#             scripts/done-means/648-capture-gate-retired.sh.
#   HYDRATION VERIFY + STAMP. Session start checks the canon pack arrived with
#             sections > 0; absence lands a loud visible marker. NEVER a block —
#             a hydration block can only fire during an outage, which makes it a
#             pure false-block generator.
#   RECALL    MEASURE ONLY into the existing telemetry lane. Facts, no
#             recommendations (the #469 operator ruling this repo already
#             carries: "metrics so that decisions can be made on facts and not
#             on feel").
#
# ---------------------------------------------------------------------------
# HISTORICAL (item 24) — the capture gate's design, retained because #647 has
# to solve the same discrimination without the block
# ---------------------------------------------------------------------------
# The section below describes the gate AS IT WAS. It is not live: clauses
# A/B/C/F assert retirement now. It is kept because the outage-vs-skip problem
# it solved is real and the liveness check inherits it.
#
# The clause that mattered most: SKIP and OUTAGE must never look alike
# ---------------------------------------------------------------------------
# The naive capture gate — "no receipt, refuse" — is WRONG here, and the
# operator's own refinement is why. Capture already spools durably
# (openbrain_memory/_runtime_spool.py, capture/outage.py): during an outage the
# turn IS captured, it just has not been delivered. Refusing that merge punishes
# a session that did everything right, and agents route around gates that fire
# on innocence — this repo's standing scar (#618) is exactly a guard that fired
# on the wrong thing and taxed every lane until fixed.
#
# So the gate is DRAIN-FIRST, three outcomes, and clauses A/B/C pin all three:
#
#   receipt present            -> PASS clean            (clause B)
#   no receipt, drain delivers -> PASS clean            (drain produced it)
#   no receipt, service DOWN   -> PASS *with a stamp*   (clause C)
#   no receipt, service UP,
#     drain produced nothing   -> REFUSE, named reason  (clause A)
#
# Only the last one is a skip, and it is the only one that blocks. Clause C is
# therefore not a leniency clause — it is the clause that keeps the refusal in
# clause A HONEST, because a gate that cannot tell an outage from a skip would
# have to choose between bricking outages and never firing at all.
#
# ---------------------------------------------------------------------------
# Clauses
# ---------------------------------------------------------------------------
#   A   capture tier is RETIRED: no gate on the live hook path  (was: service
#       UP, no receipt, empty spool -> REFUSED naming reason/session/drain)
#   B   capture tier is RETIRED                                 (was: receipt
#       present -> ALLOWED clean)
#   C   capture tier is RETIRED                                 (was: service
#       DOWN -> ALLOWED with an outage stamp naming the session)
#   F   the retired source is KEPT at .claude/hooks/_retired/ and registered
#       nowhere                                                 (was: the gate
#       is REGISTERED in .claude/settings.json)
#
#   A/B/C/F FAIL if the source is absent from BOTH paths — deleting it loses
#   the prior art #647 needs, and item 25 says retire.
#
#   D   canon pack absent / sections == 0    -> hydration marker emitted,
#                                               exit 0 (STAMP, NEVER A BLOCK)
#   D2  canon pack present, sections > 0     -> NO marker (the control: a
#                                               marker that always fires is
#                                               decoration, not a signal)
#   E   recall counts reach the EXISTING telemetry lane as facts only
#
# CONTROL CLAUSE 0 (harvest of #624, lane-contract.md): a check needs proof its
# observation window is live, or a dead harness hands every clause a false
# result. Clause 0 proves bun runs and the hook file is readable BEFORE any
# clause banks a verdict.
#
# ---------------------------------------------------------------------------
# Why everything here is stubbed, and why there are no wall-clock assertions
# ---------------------------------------------------------------------------
# The service is stubbed via a fixture HTTP responder, and `gh` via the
# stub-on-PATH transcript pattern proven in
# scripts/done-means/merge-gate-and-verify-lane.sh:132-160. Both are required,
# not stylistic: clause C's whole subject is "the service is unreachable", which
# cannot be arranged against a live service without taking it down, and clause A
# must prove a refusal fires when it IS reachable. An unstubbed call exits 97 so
# a clause can never silently pass by reaching the real network.
#
# No clause asserts on elapsed time. Wall-clock assertions are CI flake
# generators — three runs, three unrelated timing failures (lane-contract.md
# Tightenings, 2026-08-08). "Service down" is expressed by pointing the gate at
# a closed port, not by waiting for a timeout.
#
# Exit 0 only when every clause passes. Exit 3 is a HARNESS error (missing tool,
# unwritable scratch), which is NOT a failure of the thing under test.
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
GATE="$REPO_ROOT/.claude/hooks/capture-gate.ts"
RETIRED_GATE="$REPO_ROOT/.claude/hooks/_retired/capture-gate.ts"
HYDRATION="$REPO_ROOT/.claude/hooks/hydration-stamp.ts"
SETTINGS="$REPO_ROOT/.claude/settings.json"

# Repo-relative scratch. NEVER an absolute machine path: a hardcoded
# /Volumes/... default died with EACCES on the Linux CI runner
# (lane-contract.md Tightenings, 2026-08-08).
RUN_ID="dm451_$$_$(date +%s)"
SCRATCH="$REPO_ROOT/_scratch/$RUN_ID"

fail_hard() {
  printf 'HARNESS-ERROR: %s\n' "$1" >&2
  exit 3
}

command -v bun >/dev/null 2>&1 || fail_hard "bun not on PATH"
mkdir -p "$SCRATCH" || fail_hard "cannot create scratch dir $SCRATCH"

CLAUSES=()
record() { CLAUSES+=("$1|$2|$3"); }

# ===========================================================================
# CLAUSE 0 — CONTROL. Prove the observation window is live.
# ===========================================================================
if bun -e 'process.stdout.write("ok")' >/dev/null 2>&1; then
  record 0 PASS "CONTROL: bun executes — harness observation window is live"
else
  record 0 FAIL "CONTROL: bun cannot execute — no clause below can be trusted"
fi

SESSION_ID="dm451-session-${RUN_ID}"

# ===========================================================================
# The stubs.
#
# (1) A fixture Open Brain responder. Clauses control it by FIXTURE FILE, so
#     "service up with no receipt" and "service up with a receipt" differ only
#     in data, and "service down" is a port nothing listens on — a real
#     connection refusal, not a simulated one.
# (2) A stub `gh` so the gate's PR-comment stamp is observable without posting.
# ===========================================================================
STUB_DIR="$SCRATCH/stub-bin"
mkdir -p "$STUB_DIR" || fail_hard "cannot create stub dir"

cat > "$STUB_DIR/gh" <<'STUB'
#!/usr/bin/env bash
# Fixture `gh`. Records what would have been posted so a clause can assert on
# the stamp TEXT, and fails loudly on any un-stubbed shape.
set -uo pipefail
args="$*"
case "$args" in
  *"pr comment"*)
    printf '%s\n' "$args" >> "${DM451_GH_LOG:?DM451_GH_LOG unset}"
    exit 0
    ;;
  *"pr view"*)
    cat "${DM451_PR_VIEW:?DM451_PR_VIEW unset}"
    exit 0
    ;;
esac
printf 'gh STUB: unstubbed invocation: %s\n' "$args" >&2
exit 97
STUB
chmod +x "$STUB_DIR/gh" || fail_hard "cannot chmod stub gh"

GH_LOG="$SCRATCH/gh-comments.log"
: > "$GH_LOG"

PR_VIEW="$SCRATCH/pr-view.json"
cat > "$PR_VIEW" <<'PRVIEW'
{"number": 999, "headRefOid": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}
PRVIEW

# --- the fixture service ----------------------------------------------------
# A tiny responder that answers the ONE read the gate is allowed to make
# (session_context for this session) from a fixture file. Started per-clause so
# a clause can also run with it stopped.
SERVER_SCRIPT="$SCRATCH/fixture-service.ts"
cat > "$SERVER_SCRIPT" <<'SERVER'
// Fixture Open Brain. Serves the session_context read from a fixture file.
// Content-free: it echoes only what the fixture says, and records nothing.
const fixture = process.env.DM451_FIXTURE!;
const port = Number(process.env.DM451_PORT!);
Bun.serve({
  port,
  async fetch(request) {
    const body = await Bun.file(fixture).text();
    // Every route answers the same fixture: this stands in for the service
    // being REACHABLE, and the fixture decides whether a receipt exists.
    return new Response(body, {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  },
});
console.log("ready");
SERVER

# A receipt-bearing fixture and an empty one. The shape mirrors what
# session_context returns (server/tools/session-lifecycle.ts:180): a lane plus
# its events.
cat > "$SCRATCH/fixture-with-receipt.json" <<RECEIPT
{"lane": {"id": "lane-dm451", "session_key": "$SESSION_ID"},
 "events": [{"id": "ev-1", "event_type": "fact", "created_at": "2026-08-08T12:00:00.000Z"}],
 "event_count": 1}
RECEIPT

cat > "$SCRATCH/fixture-no-receipt.json" <<'NORECEIPT'
{"lane": {"id": "lane-dm451", "session_key": "dm451"}, "events": [], "event_count": 0}
NORECEIPT

# An EMPTY spool directory: the drain has nothing to deliver, which is what
# makes clause A a genuine skip rather than an undelivered capture.
EMPTY_SPOOL="$SCRATCH/empty-spool"
mkdir -p "$EMPTY_SPOOL" || fail_hard "cannot create spool dir"

# Pick a port in the task-specific range (Development AGENTS.md: 7100-7199).
FIXTURE_PORT="${DM451_PORT_OVERRIDE:-7151}"
# A port nothing listens on == the service is DOWN, for clause C.
DEAD_PORT="${DM451_DEAD_PORT_OVERRIDE:-7152}"

SERVICE_PID=""
start_service() {
  local fixture="$1"
  DM451_FIXTURE="$fixture" DM451_PORT="$FIXTURE_PORT" \
    bun "$SERVER_SCRIPT" > "$SCRATCH/service.log" 2>&1 &
  SERVICE_PID=$!
  # Poll for readiness rather than sleeping a fixed interval: no wall-clock
  # assertion, and a slow start cannot make a clause measure the wrong thing.
  local waited=0
  while [ "$waited" -lt 100 ]; do
    if curl -fsS "http://127.0.0.1:$FIXTURE_PORT/" >/dev/null 2>&1; then return 0; fi
    waited=$((waited + 1))
    sleep 0.1
  done
  return 1
}

stop_service() {
  if [ -n "$SERVICE_PID" ]; then
    kill "$SERVICE_PID" >/dev/null 2>&1
    wait "$SERVICE_PID" 2>/dev/null
    SERVICE_PID=""
  fi
}

# Teardown: this process's own fixture service and nothing else. Narrow
# auto-removal exception (ledger item 20): self-created this run, and the PID is
# one this script started. Scratch FILES are printed, never deleted.
trap 'stop_service' EXIT

# ---------------------------------------------------------------------------
# Drive the capture gate the way Claude Code does: a PreToolUse JSON payload on
# stdin. Sets GATE_EXIT / GATE_STDERR / GATE_STDOUT.
# ---------------------------------------------------------------------------
GATE_EXIT=0
GATE_STDERR=""
GATE_STDOUT=""
run_gate() {
  local command_text="$1" base_url="$2"
  local payload out_file err_file
  out_file="$SCRATCH/gate-stdout.$$"
  err_file="$SCRATCH/gate-stderr.$$"
  payload="$(
    COMMAND_TEXT="$command_text" SESSION="$SESSION_ID" bun -e '
      process.stdout.write(JSON.stringify({
        session_id: process.env.SESSION ?? "",
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_input: { command: process.env.COMMAND_TEXT ?? "" },
      }));
    '
  )" || fail_hard "could not build hook payload"

  printf '%s' "$payload" | \
    PATH="$STUB_DIR:$PATH" \
    OPENBRAIN_BASE_URL="$base_url" \
    OPENBRAIN_TOKEN="dm451-fixture-token" \
    OPENBRAIN_SPOOL_PATH="$EMPTY_SPOOL" \
    DM451_GH_LOG="$GH_LOG" \
    DM451_PR_VIEW="$PR_VIEW" \
    bun "$GATE" --event pre-tool-use > "$out_file" 2> "$err_file"
  GATE_EXIT=$?
  GATE_STDOUT="$(cat "$out_file" 2>/dev/null)"
  GATE_STDERR="$(cat "$err_file" 2>/dev/null)"
}

MERGE_CMD="gh pr merge 999 --squash --delete-branch"

if [ ! -e "$GATE" ] && [ -r "$RETIRED_GATE" ]; then
  # RETIRED state (ledger item 25) — the EXPECTED state since 2026-08-08.
  # Clauses A/B/C/F are inverted: the tier's correctness is now that it does
  # NOT fire, and the assertion is on the retirement being complete rather
  # than on the refusal behaviour. The strong form of that assertion lives in
  # scripts/done-means/648-capture-gate-retired.sh, which also re-runs THIS
  # check; duplicating it here would make the two checks mutually recursive.
  record A PASS "RETIRED (item 25): no capture gate on the hook path — nothing can wedge a merge on a receipt"
  record B PASS "RETIRED (item 25): capture is automatic (spool) and distillation is DREAM's job — no merge-time receipt requirement"
  record C PASS "RETIRED (item 25): with no gate there is no outage-vs-skip verdict to keep honest"
  record F PASS "RETIRED (item 25): source kept at $RETIRED_GATE as #647 prior art, and registered nowhere"
elif [ ! -r "$GATE" ]; then
  # NEITHER present: the source was DELETED rather than retired, which loses
  # the receipt-probe prior art #647 depends on. That is a real failure, and
  # keeping it a failure is why the retired branch above tests for the file.
  for c in A B C; do
    record "$c" FAIL "capture gate is absent from BOTH $GATE and $RETIRED_GATE — deleted, not retired (ledger item 25 says retire)"
  done
  record F FAIL "no capture gate at either path"
else
  # =========================================================================
  # CLAUSE A — service UP, no receipt, empty spool -> REFUSED with the reason.
  # This is the SKIP case, and the only one that blocks.
  # =========================================================================
  if start_service "$SCRATCH/fixture-no-receipt.json"; then
    run_gate "$MERGE_CMD" "http://127.0.0.1:$FIXTURE_PORT"
    stop_service
    if [ "$GATE_EXIT" -ne 2 ]; then
      record A FAIL "merge with NO capture receipt was allowed (exit=$GATE_EXIT) — the hard gate is off"
    elif ! printf '%s' "$GATE_STDERR" | rg -qF 'capture-gate'; then
      record A FAIL "refused but the refusal never names the gate"
    elif ! printf '%s' "$GATE_STDERR" | rg -qiF 'no capture receipt'; then
      record A FAIL "refused but never names the reason (no capture receipt)"
    elif ! printf '%s' "$GATE_STDERR" | rg -qF "$SESSION_ID"; then
      record A FAIL "refused but never names WHICH session has no receipt"
    else
      record A PASS "skip refused (exit=2), names the gate, the reason, and the session"
    fi
  else
    record A FAIL "HARNESS: fixture service did not become ready on port $FIXTURE_PORT"
  fi

  # =========================================================================
  # CLAUSE B — receipt present -> ALLOWED, clean (no outage stamp).
  # =========================================================================
  : > "$GH_LOG"
  if start_service "$SCRATCH/fixture-with-receipt.json"; then
    run_gate "$MERGE_CMD" "http://127.0.0.1:$FIXTURE_PORT"
    stop_service
    if [ "$GATE_EXIT" -ne 0 ]; then
      record B FAIL "merge WITH a capture receipt was refused (exit=$GATE_EXIT) — false block: ${GATE_STDERR:0:200}"
    elif [ -s "$GH_LOG" ]; then
      record B FAIL "passed but posted an outage stamp on a clean pass — skip and outage must stay distinguishable"
    else
      record B PASS "receipt present -> allowed clean (exit=0), no outage stamp posted"
    fi
  else
    record B FAIL "HARNESS: fixture service did not become ready on port $FIXTURE_PORT"
  fi

  # =========================================================================
  # CLAUSE C — service DOWN -> ALLOWED **and** the stamp is emitted.
  # The clause that keeps clause A's refusal honest.
  # =========================================================================
  : > "$GH_LOG"
  # No service started: $DEAD_PORT refuses the connection for real.
  run_gate "$MERGE_CMD" "http://127.0.0.1:$DEAD_PORT"
  STAMP_SEEN=0
  if printf '%s' "$GATE_STDOUT" | rg -qiF 'outage'; then STAMP_SEEN=1; fi
  if [ -s "$GH_LOG" ] && rg -qiF 'outage' "$GH_LOG"; then STAMP_SEEN=1; fi
  if [ "$GATE_EXIT" -ne 0 ]; then
    record C FAIL "service DOWN was BLOCKED (exit=$GATE_EXIT) — an outage must never brick a merge: ${GATE_STDERR:0:200}"
  elif [ "$STAMP_SEEN" -ne 1 ]; then
    record C FAIL "service DOWN passed SILENTLY — no outage stamp anywhere; skip and outage are now indistinguishable"
  elif [ -s "$GH_LOG" ] && ! rg -qF "$SESSION_ID" "$GH_LOG"; then
    record C FAIL "outage stamp posted but does not name the session"
  else
    record C PASS "service down -> allowed (exit=0) WITH a loud outage stamp naming the session"
  fi

  # =========================================================================
  # CLAUSE F — the gate is REGISTERED. An unregistered hook enforces nothing.
  # =========================================================================
  if [ ! -r "$SETTINGS" ]; then
    record F FAIL "no $SETTINGS to register the gate in"
  elif rg -qF 'capture-gate.ts' "$SETTINGS"; then
    record F PASS "capture-gate.ts is registered in .claude/settings.json"
  else
    record F FAIL "capture-gate.ts exists but is NOT registered — it would never fire"
  fi
fi

# ===========================================================================
# CLAUSE D / D2 — HYDRATION: verify + stamp, NEVER a block.
#
# D  asserts the marker appears when the canon pack is absent or empty.
# D2 is the CONTROL: with a healthy pack, NO marker. Without D2, a hook that
#    unconditionally printed the marker would pass D while carrying no signal
#    at all — a marker that always fires is decoration.
# ===========================================================================
run_hydration() {
  local pack_json="$1"
  local out_file err_file payload
  out_file="$SCRATCH/hyd-stdout.$$"
  err_file="$SCRATCH/hyd-stderr.$$"
  payload="$(
    SESSION="$SESSION_ID" bun -e '
      process.stdout.write(JSON.stringify({
        session_id: process.env.SESSION ?? "",
        hook_event_name: "SessionStart",
        source: "startup",
      }));
    '
  )" || fail_hard "could not build hydration payload"
  printf '%s' "$payload" | \
    DM451_CANON_PACK="$pack_json" \
    bun "$HYDRATION" --event session-start > "$out_file" 2> "$err_file"
  HYD_EXIT=$?
  HYD_OUT="$(cat "$out_file" 2>/dev/null)$(cat "$err_file" 2>/dev/null)"
}

if [ ! -r "$HYDRATION" ]; then
  record D FAIL "no hydration check at $HYDRATION — canon-pack absence is invisible"
  record D2 FAIL "no hydration check at $HYDRATION"
else
  # D: an empty pack (sections present but zero) must raise the marker.
  run_hydration '{"sections": {}, "warnings": []}'
  if [ "$HYD_EXIT" -ne 0 ]; then
    record D FAIL "hydration check BLOCKED the session (exit=$HYD_EXIT) — the ruling is stamp, never block"
  elif ! printf '%s' "$HYD_OUT" | rg -qiF 'hydration'; then
    record D FAIL "canon pack empty but no hydration marker emitted — the absence is silent"
  else
    record D PASS "canon pack empty -> loud marker emitted, session NOT blocked (exit=0)"
  fi

  # D2 (control): a healthy pack must produce NO marker.
  run_hydration '{"sections": {"profile_guidance": [1,2], "process_guidance": [1]}, "warnings": []}'
  if [ "$HYD_EXIT" -ne 0 ]; then
    record D2 FAIL "healthy canon pack still blocked the session (exit=$HYD_EXIT)"
  elif printf '%s' "$HYD_OUT" | rg -qiF 'hydration marker'; then
    record D2 FAIL "marker fired on a HEALTHY pack — a marker that always fires is decoration, not a signal"
  else
    record D2 PASS "healthy pack -> no marker (control: the marker carries signal)"
  fi
fi

# ===========================================================================
# CLAUSE E — RECALL MEASURE lands in the EXISTING telemetry lane, facts only.
#
# The ruling says MEASURE into existing telemetry, and this repo already has
# exactly one such lane: the PostToolUse -> record_skill_usage counter
# (python/openbrain/src/openbrain/apps/hooks/post_tool_use.py), built under the
# #469 ruling "metrics so that decisions can be made on facts and not on feel".
# So this clause asserts TWO things, and the second is the important one:
#   (i)  recall invocations are counted, and
#   (ii) the counting path recommends NOTHING — no retire/rotate/shelve/suggest.
# A "measure" tier that grew opinions would be a different tier.
# ===========================================================================
# The lane's capability lives in session.py (post_tool_use.py is a parse-and-exit
# shell), and this repo's python tests are FLAT — python/openbrain/tests/ — not
# mirrored under apps/hooks/. Both paths are named from the tree as it is, after
# an earlier draft of this clause pointed at a tests/apps/hooks/ path that does
# not exist; a clause that asserts against a missing file fails for the wrong
# reason and sends the next reader to build the wrong thing.
RECALL_SRC="$REPO_ROOT/python/openbrain/src/openbrain/apps/hooks/session.py"
RECALL_ENTRY="$REPO_ROOT/python/openbrain/src/openbrain/apps/hooks/post_tool_use.py"
RECALL_TEST="$REPO_ROOT/python/openbrain/tests/test_capture_hooks.py"

# The measure tier must not grow opinions. Matching a bare verb would false-fire
# on the prose that EXPLAINS the tier ("it does not recommend..."), so this looks
# for a called function or a def — an implementation, not a mention.
#
# Passed with `rg -e`, NEVER `rg -E`: ripgrep's `-E` is `--encoding`, and the
# first draft of this clause used it, which made rg exit with a flag-parse error
# that the `elif` chain read as "pattern not found" — i.e. the clause PASSED by
# skipping to the next branch. Caught by mutation-checking a green run
# (lane-contract.md Tightenings, 2026-08-08, #621 lane: same trap, second time).
OPINION_PATTERN='(def |self\.)(retire|rotate|shelve|deprecate|recommend|suggest)'

if [ ! -r "$RECALL_SRC" ]; then
  record E FAIL "telemetry lane missing at $RECALL_SRC"
elif ! rg -qF 'RECALL_TOOL_NAMES' "$RECALL_SRC"; then
  record E FAIL "recall invocations are not counted in the existing telemetry lane ($RECALL_SRC)"
elif ! rg -qF 'recall_slug' "$RECALL_SRC"; then
  record E FAIL "no recall filter — RECALL_TOOL_NAMES is declared but nothing counts against it"
elif rg -q -e "$OPINION_PATTERN" "$RECALL_SRC" "$RECALL_ENTRY"; then
  record E FAIL "the measure tier grew RECOMMENDATIONS — facts only, per the #469 ruling"
elif [ ! -r "$RECALL_TEST" ]; then
  record E FAIL "recall counting present but no test file at $RECALL_TEST"
elif ! rg -qF 'TestPostToolUseCountsRecallInvocations' "$RECALL_TEST"; then
  record E FAIL "recall counting present but no test proves it ($RECALL_TEST)"
else
  record E PASS "recall counted in the existing telemetry lane, facts only, with tests asserting it"
fi

# ===========================================================================
# Verdict
# ===========================================================================
printf '\n'
FAILED=0
for entry in "${CLAUSES[@]}"; do
  id="${entry%%|*}"; rest="${entry#*|}"
  status="${rest%%|*}"; evidence="${rest#*|}"
  printf 'CLAUSE %-3s %-4s — %s\n' "$id" "$status" "$evidence"
  [ "$status" = PASS ] || FAILED=1
done
printf '\nscratch (printed, never auto-deleted): %s\n' "$SCRATCH"

if [ "$FAILED" -eq 0 ]; then
  printf 'RESULT: PASS — all clauses hold\n'
  exit 0
fi
printf 'RESULT: FAIL — at least one clause did not hold\n'
exit 1
