#!/usr/bin/env bash
# DONE-MEANS check for operator-approved improvement #1 (ledger context
# 2026-08-08): "make controller verification a deterministic command and make
# merge demand its receipt."
#
#   bash scripts/done-means/merge-gate-and-verify-lane.sh
#
# ---------------------------------------------------------------------------
# The architecture this gates
# ---------------------------------------------------------------------------
# Operator-ratified design, verbatim:
#
#   "Agent produces, script judges, hook enforces — three layers, each doing
#    the only thing it's good at."
#
# The two layers built here:
#
#   scripts/verify-lane.ts     the JUDGE. Re-runs a PR's done-means check in a
#                              fresh worktree of the PR HEAD and, only on exit
#                              0, posts a structured `verify-lane receipt:`
#                              comment carrying the head SHA it actually ran
#                              against. It never trusts a lane's report.
#
#   .claude/hooks/merge-gate.ts the ENFORCER. PreToolUse on Bash; refuses a
#                              parsed `gh pr merge <n>` unless (a) a receipt
#                              exists whose SHA equals the PR's CURRENT head,
#                              and (b) the harvest ratchet (ledger item 19)
#                              was satisfied. It makes NO judgment calls — it
#                              compares strings that gh gives it.
#
# The staleness case is the whole point of (a). A receipt is evidence about ONE
# commit. If the lane pushes after verification, the receipt describes code that
# is no longer what would merge, and a gate that accepted it would be worse than
# no gate — it would launder an unverified push through a real-looking receipt.
#
# ---------------------------------------------------------------------------
# Why the NON-FIRING clauses are half this file
# ---------------------------------------------------------------------------
# Issue #618 is this repo's standing scar: a text-matching git guard fired on
# heredoc TEXT — words inside a string a lane was WRITING, not a command it was
# RUNNING — and taxed every lane until fixed. `.claude/hooks/pr-body-gate.ts`
# is the anti-#618 template (parsed arguments, shell-quoting tokenizer, heredoc
# bodies stripped before parsing) and merge-gate.ts must share that parser
# rather than fork a divergent copy. Clauses 5a-5c are the standing proof, and
# they fail loudly if anyone "simplifies" this into a substring match.
#
# ---------------------------------------------------------------------------
# Clauses
# ---------------------------------------------------------------------------
# Hook, synthetic payloads + a stubbed `gh` fixture transcript on PATH:
#   1   gh pr merge 999, no receipt at all          -> REFUSED, names the gate
#   2   receipt SHA != current head (STALE)         -> REFUSED, names BOTH SHAs
#   3   fresh receipt + harvest via changed file    -> ALLOWED
#   3b  fresh receipt + "No new lessons:" reason    -> ALLOWED
#   3c  fresh receipt + "harvested:" commit ref     -> ALLOWED
#   4   fresh receipt, harvest SILENT               -> REFUSED, quotes ratchet
#   4b  fresh receipt + placeholder no-lessons      -> REFUSED (placeholder)
#   5a  gh pr view 999                              -> ALLOWED (not a merge)
#   5b  echo '... gh pr merge 999 ...'              -> ALLOWED (string literal)
#   5c  git commit heredoc containing "gh pr merge" -> ALLOWED (#618)
#   6   gh unavailable / gh failure                 -> REFUSED with named reason
#   7   the gate is REGISTERED in .claude/settings.json
#
# verify-lane, static + live:
#   8   no done-means resolvable                    -> non-zero, names what is
#                                                     missing (never silent)
#   9   LIVE: run against a real PR; on a passing check a receipt comment
#       appears carrying the check path, exit code, the head SHA observed at
#       run time, and an ISO timestamp. Uses an existing open PR when one
#       exists; otherwise creates a throwaway draft PR, proves it, and the
#       teardown commands are PRINTED (ledger item 15) unless the check made
#       the PR itself, in which case the narrow auto-drop exception (ledger
#       item 20: self-created this run, prefix-guarded, session-scoped) applies.
#
# CONTROL CLAUSE (harvest of #624, lane-contract.md 2026-08-08): a live check
# needs proof its observation window was live, or a dead system hands every RED
# a false pass. Clause 0 proves `gh` reaches the repo and the hook harness can
# build payloads BEFORE any clause is allowed to bank a result.
#
# Verdict convention matches pr-body-gate.ts: exit 2 = blocked with the reason
# on stderr, exit 0 = allowed.
#
# Exit 0 only when every clause passes AND nothing was skipped.
#   0  every clause passed; the live clause ran
#   1  at least one clause FAILED
#   3  HARNESS-ERROR — missing tool, unreachable gh, or a POLLUTED ENVIRONMENT
#      (an MGVL_IN_VERIFY_LANE / MGVL_LIVE_PR value that no real verify-lane run
#      produces). Not a fail of the thing under test; the inputs are untrusted.
#   4  every clause passed BUT the live clause was legitimately SKIPPED because
#      this run is nested inside verify-lane. Skipped is not passed: verify-lane
#      is UNPROVEN by this transcript. Distinct from 1 so a nested run is never
#      misread as a regression, and non-zero so it is never misread as proof.
#
# Before #721 the nested/polluted paths both returned 0 with clause 9 recorded
# PASS, so `MGVL_IN_VERIFY_LANE=anything` produced a full green in which the
# only live proof never executed.
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
HOOK="$REPO_ROOT/.claude/hooks/merge-gate.ts"
VERIFY="$REPO_ROOT/scripts/verify-lane.ts"
SETTINGS="$REPO_ROOT/.claude/settings.json"

# Repo-relative scratch. NEVER an absolute machine path: a hardcoded
# /Volumes/... default died with EACCES on the Linux CI runner
# (lane-contract.md Tightenings, 2026-08-08).
RUN_ID="mgvl_$$_$(date +%s)"
SCRATCH="$REPO_ROOT/_scratch/$RUN_ID"

fail_hard() {
  printf 'HARNESS-ERROR: %s\n' "$1" >&2
  exit 3
}

command -v bun >/dev/null 2>&1 || fail_hard "bun not on PATH"
command -v gh  >/dev/null 2>&1 || fail_hard "gh not on PATH"
mkdir -p "$SCRATCH" || fail_hard "cannot create scratch dir $SCRATCH"

CLAUSES=()
record() { CLAUSES+=("$1|$2|$3"); }

# ===========================================================================
# CLAUSE 0 — CONTROL. Prove the observation window is live before trusting any
# other verdict. Without this a dead `gh` makes every refusal-clause pass for
# the wrong reason and every allow-clause fail for the wrong reason.
# ===========================================================================
CONTROL_OK=1
REPO_NWO="$(gh repo view --json nameWithOwner -q .nameWithOwner 2>/dev/null)"
if [ -z "$REPO_NWO" ]; then
  record 0 FAIL "CONTROL: gh cannot reach the repo — no live clause below can be trusted"
  CONTROL_OK=0
else
  record 0 PASS "CONTROL: gh reaches $REPO_NWO — observation window is live"
fi

# ===========================================================================
# The gh STUB. The hook must be driven against controlled receipt/harvest data
# without touching the network, so PATH is prefixed with a shim whose canned
# transcript is read from files this script writes. The shim answers the exact
# gh shapes the hook is allowed to use and FAILS LOUDLY on any other shape —
# an unstubbed call would otherwise silently hit the network and make a clause
# measure something other than what it claims.
# ===========================================================================
STUB_DIR="$SCRATCH/stub-bin"
mkdir -p "$STUB_DIR" || fail_hard "cannot create stub dir"

cat > "$STUB_DIR/gh" <<'STUB'
#!/usr/bin/env bash
# Fixture-transcript `gh`. Reads canned responses from $MG_FIXTURE_DIR.
# Any un-stubbed shape exits 97 so a clause can never silently pass by
# reaching the real network.
set -uo pipefail
FIX="${MG_FIXTURE_DIR:?MG_FIXTURE_DIR unset}"

if [ "${MG_GH_BROKEN:-0}" = "1" ]; then
  printf 'gh: simulated failure (MG_GH_BROKEN)\n' >&2
  exit 1
fi

args="$*"
case "$args" in
  *"pr view"*"--json"*)
    # One JSON blob covers headRefOid, body, comments, files — the hook may ask
    # for any subset; jq-style -q filtering is done by the hook, not here.
    cat "$FIX/pr-view.json"
    exit 0
    ;;
esac
printf 'gh STUB: unstubbed invocation: %s\n' "$args" >&2
exit 97
STUB
chmod +x "$STUB_DIR/gh" || fail_hard "cannot chmod stub gh"

FIXTURES="$SCRATCH/fixtures"
mkdir -p "$FIXTURES" || fail_hard "cannot create fixtures dir"

CURRENT_SHA="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
STALE_SHA="bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"

# Build a pr-view.json fixture.
#   $1 dir  $2 headRefOid  $3 body  $4 comments-json-array  $5 files-json-array
write_fixture() {
  local dir="$1" head="$2" body="$3" comments="$4" files="$5"
  mkdir -p "$dir" || fail_hard "cannot create fixture dir $dir"
  MG_HEAD="$head" MG_BODY="$body" MG_COMMENTS="$comments" MG_FILES="$files" \
  bun -e '
    const comments = JSON.parse(process.env.MG_COMMENTS ?? "[]");
    const files = JSON.parse(process.env.MG_FILES ?? "[]");
    process.stdout.write(JSON.stringify({
      number: 999,
      headRefOid: process.env.MG_HEAD ?? "",
      body: process.env.MG_BODY ?? "",
      comments: comments.map((c) => ({ body: c })),
      files: files.map((f) => ({ path: f })),
    }, null, 2));
  ' > "$dir/pr-view.json" || fail_hard "cannot write fixture $dir"
}

RECEIPT_FRESH="verify-lane receipt: check=scripts/done-means/merge-gate-and-verify-lane.sh exit=0 sha=$CURRENT_SHA at=2026-08-08T12:00:00.000Z"
RECEIPT_STALE="verify-lane receipt: check=scripts/done-means/merge-gate-and-verify-lane.sh exit=0 sha=$STALE_SHA at=2026-08-08T11:00:00.000Z"

# 1. no receipt at all, harvest present
write_fixture "$FIXTURES/no-receipt" "$CURRENT_SHA" \
  "## Summary\n\nNo new lessons: the change is a pure rename with no new failure modes observed." \
  '[]' '["src/thing.ts"]'

# 2. stale receipt, harvest present
write_fixture "$FIXTURES/stale-receipt" "$CURRENT_SHA" \
  "No new lessons: the change is a pure rename with no new failure modes observed." \
  "$(printf '["%s"]' "$RECEIPT_STALE")" '["src/thing.ts"]'

# 3. fresh receipt, harvest via CHANGED FILE docs/lane-contract.md
write_fixture "$FIXTURES/ok-file" "$CURRENT_SHA" \
  "## Summary\n\nnothing about lessons here" \
  "$(printf '["%s"]' "$RECEIPT_FRESH")" '["src/thing.ts","docs/lane-contract.md"]'

# 3b. fresh receipt, harvest via "No new lessons:" with a real reason
write_fixture "$FIXTURES/ok-nolessons" "$CURRENT_SHA" \
  "## Summary

No new lessons: every refusal this lane hit was already recorded in the Tightenings changelog." \
  "$(printf '["%s"]' "$RECEIPT_FRESH")" '["src/thing.ts"]'

# 3c. fresh receipt, harvest via a "harvested:" comment with a commit ref
write_fixture "$FIXTURES/ok-harvested" "$CURRENT_SHA" \
  "## Summary\n\nnothing here" \
  "$(printf '["%s","harvested: 5dd3db8 docs/lane-contract.md Tightenings entry for this lane"]' "$RECEIPT_FRESH")" \
  '["src/thing.ts"]'

# 4. fresh receipt, harvest SILENT
write_fixture "$FIXTURES/silent" "$CURRENT_SHA" \
  "## Summary\n\njust a change, nothing said about lessons" \
  "$(printf '["%s"]' "$RECEIPT_FRESH")" '["src/thing.ts"]'

# 4b. fresh receipt, PLACEHOLDER no-lessons reason
write_fixture "$FIXTURES/placeholder" "$CURRENT_SHA" \
  "## Summary

No new lessons: n/a" \
  "$(printf '["%s"]' "$RECEIPT_FRESH")" '["src/thing.ts"]'

# ---------------------------------------------------------------------------
# Drive the hook the way Claude Code does: a PreToolUse JSON payload on stdin,
# with the stub gh first on PATH. Sets HOOK_EXIT and HOOK_STDERR.
# ---------------------------------------------------------------------------
HOOK_EXIT=0
HOOK_STDERR=""
run_hook() {
  local command_text="$1" fixture_dir="${2:-$FIXTURES/no-receipt}" broken="${3:-0}"
  local payload
  payload="$(
    COMMAND_TEXT="$command_text" bun -e '
      process.stdout.write(JSON.stringify({
        session_id: "merge-gate-done-means",
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_input: { command: process.env.COMMAND_TEXT ?? "" },
      }));
    '
  )" || fail_hard "could not build hook payload"

  HOOK_STDERR="$(
    printf '%s' "$payload" | \
      PATH="$STUB_DIR:$PATH" \
      MG_FIXTURE_DIR="$fixture_dir" \
      MG_GH_BROKEN="$broken" \
      bun "$HOOK" --event pre-tool-use 2>&1 >/dev/null
  )"
  HOOK_EXIT=$?
}

if [ ! -r "$HOOK" ]; then
  # RED state: nothing enforces merge. Every hook clause fails for one honest
  # reason rather than erroring out, so the RED transcript stays legible.
  for c in 1 2 3 3b 3c 4 4b 5a 5b 5c 6 7; do
    record "$c" FAIL "no hook at $HOOK — nothing is gating gh pr merge"
  done
else
  # -- CLAUSE 1: no receipt -> REFUSED, by name --
  run_hook "gh pr merge 999 --squash" "$FIXTURES/no-receipt"
  if [ "$HOOK_EXIT" -ne 2 ]; then
    record 1 FAIL "merge with NO receipt was allowed (exit=$HOOK_EXIT) — the gate is off"
  elif ! printf '%s' "$HOOK_STDERR" | rg -qF 'merge-gate'; then
    record 1 FAIL "refused but the refusal never names merge-gate"
  elif ! printf '%s' "$HOOK_STDERR" | rg -qF 'verify-lane'; then
    record 1 FAIL "refused but never prints the command that satisfies it"
  else
    record 1 PASS "no receipt refused (exit=2), names the gate and the satisfying command"
  fi

  # -- CLAUSE 2: STALE receipt -> REFUSED naming BOTH SHAs. The core case. --
  run_hook "gh pr merge 999 --squash" "$FIXTURES/stale-receipt"
  if [ "$HOOK_EXIT" -ne 2 ]; then
    record 2 FAIL "STALE receipt was ACCEPTED (exit=$HOOK_EXIT) — an unverified push would merge behind a real-looking receipt"
  elif ! printf '%s' "$HOOK_STDERR" | rg -qF "$STALE_SHA"; then
    record 2 FAIL "refused but never names the receipt's recorded SHA"
  elif ! printf '%s' "$HOOK_STDERR" | rg -qF "$CURRENT_SHA"; then
    record 2 FAIL "refused but never names the PR's current head SHA"
  elif ! printf '%s' "$HOOK_STDERR" | rg -qi -e 'stale|mismatch|no longer'; then
    record 2 FAIL "refused but never says the receipt is STALE — the reason must be legible"
  else
    record 2 PASS "stale receipt refused (exit=2) naming both the recorded SHA and the current head"
  fi

  # -- CLAUSE 3: fresh receipt + harvest via changed file -> ALLOWED --
  run_hook "gh pr merge 999 --squash" "$FIXTURES/ok-file"
  if [ "$HOOK_EXIT" -eq 0 ]; then
    record 3 PASS "fresh receipt + docs/lane-contract.md changed -> allowed (exit=0)"
  else
    record 3 FAIL "valid merge blocked (exit=$HOOK_EXIT): $(printf '%s' "$HOOK_STDERR" | tr '\n' ' ' | cut -c1-300)"
  fi

  # -- CLAUSE 3b: fresh receipt + a real "No new lessons:" reason -> ALLOWED --
  run_hook "gh pr merge 999 --squash" "$FIXTURES/ok-nolessons"
  if [ "$HOOK_EXIT" -eq 0 ]; then
    record 3b PASS "fresh receipt + non-placeholder 'No new lessons:' -> allowed (exit=0)"
  else
    record 3b FAIL "valid merge blocked (exit=$HOOK_EXIT): $(printf '%s' "$HOOK_STDERR" | tr '\n' ' ' | cut -c1-300)"
  fi

  # -- CLAUSE 3c: fresh receipt + a "harvested:" comment -> ALLOWED --
  run_hook "gh pr merge 999 --squash" "$FIXTURES/ok-harvested"
  if [ "$HOOK_EXIT" -eq 0 ]; then
    record 3c PASS "fresh receipt + 'harvested: <ref>' comment -> allowed (exit=0)"
  else
    record 3c FAIL "valid merge blocked (exit=$HOOK_EXIT): $(printf '%s' "$HOOK_STDERR" | tr '\n' ' ' | cut -c1-300)"
  fi

  # -- CLAUSE 4: harvest SILENT -> REFUSED, quoting the ratchet rule --
  run_hook "gh pr merge 999 --squash" "$FIXTURES/silent"
  if [ "$HOOK_EXIT" -ne 2 ]; then
    record 4 FAIL "silent harvest was allowed (exit=$HOOK_EXIT) — the ratchet is optional, i.e. dead"
  elif ! printf '%s' "$HOOK_STDERR" | rg -qi -e 'ratchet|harvest'; then
    record 4 FAIL "refused but never names the harvest/ratchet rule"
  elif ! printf '%s' "$HOOK_STDERR" | rg -qF 'No new lessons:'; then
    record 4 FAIL "refused but never prints the exact line that would satisfy it"
  else
    record 4 PASS "silent harvest refused (exit=2), quoting the ratchet and the satisfying line"
  fi

  # -- CLAUSE 4b: PLACEHOLDER no-lessons reason -> REFUSED --
  run_hook "gh pr merge 999 --squash" "$FIXTURES/placeholder"
  if [ "$HOOK_EXIT" -eq 2 ]; then
    record 4b PASS "placeholder 'No new lessons: n/a' refused (exit=2) — a reason must state something"
  else
    record 4b FAIL "placeholder reason ACCEPTED (exit=$HOOK_EXIT) — the ratchet is satisfiable with noise"
  fi

  # -- CLAUSE 5a: a gh pr command that is not a merge is ALLOWED --
  run_hook "gh pr view 999" "$FIXTURES/no-receipt"
  if [ "$HOOK_EXIT" -eq 0 ]; then
    record 5a PASS "gh pr view 999 allowed (exit=0)"
  else
    record 5a FAIL "gh pr view was blocked (exit=$HOOK_EXIT) — the gate is over-firing"
  fi

  # -- CLAUSE 5b: the phrase inside a string literal is NOT an invocation --
  run_hook "echo 'remember to gh pr merge 999 --squash after review'" "$FIXTURES/no-receipt"
  if [ "$HOOK_EXIT" -eq 0 ]; then
    record 5b PASS "echo of a string literal containing 'gh pr merge' allowed (exit=0)"
  else
    record 5b FAIL "echo'd string literal blocked (exit=$HOOK_EXIT) — substring matching, the #618 defect"
  fi

  # -- CLAUSE 5c: #618 proper. "gh pr merge" inside heredoc TEXT. --
  HEREDOC_CMD="git commit -F - <<'EOF'
docs: record the merge procedure

The controller runs:

    gh pr merge 999 --squash --delete-branch

only after verify-lane has posted its receipt.
EOF"
  run_hook "$HEREDOC_CMD" "$FIXTURES/no-receipt"
  if [ "$HOOK_EXIT" -eq 0 ]; then
    record 5c PASS "git commit heredoc containing 'gh pr merge' allowed (exit=0) — #618 not reintroduced"
  else
    record 5c FAIL "heredoc TEXT triggered the gate (exit=$HOOK_EXIT) — exactly the #618 defect"
  fi

  # -- CLAUSE 6: gh failure REFUSES OUT LOUD (no silent allow) --
  run_hook "gh pr merge 999 --squash" "$FIXTURES/ok-file" 1
  if [ "$HOOK_EXIT" -ne 2 ]; then
    record 6 FAIL "a failing gh silently ALLOWED the merge (exit=$HOOK_EXIT) — the gate turns itself off"
  elif ! printf '%s' "$HOOK_STDERR" | rg -qF 'merge-gate'; then
    record 6 FAIL "refused but does not name the gate"
  elif ! printf '%s' "$HOOK_STDERR" | rg -qi -e 'could not|cannot|failed'; then
    record 6 FAIL "refused but never says gh could not be queried — a silent block"
  else
    record 6 PASS "gh failure refused (exit=2) with an explicit named reason, never silent"
  fi

  # -- CLAUSE 7: the gate is REGISTERED, not merely written --
  if [ ! -r "$SETTINGS" ]; then
    record 7 FAIL "no $SETTINGS — an unregistered hook never fires"
  elif MG_SETTINGS="$SETTINGS" bun -e '
      const s = JSON.parse(require("node:fs").readFileSync(process.env.MG_SETTINGS, "utf8"));
      const pre = s?.hooks?.PreToolUse ?? [];
      const ok = pre.some((g) =>
        String(g.matcher ?? "").split("|").includes("Bash") &&
        (g.hooks ?? []).some((h) => String(h.command ?? "").includes("merge-gate.ts")));
      process.exit(ok ? 0 : 1);
    '; then
    record 7 PASS "merge-gate.ts registered as a PreToolUse hook on Bash in .claude/settings.json"
  else
    record 7 FAIL "merge-gate.ts is NOT registered on Bash PreToolUse — written is not running"
  fi
fi

# ===========================================================================
# verify-lane clauses
# ===========================================================================
if [ ! -r "$VERIFY" ]; then
  record 8 FAIL "no verify-lane at $VERIFY — controller verification is not a command"
  record 9 FAIL "no verify-lane at $VERIFY — cannot run it against a live PR"
else
  # -- CLAUSE 8: unresolvable done-means fails LOUDLY, naming what is missing --
  # Driven with the stub gh so the PR body genuinely carries no Done-means line
  # and no --check flag is passed.
  #
  # MGVL_VERIFY_LANE_PRS IS DELIBERATELY CLEARED. When the controller runs
  # verify-lane on the PR that CONTAINS this check, that variable is inherited
  # by everything below it, and verify-lane's re-entry guard then refuses this
  # clause's nested call BEFORE reaching done-means resolution. The clause would
  # then be measuring the recursion guard rather than the error path it names —
  # a false RED that says "never names the Done-means line" when the code that
  # prints that line was never reached. Observed 2026-08-08 in exactly that
  # position: green standalone, red under controller verification.
  #
  # Clearing it is correct rather than a workaround: this clause spawns a
  # SYNTHETIC verify-lane against a stubbed PR #999 that runs no check and
  # cannot recurse, so the guard has nothing to protect here. Clause 9 is where
  # nesting actually matters, and it still honours MGVL_IN_VERIFY_LANE — but
  # since #721 only when the marker is CORROBORATED by MGVL_VERIFY_LANE_PRS,
  # never on its mere presence.
  #
  # Note this clearing is the DEFENSIVE use of the same variables: it BREAKS
  # inheritance rather than trusting it, and says why in the paragraph above.
  # That is the opposite of the #721 defect and is left as it is.
  V_OUT="$(
    PATH="$STUB_DIR:$PATH" MG_FIXTURE_DIR="$FIXTURES/no-receipt" MG_GH_BROKEN=0 \
      MGVL_VERIFY_LANE_PRS="" MGVL_IN_VERIFY_LANE="" \
      bun "$VERIFY" 999 2>&1
  )"
  V_EXIT=$?
  if [ "$V_EXIT" -eq 0 ]; then
    record 8 FAIL "verify-lane exited 0 with no done-means check to run — a silent free pass"
  elif ! printf '%s' "$V_OUT" | rg -qF 'Done-means'; then
    record 8 FAIL "failed but never names the missing '- Done-means: <path>' line (exit=$V_EXIT)"
  elif ! printf '%s' "$V_OUT" | rg -qF -- '--check'; then
    record 8 FAIL "failed but never names the --check <path> alternative (exit=$V_EXIT)"
  else
    record 8 PASS "no resolvable done-means -> exit=$V_EXIT naming both the body line and --check"
  fi

  # -- CLAUSE 9: LIVE. Real PR, real worktree, real receipt comment. --
  #
  # RE-ENTRY GUARD. Measured 2026-08-08, running this check for real: when the
  # controller runs `verify-lane <pr>` on the PR that CONTAINS this check,
  # verify-lane runs this file, whose live clause finds that same PR open and
  # calls verify-lane on it again — unbounded recursion, each level standing up
  # a fresh worktree and a bun install. It spawned 331 worktrees before it was
  # killed by hand.
  #
  # This is the check being its own subject: nothing else in scripts/done-means/
  # invokes the tool that invokes it. verify-lane exports MGVL_IN_VERIFY_LANE so
  # the live clause can recognise it is already INSIDE the mechanism it wants to
  # exercise, and report that honestly instead of recursing. The outer run is
  # the one that proves clause 9; a nested run skipping it is not a silent pass,
  # because the reason is printed and the clause is marked SKIP-BY-GUARD.
  #
  # THE GUARD MUST BE EARNED, NOT ASSERTED (#721; family B of the 2026-08-10
  # gate-layer audit — a gate letting its ENVIRONMENT decide the verdict).
  # Until this fix the condition tested the variable's PRESENCE, so
  #
  #     MGVL_IN_VERIFY_LANE=fabricated-value bash <this file>
  #
  # recorded clause 9 as PASS and exited 0: a full-green transcript in which the
  # only live proof never ran. A stale export, a CI env leak, or a hand-set
  # value silently disabled the one clause that exercises verify-lane end to
  # end, and the output was indistinguishable from a genuine run.
  #
  # This does NOT weaken the guard, and the recursion it prevents is real (331
  # worktrees, measured above). The authoritative guard remains verify-lane's
  # own depth counter (verify-lane.ts:287-330) — deliberately in the spawning
  # process because a guard living in the repo cannot protect a run that checks
  # out an older commit of that repo. THIS clause is the POLITE layer
  # (verify-lane.ts:283-286): it exists so a genuinely nested run reports
  # legibly instead of being refused. A polite layer that any string can
  # trigger is not politeness, it is an off switch.
  #
  # verify-lane.ts:479-480 sets BOTH markers together, and both are STRUCTURED:
  # MGVL_IN_VERIFY_LANE=`pr-<n>` and MGVL_VERIFY_LANE_PRS=<ancestry including n>.
  # Only the real path produces that pair in agreement, so the claim is
  # RE-DERIVED from the values instead of inferred from their presence: the
  # marker must parse as pr-<n> AND <n> must appear in the ancestry list.
  #
  # Corroboration is the whole point. Validating the SHAPE alone would only
  # replace one magic word with another — anyone reading this source could type
  # `pr-1` and get the free pass `fabricated-value` used to get. The ancestry is
  # maintained by the spawning process, so a fabricated marker cannot satisfy it
  # without already knowing which PR is genuinely being verified.
  #
  # A marker failing either test is a POLLUTED ENVIRONMENT: exit 3
  # (HARNESS-ERROR via fail_hard), never a pass and never an ordinary clause
  # failure. The operator's shell is lying to their gates and needs to be told,
  # not accommodated. #722's lesson: "I cannot trust my inputs" and "the subject
  # regressed" are different defects with different owners.
  MGVL_MARKER="${MGVL_IN_VERIFY_LANE:-}"
  MGVL_SKIPPED=0
  if [ -n "$MGVL_MARKER" ]; then
    MGVL_PR_N="${MGVL_MARKER#pr-}"
    if [ "$MGVL_PR_N" = "$MGVL_MARKER" ] || ! printf '%s' "$MGVL_PR_N" | rg -q '^[0-9]+$'; then
      fail_hard "MGVL_IN_VERIFY_LANE is set to \"$MGVL_MARKER\", which is not the pr-<n> shape verify-lane produces (scripts/verify-lane.ts:479 sets MGVL_IN_VERIFY_LANE=pr-<number>).
  This is a POLLUTED ENVIRONMENT, not a free pass. A non-empty value here used to
  skip the ONE clause that exercises verify-lane end to end and record that skip as
  PASS, so the run reported full green with nothing live proven (#721).
  Clear it and re-run:  MGVL_IN_VERIFY_LANE= MGVL_VERIFY_LANE_PRS= bash $0"
    fi
    MGVL_ANCESTRY=",$(printf '%s' "${MGVL_VERIFY_LANE_PRS:-}" | tr -d '[:space:]'),"
    case "$MGVL_ANCESTRY" in
      *",$MGVL_PR_N,"*) MGVL_SKIPPED=1 ;;
      *)
        fail_hard "MGVL_IN_VERIFY_LANE=\"$MGVL_MARKER\" has the right shape but is NOT corroborated by MGVL_VERIFY_LANE_PRS=\"${MGVL_VERIFY_LANE_PRS:-}\" — PR $MGVL_PR_N is absent from that ancestry.
  verify-lane sets both together (scripts/verify-lane.ts:479-480), so a marker
  without its ancestry did not come from a real verify-lane run. Accepting the
  shape alone would make \"pr-<n>\" the new magic word that turns the live clause
  off, which is #721 with one extra step.
  Clear both and re-run:  MGVL_IN_VERIFY_LANE= MGVL_VERIFY_LANE_PRS= bash $0"
        ;;
    esac
  fi

  if [ "$MGVL_SKIPPED" -eq 1 ]; then
    record 9 SKIP "SKIP-BY-GUARD: genuinely nested inside verify-lane (MGVL_IN_VERIFY_LANE=${MGVL_MARKER}, corroborated by MGVL_VERIFY_LANE_PRS=${MGVL_VERIFY_LANE_PRS:-}); re-entering would recurse without bound. The OUTER verify-lane run is the live proof — THIS run proves nothing about verify-lane."
  elif [ "$CONTROL_OK" -ne 1 ]; then
    record 9 FAIL "CONTROL clause failed — refusing to bank a live verdict against a dead gh"
  else
    # SIBLING SWEEP (#721 fixes the PATTERN, not only the reported instance).
    # MGVL_LIVE_PR is this file's OTHER inherited variable that steers the live
    # clause: it chooses the clause's SUBJECT. It was announced (below) but
    # never validated, which is the same family in a quieter form — an
    # announcement describes an input, it does not check one. An inherited or
    # stale value silently re-aimed the live proof at an arbitrary PR, and a
    # non-numeric value would have been handed straight to `gh`.
    #
    # Two validations, both refusing rather than adjusting:
    #   (a) numeric, because everything downstream treats it as a PR number;
    #   (b) NOT the PR that contains this check — that self-targeting is the
    #       measured 331-worktree recursion this whole guard exists to stop,
    #       and the operator override is precisely the route back into it.
    LIVE_PR="${MGVL_LIVE_PR:-}"
    if [ -n "$LIVE_PR" ]; then
      printf '%s' "$LIVE_PR" | rg -q '^[0-9]+$' \
        || fail_hard "MGVL_LIVE_PR=\"$LIVE_PR\" is not a PR number. It selects the SUBJECT of the live clause, so an inherited or mistyped value silently re-aims the only live proof in this check. Clear it to use the purpose-made throwaway PR:  MGVL_LIVE_PR= bash $0"
      SELF_PR="$(gh pr list --state open --json number,headRefName -q \
        ".[] | select(.headRefName == \"$(git -C "$REPO_ROOT" rev-parse --abbrev-ref HEAD 2>/dev/null)\") | .number" 2>/dev/null | head -1)"
      if [ -n "$SELF_PR" ] && [ "$SELF_PR" = "$LIVE_PR" ]; then
        fail_hard "MGVL_LIVE_PR=$LIVE_PR is the PR that CONTAINS this check (branch $(git -C "$REPO_ROOT" rev-parse --abbrev-ref HEAD)). Verifying it makes verify-lane run this file, whose live clause verifies the same PR again — the unbounded recursion measured at 331 worktrees on 2026-08-08. Refusing rather than self-targeting; clear MGVL_LIVE_PR to use the purpose-made throwaway PR."
      fi
    fi
    CREATED_PR=""
    CREATED_BRANCH=""

    # ALWAYS a purpose-made throwaway PR. NEVER "whatever PR happens to be open".
    #
    # The earlier version preferred an existing open PR, and that is a
    # self-targeting bug rather than an optimisation: the PR most likely to be
    # open when this check runs is THE PR THAT CONTAINS THIS CHECK. Verifying it
    # makes verify-lane run this check, whose live clause finds the same PR open
    # and verifies it again — unbounded recursion.
    #
    # Measured 2026-08-08, three times, each fix addressing the wrong layer:
    #   331 worktrees  — no guard at all
    #   747 processes  — guard added to the check; the nested run checks out the
    #                    PR HEAD, which predates the guard, so it never ran
    #   142 worktrees  — depth guard added to verify-lane's environment; the
    #                    OUTER call starts at depth 0, so its child still gets
    #                    one free level and that child ran the old committed check
    #
    # The depth guard is retained as a backstop (it bounds any nesting), but the
    # actual defect was the SELECTION: a check must not choose its own PR as its
    # subject. A throwaway PR is created unconditionally, so the subject is
    # always something this run made and can prove against without re-entering
    # itself. MGVL_LIVE_PR remains as an explicit operator override.
    if [ -z "$LIVE_PR" ]; then
      printf '  [live] creating a purpose-made throwaway draft PR (never an existing PR — that self-targets and recurses)\n' >&2
      # PREFIX-GUARDED throwaway branch (ledger item 20 conditions: self-created
      # this run, prefix-guarded, session-scoped). The prefix is what makes the
      # later cleanup structurally unable to name anything it did not create.
      CREATED_BRANCH="throwaway/verify-lane-proof-$RUN_ID"
      LIVE_WT="$SCRATCH/live-pr"
      if ! git -C "$REPO_ROOT" worktree add -b "$CREATED_BRANCH" "$LIVE_WT" origin/main >&2; then
        record 9 FAIL "could not create the throwaway worktree for the live clause"
        CREATED_BRANCH=""
      else
        printf 'verify-lane live proof marker (%s)\n' "$RUN_ID" > "$LIVE_WT/_scratch-live-marker.txt"
        # A trivially-true check so the LIVE clause measures verify-lane's
        # plumbing (worktree, run, receipt post), not a real check's outcome.
        mkdir -p "$LIVE_WT/scripts/done-means"
        cat > "$LIVE_WT/scripts/done-means/throwaway-live-proof.sh" <<'LIVECHK'
#!/usr/bin/env bash
# Throwaway check used only to prove verify-lane's plumbing end to end.
set -uo pipefail
printf 'CLAUSE live: this check is deliberately trivial and passes — PASS\n'
exit 0
LIVECHK
        git -C "$LIVE_WT" add -A >&2 && \
        git -C "$LIVE_WT" -c commit.gpgsign=false commit -q -m "chore: throwaway verify-lane live proof" >&2 && \
        git -C "$LIVE_WT" push -q origin "HEAD:refs/heads/$CREATED_BRANCH" >&2 || \
          record 9 FAIL "could not push the throwaway branch"

        LIVE_BODY_FILE="$SCRATCH/live-pr-body.md"
        {
          printf '## Summary\n\n'
          printf -- '- Throwaway draft PR created by scripts/done-means/merge-gate-and-verify-lane.sh\n'
          printf -- '  to prove verify-lane end to end. It is closed and its branch deleted by\n'
          printf -- '  the same run that created it.\n\n'
          printf '## Verification\n\n'
          printf -- '- Done-means: scripts/done-means/throwaway-live-proof.sh\n'
        } > "$LIVE_BODY_FILE"

        LIVE_PR="$(gh pr create --draft --title "chore: throwaway verify-lane live proof ($RUN_ID)" \
          --body-file "$LIVE_BODY_FILE" --head "$CREATED_BRANCH" --base main 2>/dev/null \
          | rg -o '[0-9]+$' | tail -1)"
        CREATED_PR="$LIVE_PR"
        printf '  [live] created draft PR #%s on %s\n' "$LIVE_PR" "$CREATED_BRANCH" >&2
      fi
    else
      # Operator override only (MGVL_LIVE_PR). Announced loudly because pointing
      # this at the PR that contains this check is the recursion described above.
      printf '  [live] MGVL_LIVE_PR override: using PR #%s (operator-supplied; must NOT be the PR containing this check)\n' "$LIVE_PR" >&2
    fi

    if [ -z "$LIVE_PR" ]; then
      record 9 FAIL "no PR available for the live clause and one could not be created"
    else
      LIVE_HEAD="$(gh pr view "$LIVE_PR" --json headRefOid -q .headRefOid 2>/dev/null)"
      BEFORE_N="$(gh pr view "$LIVE_PR" --json comments -q '[.comments[] | select(.body | startswith("verify-lane receipt:"))] | length' 2>/dev/null)"
      : "${BEFORE_N:=0}"

      if [ -n "$CREATED_PR" ]; then
        VOUT="$(bun "$VERIFY" "$LIVE_PR" 2>&1)"
      else
        VOUT="$(bun "$VERIFY" "$LIVE_PR" --check scripts/done-means/throwaway-live-proof.sh 2>&1)"
      fi
      VEXIT=$?

      AFTER_N="$(gh pr view "$LIVE_PR" --json comments -q '[.comments[] | select(.body | startswith("verify-lane receipt:"))] | length' 2>/dev/null)"
      : "${AFTER_N:=0}"
      RECEIPT_LINE="$(gh pr view "$LIVE_PR" --json comments -q '[.comments[] | select(.body | startswith("verify-lane receipt:"))] | last | .body' 2>/dev/null | head -1)"

      if [ "$VEXIT" -ne 0 ]; then
        record 9 FAIL "verify-lane exited $VEXIT on live PR #$LIVE_PR: $(printf '%s' "$VOUT" | tr '\n' ' ' | cut -c1-300)"
      elif [ "$AFTER_N" -le "$BEFORE_N" ]; then
        record 9 FAIL "verify-lane exited 0 on PR #$LIVE_PR but posted NO receipt comment ($BEFORE_N -> $AFTER_N)"
      elif ! printf '%s' "$RECEIPT_LINE" | rg -qF "sha=$LIVE_HEAD"; then
        record 9 FAIL "receipt posted but does not carry the PR head SHA observed at run time ($LIVE_HEAD)"
      elif ! printf '%s' "$RECEIPT_LINE" | rg -qF 'exit=0'; then
        record 9 FAIL "receipt posted but does not carry the check's exit code"
      elif ! printf '%s' "$RECEIPT_LINE" | rg -q -e 'at=[0-9]{4}-[0-9]{2}-[0-9]{2}T'; then
        record 9 FAIL "receipt posted but does not carry an ISO timestamp"
      elif ! printf '%s' "$RECEIPT_LINE" | rg -qF 'check='; then
        record 9 FAIL "receipt posted but does not carry the check path"
      else
        record 9 PASS "live PR #$LIVE_PR: verify-lane ran the check in a fresh worktree and posted a receipt carrying check=, exit=0, sha=$LIVE_HEAD, ISO at="
      fi

      # --- teardown of the throwaway PR/branch --------------------------------
      # Ledger item 20's narrow auto-drop exception applies ONLY to what this
      # run created: prefix-guarded `throwaway/verify-lane-proof-$RUN_ID`,
      # session-scoped, self-created this run. An existing PR is never touched.
      if [ -n "$CREATED_PR" ]; then
        printf '  [live] closing throwaway PR #%s\n' "$CREATED_PR" >&2
        gh pr close "$CREATED_PR" --comment "Throwaway proof PR for verify-lane; closed by the same check run that created it." >&2 || true
      fi
      if [ -n "$CREATED_BRANCH" ]; then
        case "$CREATED_BRANCH" in
          throwaway/verify-lane-proof-*)
            printf '  [live] deleting throwaway branch %s (prefix-guarded)\n' "$CREATED_BRANCH" >&2
            # NOT `|| true`. A swallowed teardown failure is how the first GREEN
            # run of this check left its throwaway branch alive on the remote
            # while reporting a clean pass — the same swallowed-exit-code defect
            # lane-bootstrap.ts was built to prevent, reproduced here. Teardown
            # that fails must SAY SO (AGENTS.md, nothing silent); the run is
            # still a pass, but the operator gets told what to finish by hand.
            git -C "$REPO_ROOT" worktree remove --force "$SCRATCH/live-pr" >&2 \
              || printf '  [live] WARNING: could not remove worktree %s — remove it yourself\n' "$SCRATCH/live-pr" >&2
            git -C "$REPO_ROOT" push -q origin --delete "$CREATED_BRANCH" >&2 \
              || printf '  [live] WARNING: could not delete REMOTE branch %s — run: git push origin --delete %s\n' "$CREATED_BRANCH" "$CREATED_BRANCH" >&2
            git -C "$REPO_ROOT" branch -D "$CREATED_BRANCH" >&2 \
              || printf '  [live] WARNING: could not delete local branch %s — run: git branch -D %s\n' "$CREATED_BRANCH" "$CREATED_BRANCH" >&2
            ;;
          *)
            printf '  [live] REFUSING to delete branch "%s": not prefix-guarded\n' "$CREATED_BRANCH" >&2
            ;;
        esac
      fi
    fi
  fi
fi

# ---------------------------------------------------------------------------
# Report
# ---------------------------------------------------------------------------
label_for() {
  case "$1" in
    0)  printf 'CONTROL: gh reaches the repo (observation window is live)' ;;
    1)  printf 'gh pr merge with NO receipt is REFUSED by name' ;;
    2)  printf 'STALE receipt (SHA != current head) is REFUSED naming both SHAs' ;;
    3)  printf 'fresh receipt + lane-contract.md changed is ALLOWED' ;;
    3b) printf "fresh receipt + non-placeholder 'No new lessons:' is ALLOWED" ;;
    3c) printf "fresh receipt + 'harvested: <ref>' comment is ALLOWED" ;;
    4)  printf 'silent harvest is REFUSED, quoting the ratchet rule' ;;
    4b) printf 'placeholder no-lessons reason is REFUSED' ;;
    5a) printf 'gh pr view (not a merge) is ALLOWED' ;;
    5b) printf "echo of a 'gh pr merge' string literal is ALLOWED" ;;
    5c) printf 'git commit heredoc containing gh pr merge is ALLOWED (#618)' ;;
    6)  printf 'a failing gh is REFUSED with a named reason, never silent' ;;
    7)  printf 'merge-gate.ts is REGISTERED in .claude/settings.json' ;;
    8)  printf 'verify-lane with no resolvable done-means fails LOUDLY' ;;
    9)  printf 'LIVE: verify-lane runs a real PR check and posts a SHA-bearing receipt' ;;
  esac
}

# SKIP IS A THIRD VERDICT, NOT A FLAVOUR OF PASS (#721). A skipped clause
# proves nothing about its subject, so it may not count toward "every clause
# passed" and may not produce exit 0. `issue-resolution-artifacts.sh` in this
# same directory established the convention — it counts skips and prints
# "skipped is not passed; what they cover is unproven this run" — and this file
# now follows it rather than laundering a skip into a green summary.
ALL_PASS=1
SKIPS=0
for entry in "${CLAUSES[@]}"; do
  id="${entry%%|*}"
  rest="${entry#*|}"
  status="${rest%%|*}"
  evidence="${rest#*|}"
  printf 'CLAUSE %s (%s): %s — %s\n' "$id" "$(label_for "$id")" "$status" "$evidence"
  case "$status" in
    PASS) ;;
    SKIP) SKIPS=$((SKIPS + 1)) ;;
    *) ALL_PASS=0 ;;
  esac
done

if [ "$SKIPS" -gt 0 ]; then
  printf '\nNOTE  %d clause(s) SKIPPED — skipped is not passed; what they cover is unproven this run.\n' "$SKIPS"
  printf '      The LIVE verify-lane clause is the one that skips, so this transcript is NOT\n'
  printf '      evidence that verify-lane works. Only an OUTER (non-nested) run proves it.\n'
fi

# Scratch fixtures are this script's own; retire them into the temp workspace
# archive rather than deleting (AGENTS.md: the agent's cleanup verb is mv).
ARCHIVE_DIR="/Volumes/ThunderBolt/_tmp/open-brain/_archive"
if mkdir -p "$ARCHIVE_DIR" 2>/dev/null; then
  mv "$SCRATCH" "$ARCHIVE_DIR/$(basename "$SCRATCH").$(date +%s)" 2>/dev/null
fi

# Exit 0 means EVERY clause passed, with nothing skipped. A run whose live
# clause was skipped exits 4 — non-zero, so no caller can mistake it for proof,
# and distinct from 1 so a nested run is not misread as a genuine regression.
# Before #721 this path returned 0 and the transcript was indistinguishable
# from a run that had actually exercised verify-lane.
if [ "$ALL_PASS" -eq 1 ] && [ "$SKIPS" -eq 0 ]; then
  exit 0
fi
if [ "$ALL_PASS" -eq 1 ]; then
  exit 4
fi
exit 1
