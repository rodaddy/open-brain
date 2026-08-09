#!/usr/bin/env bash
# DONE-MEANS check for issue #662 — the acceptance gate, not the fix.
#
#   bash scripts/done-means/662-absent-namespace-scope-proof.sh
#
# ---------------------------------------------------------------------------
# The issue
# ---------------------------------------------------------------------------
# #654 (PR #657) made a namespace MISMATCH actionable: when the session_start
# lane comes back bound to a different namespace than the configured one, the
# provider now names the cause (the token's namespace won) and the remedy
# (OPENBRAIN_DELEGATE_NAMESPACE=1 with an admin/ob-admin token). That fix is
# guarded by `if "namespace" in lane and served != namespace`
# (_runtime_validation.py:107-116).
#
# The ABSENT case walks straight past it. A lane object carrying NO `namespace`
# key at all falls through to the generic comparison in `validate_exact_fields`,
# which reports:
#
#     session_start result did not prove exact Open Brain scope: namespace
#
# That is the dead-end-error class (Tightenings round 15). `namespace` is
# env-carried and is NEVER a request key — the fix's own comment at lines 93-99
# says so, and `_SCOPE_KEYS` in runtime.py rejects it on input. So the error
# names the one key the caller provably cannot supply, and the operator has
# nothing to act on. Same disease as #646 (`source`), one key over, and the
# same disease #654 cured for the sibling branch of the same `if`.
#
# ---------------------------------------------------------------------------
# Which boundary owns the fix (decided, with the evidence)
# ---------------------------------------------------------------------------
# The dispatch offered a server-side fix — "if the server omits the effective
# namespace, make it always return it." Checked, and the server does NOT omit
# it, on either implementation:
#
#   - server/tools/session-lifecycle.ts:13 (`startLaneFields`) and :144,:186
#     select/RETURN `namespace` on both the existing-lane and insert paths.
#     This is the SERVING tree (`bun run server/main.ts`, confirmed via
#     `lsof -nP -iTCP:3100`).
#   - src/tools/session-start.ts:9 (`LANE_COLUMNS`) does the same on the
#     non-serving tree.
#   - server/tools/lanes.ts:93 — the mcp2cli fallback's `lane_upsert` returns
#     `namespace: auth.namespace` explicitly.
#   - Observed live 2026-08-08 against 127.0.0.1:3100: a raw `tools/call` of
#     `session_start` returned `"namespace":"admin"` in the lane object.
#
# So there is no server-side omission to fix, and adding a redundant "always
# return it" would be a change to code that already does it. The defect is
# entirely in the validator: it has a hostile-input branch it handles badly.
# The lane object is UNTRUSTED input — it is the thing being validated — so
# "our server always sends it" is not a reason to leave the absent branch
# dead-ended. A future server version, a proxy, a mocked client, or the
# mcp2cli fallback shape drifting all reach it, and #662 was filed because a
# real run DID reach it.
#
# The fix is therefore CLIENT-SIDE and narrow: the absent case gets its own
# refusal, naming what an operator can actually check, and it stays a
# REFUSAL — accepting a lane that never proved its namespace is the silent
# mis-scope #654 exists to prevent.
#
# ---------------------------------------------------------------------------
# #529 — checked, and NOT covered by this fix
# ---------------------------------------------------------------------------
# #529 (CLOSED) reported `... exact Open Brain scope: agent, channel_id,
# source` from the same `validate_exact_fields` call. Those three keys differ
# from `namespace` in the way that matters here: they ARE request keys. The
# caller sends `agent`, `platform` (reported as `platform`, compared as
# `source`), and `channel_id` in the scope object, so naming them is already
# actionable — the operator has a field to correct. `namespace` is the sole
# scope key with no request spelling, which is exactly why it needed #654 and
# needs this. Clause (d) below pins that distinction so a future "improvement"
# cannot quietly reroute the request-key shapes into a namespace-flavoured
# message. #529 needs no further work from this issue; if its shapes are ever
# judged insufficiently actionable, that is its own lane.
#
# ---------------------------------------------------------------------------
# Clauses
# ---------------------------------------------------------------------------
#   (a) RED ANCHOR — a lane with NO `namespace` key produces the generic
#       dead-end error today. INVERTS at the fix: pre-fix the dead end is
#       PRESENT (gate FAILS), post-fix it must be ABSENT.
#
#   (b) THE ABSENT REFUSAL IS ACTIONABLE — the new error names the configured
#       namespace, says the response never proved it, and points at something
#       checkable. Asserted on the ERROR TEXT, not the status, because a
#       refusal that refuses for an unsayable reason is the defect.
#
#   (c) STILL A REFUSAL — the absent case must NOT become a pass. A lane that
#       never proved its namespace is not permission to write; this clause
#       exists so the gate cannot be satisfied by deleting the check. Reads
#       the receipt: durable false, status not SAVED.
#
#   (d) CONTROL, #657 MISMATCH UNCHANGED — the mismatch branch still names the
#       served namespace, the configured one, and OPENBRAIN_DELEGATE_NAMESPACE.
#       Must pass BOTH pre-fix and post-fix; if it ever goes red, the absent
#       fix ate its sibling.
#
#   (e) CONTROL, #529's REQUEST-KEY SHAPES UNCHANGED — a lane wrong on `agent`
#       still reports `agent` by name, and does NOT get rerouted into the
#       namespace message. Proves the fix is scoped to the one key with no
#       request spelling.
#
#   (f) CONTROL, HEALTHY PATH — a fully-correct lane still validates clean.
#       Without it, breaking everything would score as progress.
#
# Clauses (a)-(f) are HERMETIC: they drive the SHIPPED validator in-process
# with constructed lane objects. No service, no database, no credentials. Per
# ledger 26.2 (hermetic-default) this is deliberate — the absent-namespace lane
# is not a shape the current server can emit (see the boundary section), so a
# live clause could only ever confirm what is already known and would go stale
# on the next redeploy. There is no post-deploy clause because there is no
# server-side change to deploy: the fix ships with the Python package.
#
# Output is statuses and key names only. No tokens, no memory bodies.
#
# EXPECTED TO FAIL until #662 is fixed. It is the reward function, not a test
# of the fix's author.
set -uo pipefail

REPO_ROOT="${OPENBRAIN_REPO_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
PKG_DIR="$REPO_ROOT/python/openbrain-memory"

fail_hard() {
  printf 'HARNESS-ERROR: %s\n' "$1" >&2
  exit 3
}

[ -d "$PKG_DIR" ] || fail_hard "python package not found at $PKG_DIR"
command -v uv >/dev/null 2>&1 || fail_hard "uv not on PATH (provider runner)"

printf 'subject    : %s\n' "$PKG_DIR/src/openbrain_memory/_runtime_validation.py"
printf 'mode       : hermetic (in-process validator; no service, no database)\n\n'

DRIVER="$REPO_ROOT/scripts/done-means/662_absent_namespace_driver.py"
[ -r "$DRIVER" ] || fail_hard "driver not readable at $DRIVER"

( cd "$PKG_DIR" && uv run python "$DRIVER" )
STATUS=$?

# The driver owns the verdict line and the exit code. A non-zero status that is
# not 1 means the driver itself broke (import error, uv failure) rather than a
# clause failing — that is a harness error, not a RED, and conflating the two
# is how a false RED banks confidence in a check that measured nothing
# (Tightenings round 16/18).
if [ "$STATUS" -ne 0 ] && [ "$STATUS" -ne 1 ]; then
  fail_hard "driver exited $STATUS — this is a harness failure, not a clause failure"
fi
exit "$STATUS"
