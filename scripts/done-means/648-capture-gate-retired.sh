#!/usr/bin/env bash
# DONE-MEANS check for #648 — the capture merge-gate is RETIRED, not deleted.
#
#   bash scripts/done-means/648-capture-gate-retired.sh
#
# ---------------------------------------------------------------------------
# What this gates: operator ruling 2026-08-08, ledger item 25 (docs/issue-graph.md)
# ---------------------------------------------------------------------------
# Ledger item 24 made CAPTURE a hard merge gate. Item 25 AMENDS it: on the
# gate's first live firing it wedged the pipeline — it blocked the controller's
# merge of PR #645, including structurally blocking any fix's own merge. The
# ruling retires the tier permanently, for a reason bigger than the defects
# (#646): raw capture is AUTOMATIC (Stop hooks -> watermark -> durable spool),
# and DISTILLATION of raw sessions is the DREAM pipeline's designed job
# (docs/dream-design.md). The gate was hard-blocking merges to force HAND
# distillation of something the architecture already automates.
#
# KEPT from item 24, and asserted here so retirement cannot quietly take them
# with it: hydration verify+stamp, and recall telemetry. Neither can wedge.
# WHAT REPLACES the gate: an automatic-capture LIVENESS check (#647, the #625
# pattern) — out of scope for this check, which gates the retirement only.
#
# ---------------------------------------------------------------------------
# Why RETIRE and not DELETE
# ---------------------------------------------------------------------------
# capture-gate.ts contains a working server-side receipt probe, a drain step,
# and an outage-vs-skip discrimination. That is prior art for the #647 liveness
# lane, which has to answer the same question ("did the raw capture lane
# deliver for this session?") without the block. Deleting it would make #647
# rediscover it. So the file MOVES to .claude/hooks/_retired/ — off every hook
# path, still readable — and carries a header pointing at the ruling.
#
# ---------------------------------------------------------------------------
# Clauses
# ---------------------------------------------------------------------------
#   0   CONTROL — the observation window is live (bun runs, settings readable).
#       Harvest of #624: a dead harness hands every clause a false result.
#   A   .claude/settings.json contains ZERO capture-gate references anywhere.
#   B   .claude/hooks/capture-gate.ts no longer exists at the live hook path.
#   C   .claude/hooks/_retired/capture-gate.ts EXISTS and names the ruling
#       (ledger item 25) and the issues (#646/#647) — retire, not delete, and
#       the next reader is told why.
#   D   The registered hook set is EXACTLY the five survivors:
#       pr-body-gate, merge-gate, design-lookup-gate, design-contract,
#       hydration-stamp. Both directions: none missing, none extra. Without the
#       "none extra" half this clause would pass while a sixth hook crept in;
#       without "none missing" the retirement could take a survivor with it.
#   E   scripts/done-means/451-tiered-coverage.sh PASSES against the new state.
#       This is the clause that proves the retirement is COHERENT rather than
#       merely applied: 451 still owns the hydration and recall tiers, and it
#       must not be left asserting a gate that no longer exists.
#
# Exit 0 only when every clause passes. Exit 3 is a HARNESS error, which is NOT
# a failure of the thing under test.
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SETTINGS="$REPO_ROOT/.claude/settings.json"
LIVE_GATE="$REPO_ROOT/.claude/hooks/capture-gate.ts"
RETIRED_GATE="$REPO_ROOT/.claude/hooks/_retired/capture-gate.ts"
CHECK_451="$REPO_ROOT/scripts/done-means/451-tiered-coverage.sh"

fail_hard() {
  printf 'HARNESS-ERROR: %s\n' "$1" >&2
  exit 3
}

command -v bun >/dev/null 2>&1 || fail_hard "bun not on PATH"
command -v rg  >/dev/null 2>&1 || fail_hard "rg not on PATH"

CLAUSES=()
record() { CLAUSES+=("$1|$2|$3"); }

# ===========================================================================
# CLAUSE 0 — CONTROL. Prove the observation window is live before any verdict.
# ===========================================================================
if ! bun -e 'process.stdout.write("ok")' >/dev/null 2>&1; then
  record 0 FAIL "CONTROL: bun cannot execute — no clause below can be trusted"
elif [ ! -r "$SETTINGS" ]; then
  record 0 FAIL "CONTROL: $SETTINGS is not readable — clause A would pass vacuously"
else
  record 0 PASS "CONTROL: bun executes and settings.json is readable"
fi

# ===========================================================================
# CLAUSE A — zero capture-gate references in settings.json.
# Substring match on the bare name, not the .ts path: a reference in a comment
# key, a different matcher block, or a renamed command would still be a live
# registration path, and this clause is about the file being UNREACHABLE from
# the hook config at all.
# ===========================================================================
if [ ! -r "$SETTINGS" ]; then
  record A FAIL "no $SETTINGS to inspect"
elif rg -qF 'capture-gate' "$SETTINGS"; then
  record A FAIL "settings.json still references capture-gate — the wedge can still fire: $(rg -nF 'capture-gate' "$SETTINGS" | head -3 | tr '\n' ' ')"
else
  record A PASS "settings.json contains zero capture-gate references"
fi

# ===========================================================================
# CLAUSE B — the file is gone from the LIVE hook directory.
# Unregistering alone is not retirement: a hook sitting on the hook path is one
# settings edit from firing again, and reads as current to the next agent.
# ===========================================================================
if [ -e "$LIVE_GATE" ]; then
  record B FAIL "capture-gate.ts still sits on the live hook path ($LIVE_GATE)"
else
  record B PASS "capture-gate.ts is no longer on the live hook path"
fi

# ===========================================================================
# CLAUSE C — it exists under _retired/ WITH the pointer. Retire, don't delete:
# the receipt-probe code is prior art for the #647 liveness lane.
# ===========================================================================
if [ ! -r "$RETIRED_GATE" ]; then
  record C FAIL "no retired copy at $RETIRED_GATE — the receipt-probe prior art for #647 was deleted, not retired"
elif ! rg -qiF 'item 25' "$RETIRED_GATE"; then
  record C FAIL "retired copy exists but does not name the ruling (ledger item 25) — a reader cannot tell why it is here"
elif ! rg -qF '#646' "$RETIRED_GATE"; then
  record C FAIL "retired copy does not point at #646 (the gate's live defects)"
elif ! rg -qF '#647' "$RETIRED_GATE"; then
  record C FAIL "retired copy does not point at #647 (the liveness check that replaces it)"
else
  record C PASS "retired copy present at .claude/hooks/_retired/ naming ledger item 25, #646 and #647"
fi

# ===========================================================================
# CLAUSE D — the surviving hook set is EXACTLY the five named in the ruling.
# Extracted from the command strings actually registered, so this measures the
# config rather than the directory listing (a file on disk that nothing
# registers enforces nothing — the #451 clause-F lesson, inverted).
# ===========================================================================
EXPECTED_HOOKS="design-contract design-lookup-gate hydration-stamp merge-gate pr-body-gate"
if [ ! -r "$SETTINGS" ]; then
  record D FAIL "no $SETTINGS to inspect"
else
  ACTUAL_HOOKS="$(rg -o -e '\.claude/hooks/([a-z0-9-]+)\.ts' -r '$1' "$SETTINGS" | sort -u | tr '\n' ' ' | sed 's/ *$//')"
  if [ -z "$ACTUAL_HOOKS" ]; then
    record D FAIL "no hooks registered at all — the retirement took the survivors with it"
  elif [ "$ACTUAL_HOOKS" != "$EXPECTED_HOOKS" ]; then
    record D FAIL "registered hook set is not the five survivors — expected [$EXPECTED_HOOKS], found [$ACTUAL_HOOKS]"
  else
    record D PASS "registered hook set is exactly the five survivors [$ACTUAL_HOOKS]"
  fi
fi

# ===========================================================================
# CLAUSE E — 451's tiered-coverage check passes against the retired state.
# The kept tiers (hydration stamp, recall telemetry) must still be enforced;
# the capture clauses must no longer assert a gate that is gone.
# ===========================================================================
if [ ! -x "$CHECK_451" ] && [ ! -r "$CHECK_451" ]; then
  record E FAIL "no 451 tiered-coverage check at $CHECK_451"
else
  CHECK_451_OUT="$(bash "$CHECK_451" 2>&1)"
  CHECK_451_EXIT=$?
  if [ "$CHECK_451_EXIT" -ne 0 ]; then
    record E FAIL "451-tiered-coverage.sh exits $CHECK_451_EXIT against the retired state: $(printf '%s' "$CHECK_451_OUT" | rg -F 'FAIL' | head -3 | tr '\n' ' ')"
  elif ! printf '%s' "$CHECK_451_OUT" | rg -qF 'CLAUSE D '; then
    record E FAIL "451 passed but no longer runs its hydration clause D — the kept tier went missing with the retired one"
  elif ! printf '%s' "$CHECK_451_OUT" | rg -qF 'CLAUSE E '; then
    record E FAIL "451 passed but no longer runs its recall clause E — the kept tier went missing with the retired one"
  else
    record E PASS "451-tiered-coverage.sh PASSES against the retired state, hydration (D/D2) and recall (E) clauses still running"
  fi
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

if [ "$FAILED" -eq 0 ]; then
  printf '\nRESULT: PASS — the capture gate is retired, the survivors are intact\n'
  exit 0
fi
printf '\nRESULT: FAIL — at least one clause did not hold\n'
exit 1
