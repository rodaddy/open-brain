#!/usr/bin/env bash
# DONE-MEANS check for issue #578 — "E2E quality gate: scripted input/output
# scenarios + Langfuse egress verification".
#
#   bash scripts/done-means/578-e2e-gate.sh
#
# ---------------------------------------------------------------------------
# WHAT #578 ASKED FOR, AND WHAT WAS ALREADY BUILT
# ---------------------------------------------------------------------------
# The operator's ask (#578, 2026-08-05): "run a whole bunch of actual tests to
# verify things instead of me having to literally dogfood everything ... run
# some inputs and outputs via a script with expected information and also be
# able to check what's going out to my Langfuse and see that things are
# actually going correctly."
#
# #578's own "The delta (two pieces)" named exactly two, and BOTH SHIPPED:
#
#   1. Scenario breadth — `scripts/eval-open-brain-scenarios.ts` (PR #580,
#      commit 12e83fd) over `eval/open-brain/fixtures/scenarios-v1.json`,
#      driving the REAL contract surfaces: capture round-trip through the
#      shipped provider (`capture_round_trip`), durable_memory pack shape and
#      recall through the real MCP client (`durable_memory_shape`), and a
#      checkpoint/resume round-trip (`checkpoint_round_trip`).
#   2. Langfuse egress verification — `scripts/eval-langfuse-egress.ts`
#      (PR #579, commit 29f9261; hardened by #583/#584 and #586/a5a1274).
#
# So this check is NOT "build the gate". The gate exists. What #578 has never
# had is the thing that makes it a GATE rather than two commands an operator
# remembers to run in the right order with the right environment: ONE runnable
# entry point that composes both legs, proves the egress leg observed the
# traffic the scenario leg actually produced, and — the part neither leg can do
# for itself — proves the composed suite can still FAIL.
#
# ---------------------------------------------------------------------------
# WHY A CONTROL CLAUSE IS THE LOAD-BEARING PART
# ---------------------------------------------------------------------------
# Both legs have been observed GREEN live (operator receipt on #578, trunk
# a5a1274: drive PASS with watermark offset 1446, verify PASS with 1 trace /
# 4 observations / 3 generations / generation_metadata 3/3 / total_cost 3/3 /
# secret_scan clean over real content). A green run is not evidence a check
# discriminates. This repo has already paid for that lesson twice, in the
# record, on THIS issue:
#
#   - `secret_scan` reported PASS over ZERO traces in the first live run — a
#     vacuous green that #583 fixed by introducing `skipped-no-data` as a state
#     distinct from `pass` (scripts/eval-langfuse-egress.ts:70-80).
#   - `docs/lane-contract.md` Tightenings round 13: "A control clause that
#     passes PRE-fix is the signal the check discriminates ... a check that
#     fails everywhere proves only that it fails."
#
# Clause (d) below therefore feeds the scenario runner a DELIBERATELY WRONG
# expectation and requires a FAIL. Without it, a suite that had silently become
# a no-op — an empty fixture, a skipped leg, a transport that swallows every
# verdict — would bank a free GREEN forever, which is precisely the class of
# defect #578 exists to catch in everything else.
#
# ---------------------------------------------------------------------------
# NO WALL-CLOCK ASSERTIONS
# ---------------------------------------------------------------------------
# Egress visibility is inherently asynchronous: Langfuse ingests in batches, so
# a trace is not queryable the instant it is emitted. The forbidden shape
# (docs/lane-contract.md Tightenings round 5, #632/#634) is `sleep N; assert`.
# This check never sleeps-then-asserts. It delegates settling to the verifier's
# own BOUNDED POLL — `--settle-timeout` drives a poll loop that exits the
# moment the expected COUNTS arrive and reports `polls` and `timed_out`
# (scripts/eval-langfuse-egress.ts, `settle`). The assertion is on counts;
# elapsed time is only a bound on patience, never the thing measured. The
# operator's a5a1274 receipt settled in 1 poll.
#
# ---------------------------------------------------------------------------
# CLAUSES
# ---------------------------------------------------------------------------
#   (a) SCENARIOS — the scripted input/expected-output suite runs against the
#       live deployment named by OPEN_BRAIN_LIVE_EVAL_BASE_URL and every
#       scenario's observed output matches its fixture expectation. Exit 0 and
#       a receipt whose `passed` is true, with a non-zero scenario count (a
#       suite that ran nothing is not a pass — the #613 skip-count lesson).
#
#   (b) EGRESS DRIVE — driving real traffic under a unique run tag PROVES an
#       emit happened. `emit_proven` is fatal in the verifier precisely because
#       a hook's exit-zero contract cannot prove a capture occurred; the first
#       live run on #578 exited 0 while writing no watermark offset at all.
#
#   (c) EGRESS VERIFY — querying the Langfuse API for that SAME tag finds what
#       the drive produced: the expected trace/observation counts arrived
#       (`arrival_count`), GENERATION rows carry model + usage metadata
#       (`generation_metadata`), and the secret scan ran over REAL content
#       rather than reporting a vacuous green over nothing
#       (`secret_scan` must not be `skipped-no-data`).
#
#   (d) CONTROL — A DELIBERATELY WRONG EXPECTATION FAILS. The scenario runner
#       is re-run against a mutated fixture whose expectation cannot hold. It
#       MUST exit non-zero. If this clause passes (i.e. the wrong expectation
#       was accepted), the entire suite is non-discriminating and the check
#       reports FAIL no matter what (a)-(c) said.
#
#   (e) CONTROL — TEARDOWN. The scenario leg reports its own teardown tally and
#       nothing it created is left behind (`failed=0`). A gate that accretes
#       throwaway namespaces on every run is a gate nobody runs twice.
#
# ---------------------------------------------------------------------------
# ENVIRONMENT — WHY THIS IS OPT-IN AND WHERE THE VALUES COME FROM
# ---------------------------------------------------------------------------
# This gate talks to a REAL deployment and a REAL Langfuse instance, so it is
# opt-in and refuses to invent coordinates. It reads, and never writes or
# echoes, these variables:
#
#   OPEN_BRAIN_LIVE_EVAL=1                 mandatory opt-in (eval/open-brain/live/config.ts)
#   OPEN_BRAIN_LIVE_EVAL_BASE_URL          deployment under test
#   OPEN_BRAIN_LIVE_EVAL_TOKEN             admin/ob-admin token (namespace delegation)
#   OPEN_BRAIN_LANGFUSE_EGRESS=1           mandatory opt-in for the egress legs
#   OPENBRAIN_TRACING_ENABLED=1            } Langfuse read coordinates
#   OPENBRAIN_TRACING_ENDPOINT             } (scripts/eval-langfuse-egress.ts,
#   OPENBRAIN_TRACING_PUBLIC_KEY           }  readLangfuseEgressConfig)
#   OPENBRAIN_TRACING_SECRET_KEY           }
#   OPENBRAIN_CAPTURE_BASE_URL / _TOKEN    raw-capture coordinates for --drive
#     (or their OPENBRAIN_BASE_URL / OPENBRAIN_TOKEN aliases)
#
# NOTE, because this surprised this lane and will surprise the next one: the
# repo `.env` no longer carries live token VALUES. The neutrality scrub
# (PR #645) replaced them with empty placeholders, so `AUTH_TOKEN_ADMIN=` in
# `.env` has length 0. The credentials live in the environment of whatever
# process is actually serving the deployment. Assemble the environment from
# your own operator source before invoking; this script deliberately does not
# reach into a running process to harvest secrets.
#
# By design this is PORTABLE: point BASE_URL at the local clone or at core01
# and the same suite runs. Nothing here hard-codes a host.
#
# Output is content-free — clause names, statuses, counts, and check labels
# only. No trace bodies, no credentials, no record content.
#
# ---------------------------------------------------------------------------
# EXPECTED TO FAIL BEFORE THIS CHECK EXISTED
# ---------------------------------------------------------------------------
# There was no composed entry point at all, so clause (d) — the only clause
# that asks whether the suite can fail — had never been executed against this
# repo. RED for this check is its own absence plus an unproven discrimination
# claim; see the PR body for the transcript.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

FAILURES=0
pass() { printf 'PASS  %s\n' "$1"; }
fail() { printf 'FAIL  %s\n' "$1"; FAILURES=$((FAILURES + 1)); }
info() { printf 'INFO  %s\n' "$1"; }

SCENARIO_SCRIPT="scripts/eval-open-brain-scenarios.ts"
EGRESS_SCRIPT="scripts/eval-langfuse-egress.ts"
FIXTURE="eval/open-brain/fixtures/scenarios-v1.json"
CONTROL_DRIVER="scripts/done-means/578-e2e-gate.control.ts"
RECEIPT_READER="scripts/done-means/578-e2e-gate.receipt.ts"

for required in "$SCENARIO_SCRIPT" "$EGRESS_SCRIPT" "$FIXTURE" "$CONTROL_DRIVER" "$RECEIPT_READER"; do
  if [[ ! -f "$required" ]]; then
    fail "missing required component: $required"
  fi
done
if [[ ${FAILURES} -gt 0 ]]; then
  printf '\n=== DONE-MEANS #578: FAIL (%d) ===\n' "${FAILURES}"
  exit 1
fi

# ---------------------------------------------------------------------------
# Environment gate. A missing coordinate is an explicit REFUSAL, never a silent
# skip that exits 0 — the whole point of this gate is that it cannot quietly
# examine nothing.
# ---------------------------------------------------------------------------
MISSING=()
[[ "${OPEN_BRAIN_LIVE_EVAL:-}" == "1" ]] || MISSING+=("OPEN_BRAIN_LIVE_EVAL=1")
[[ -n "${OPEN_BRAIN_LIVE_EVAL_BASE_URL:-}" ]] || MISSING+=("OPEN_BRAIN_LIVE_EVAL_BASE_URL")
[[ -n "${OPEN_BRAIN_LIVE_EVAL_TOKEN:-}" ]] || MISSING+=("OPEN_BRAIN_LIVE_EVAL_TOKEN")
[[ "${OPEN_BRAIN_LANGFUSE_EGRESS:-}" == "1" ]] || MISSING+=("OPEN_BRAIN_LANGFUSE_EGRESS=1")
[[ "${OPENBRAIN_TRACING_ENABLED:-}" == "1" ]] || MISSING+=("OPENBRAIN_TRACING_ENABLED=1")
[[ -n "${OPENBRAIN_TRACING_ENDPOINT:-}" ]] || MISSING+=("OPENBRAIN_TRACING_ENDPOINT")
[[ -n "${OPENBRAIN_TRACING_PUBLIC_KEY:-}" ]] || MISSING+=("OPENBRAIN_TRACING_PUBLIC_KEY")
[[ -n "${OPENBRAIN_TRACING_SECRET_KEY:-}" ]] || MISSING+=("OPENBRAIN_TRACING_SECRET_KEY")
if [[ -z "${OPENBRAIN_CAPTURE_BASE_URL:-}${OPENBRAIN_BASE_URL:-}" ]]; then
  MISSING+=("OPENBRAIN_CAPTURE_BASE_URL (or OPENBRAIN_BASE_URL)")
fi
if [[ -z "${OPENBRAIN_CAPTURE_TOKEN:-}${OPENBRAIN_TOKEN:-}" ]]; then
  MISSING+=("OPENBRAIN_CAPTURE_TOKEN (or OPENBRAIN_TOKEN)")
fi

if [[ ${#MISSING[@]} -gt 0 ]]; then
  printf 'REFUSED  the #578 gate talks to a live deployment and a live Langfuse; it will not invent coordinates.\n'
  printf 'REFUSED  missing:\n'
  for name in "${MISSING[@]}"; do printf 'REFUSED    - %s\n' "$name"; done
  printf 'REFUSED  see the header of this file for where each value comes from.\n'
  printf '\n=== DONE-MEANS #578: REFUSED (environment incomplete; nothing was examined) ===\n'
  exit 2
fi

RUN_TAG="e2e578-$(date +%Y%m%d%H%M%S)-$(head -c 8 /dev/urandom | od -An -tx1 | tr -d ' \n')"
SETTLE_TIMEOUT="${OPEN_BRAIN_578_SETTLE_TIMEOUT:-90}"
EGRESS_COUNT="${OPEN_BRAIN_578_EVENT_COUNT:-3}"

info "repo:          ${REPO_ROOT}"
info "deployment:    ${OPEN_BRAIN_LIVE_EVAL_BASE_URL}"
info "run tag:       ${RUN_TAG}"
info "settle bound:  ${SETTLE_TIMEOUT}s (bounded poll on counts; never a sleep-then-assert)"

# Scratch goes to the repo's own temp-workspace bucket, NEVER `mktemp -d` and
# never `/tmp` or `$TMPDIR` — those are sandbox-local, so a runner, a Codex
# sandbox, and the host each see a different one and the receipts this gate
# writes would be invisible to whoever needs to read them
# (_DOCS/STANDARDS-core.md; AGENTS.md "NEVER /tmp"). Receipts are also the
# artifact an operator most wants AFTER a failure, so they are left in place
# rather than removed; the run tag makes each run's directory distinct.
SCRATCH_ROOT="${OPENBRAIN_TEMP_WORKSPACE:-/Volumes/ThunderBolt/_tmp}/open-brain/_scratch/578-e2e-gate"
WORK_DIR="${SCRATCH_ROOT}/${RUN_TAG}"
mkdir -p "${WORK_DIR}"
info "receipts:      ${WORK_DIR}"

SCENARIO_RECEIPT="${WORK_DIR}/scenario-receipt.json"
CONTROL_RECEIPT="${WORK_DIR}/control-receipt.json"

# ---------------------------------------------------------------------------
# (a) SCENARIOS — scripted input/expected-output against the live deployment.
# ---------------------------------------------------------------------------
printf '\n--- (a) scenario suite ---\n'
set +e
SCENARIO_LOG="$(bun run "${SCENARIO_SCRIPT}" --report "${SCENARIO_RECEIPT}" 2>&1)"
SCENARIO_EXIT=$?
set -e
printf '%s\n' "${SCENARIO_LOG}" | tail -20

if [[ ${SCENARIO_EXIT} -eq 0 ]]; then
  pass "(a) scenario suite exited 0"
else
  fail "(a) scenario suite exited ${SCENARIO_EXIT}"
fi

# Read through a real driver, never an inline `bun -e ... || echo 0`: that
# form cannot receive the path (bun -e forwards no argv) and its `||` default
# turns the resulting crash into a plausible-looking count. See the header of
# 578-e2e-gate.receipt.ts for the false FAIL this cost once already.
set +e
SCENARIO_COUNT="$(bun "${RECEIPT_READER}" "${SCENARIO_RECEIPT}" scenario_count 2>&1)"
COUNT_EXIT=$?
set -e
if [[ ${COUNT_EXIT} -ne 0 ]]; then
  fail "(a) could not read the scenario count from the receipt: ${SCENARIO_COUNT}"
  SCENARIO_COUNT=0
fi
if [[ "${SCENARIO_COUNT}" -gt 0 ]]; then
  pass "(a) suite really executed ${SCENARIO_COUNT} scenario(s) — not a silent empty run"
else
  fail "(a) receipt reported 0 scenarios; a suite that examined nothing is not a pass"
fi

# ---------------------------------------------------------------------------
# (e) CONTROL — teardown. Read from the same receipt.
# ---------------------------------------------------------------------------
printf '\n--- (e) control: teardown ---\n'
set +e
TEARDOWN_FAILED="$(bun "${RECEIPT_READER}" "${SCENARIO_RECEIPT}" teardown_failed 2>&1)"
TEARDOWN_EXIT=$?
set -e
if [[ ${TEARDOWN_EXIT} -ne 0 ]]; then
  fail "(e) teardown tally unreadable: ${TEARDOWN_FAILED}"
elif [[ "${TEARDOWN_FAILED}" == "0" ]]; then
  pass "(e) scenario teardown left nothing behind (failed=0)"
else
  fail "(e) scenario teardown failed=${TEARDOWN_FAILED} — the run left records behind"
fi

# ---------------------------------------------------------------------------
# (b) EGRESS DRIVE — prove an emit actually happened under this run's tag.
# ---------------------------------------------------------------------------
printf '\n--- (b) egress drive ---\n'
set +e
DRIVE_LOG="$(bun "${EGRESS_SCRIPT}" --drive --tag "${RUN_TAG}" --count "${EGRESS_COUNT}" 2>&1)"
DRIVE_EXIT=$?
set -e
printf '%s\n' "${DRIVE_LOG}" | tail -20
if [[ ${DRIVE_EXIT} -eq 0 ]]; then
  pass "(b) drive exited 0 with emit proven"
else
  fail "(b) drive exited ${DRIVE_EXIT} — traffic was not proven to reach the tracer"
fi

# ---------------------------------------------------------------------------
# (c) EGRESS VERIFY — query Langfuse for the SAME tag.
# ---------------------------------------------------------------------------
printf '\n--- (c) egress verify ---\n'
set +e
VERIFY_LOG="$(bun "${EGRESS_SCRIPT}" --verify --tag "${RUN_TAG}" --count "${EGRESS_COUNT}" \
  --settle-timeout "${SETTLE_TIMEOUT}" 2>&1)"
VERIFY_EXIT=$?
set -e
printf '%s\n' "${VERIFY_LOG}" | tail -25
if [[ ${VERIFY_EXIT} -eq 0 ]]; then
  pass "(c) verify exited 0 — expected traces/observations arrived at Langfuse"
else
  fail "(c) verify exited ${VERIFY_EXIT} — expected egress did not arrive"
fi

# A secret_scan that examined nothing is not a clean scan (#583). The verifier
# marks that state `skipped-no-data`; treat its presence as a clause failure
# even when the overall exit was 0.
if printf '%s' "${VERIFY_LOG}" | rg -q 'secret_scan.*skipped-no-data'; then
  fail "(c) secret_scan reported skipped-no-data — it scanned zero traces, which is a vacuous green"
else
  pass "(c) secret_scan examined real content rather than reporting a vacuous green"
fi

# ---------------------------------------------------------------------------
# (d) CONTROL — a deliberately-wrong expectation MUST fail.
# ---------------------------------------------------------------------------
printf '\n--- (d) control: a wrong expectation must FAIL ---\n'
MUTATED_FIXTURE="${WORK_DIR}/scenarios-wrong-expectation.json"
set +e
bun "${CONTROL_DRIVER}" --in "${FIXTURE}" --out "${MUTATED_FIXTURE}"
MUTATE_EXIT=$?
set -e
if [[ ${MUTATE_EXIT} -ne 0 || ! -f "${MUTATED_FIXTURE}" ]]; then
  fail "(d) could not build the mutated fixture; the control clause did not run"
else
  set +e
  CONTROL_LOG="$(bun run "${SCENARIO_SCRIPT}" --fixture "${MUTATED_FIXTURE}" \
    --report "${CONTROL_RECEIPT}" 2>&1)"
  CONTROL_EXIT=$?
  set -e
  printf '%s\n' "${CONTROL_LOG}" | tail -12
  if [[ ${CONTROL_EXIT} -ne 0 ]]; then
    pass "(d) the suite REJECTED a deliberately-wrong expectation (exit ${CONTROL_EXIT}) — it discriminates"
  else
    fail "(d) the suite ACCEPTED a deliberately-wrong expectation — it is non-discriminating and every green above is vacuous"
  fi
fi

printf '\n'
if [[ ${FAILURES} -eq 0 ]]; then
  printf '=== DONE-MEANS #578: PASS — scripted scenarios match their expectations, the traffic they produced is visible in Langfuse under this run tag, and a wrong expectation still fails. ===\n'
  exit 0
fi
printf '=== DONE-MEANS #578: FAIL (%d failing clause(s)) ===\n' "${FAILURES}"
exit 1
