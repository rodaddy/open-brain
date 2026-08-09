#!/usr/bin/env bash
# DONE-MEANS check for issue #678 — "schema_hash drift receipt is blind:
# contract-schemas.ts mirror lags the live Zod schema; the #563/#639 shape
# change moved no hash".
#
#   bash scripts/done-means/678-schema-mirror-parity.sh
#
# ---------------------------------------------------------------------------
# THE DEFECT, IN ONE PARAGRAPH
# ---------------------------------------------------------------------------
# docs/downstream-rollout.md:112 calls `schema_hash` "the authoritative drift
# receipt" for a rollout. It is computed by `contractHash()` (src/contract.ts)
# over a payload that includes `TOOL_CONTRACTS` — and TOOL_CONTRACTS lives in
# src/contract-schemas.ts, a HAND-MAINTAINED MIRROR of the Zod schemas that
# actually validate requests. #563/#639 added `continue_from` (and #543-era work
# added `repo` and `prior_context`) to the live Zod schema. The mirror was not
# touched, so the hash did not move, so every downstream compatibility check
# (python/.../_runtime_router.py:375-382, pinning COMPATIBLE_CONTRACT_VERSIONS
# and an exact hash) returns the SAME verdict before and after a real
# client-facing shape change. The receipt is not wrong; it is BLIND.
#
# The blindness is the bug. Reconciling three key names is the smaller half of
# the fix — clause (e) is the half that matters, because without a committed
# assertion tying the mirror to the Zod source, the next shape change is silent
# in exactly the same way and #678 gets refiled under a new number.
#
# ---------------------------------------------------------------------------
# WHAT THIS CHECK PROVES, AND WHAT IT DELIBERATELY DOES NOT
# ---------------------------------------------------------------------------
# PROVES:
#   z-control  agent_reflex_pointers' mirror matches its Zod schema. Audited
#              key-by-key this lane and found ACCURATE before any change, so it
#              must be PASS in the RED run as well as the GREEN one. A run where
#              this goes red alongside everything else is a broken harness, not
#              a drifted mirror (round 13: 10/13-red-with-controls-green is
#              stronger evidence than 13/13 red).
#   (a)        agent_context_pack's mirror advertises EXACTLY the live Zod key
#              set — both directions. A missing key under-advertises the
#              contract; an extra key promises something `.strict()` rejects.
#   (b)        The two reachable serving trees (src/tools/agent-context-pack.ts,
#              server/tools/context-pack-args.ts) agree with EACH OTHER. A
#              mirror reconciled against one tree while the other drifted would
#              be accurate and still wrong on the surface that serves.
#   (c)        The receipt MOVED off the drift-blind pair. The pre-change
#              contract version and hash prefix are pinned as literals in the
#              driver, so this clause fails by construction on any tree that
#              left the mirror alone. This is the clause that fails RED first
#              and is unsatisfiable by cosmetics.
#   (d)        The Python client's pinned version AND hash equal what
#              `buildContract()` actually serves. Read from the client.py source
#              literals — the pin is a cross-language constant, and a stale pin
#              means every downstream compat check fails CLOSED the moment the
#              server deploys. Bumping the hash without re-pinning trades a
#              blind receipt for a hard downstream outage; (c) and (d) must be
#              green together or the fix is worse than the defect.
#   (f)        THE PROVER IS PROVEN. The anti-recurrence test is run twice: once
#              unmodified (must PASS) and once against a MUTATED copy of the
#              mirror with a key deleted (must FAIL). "A green clause is not
#              evidence until it has been seen to fail" (round 9). Without this,
#              clause (e) proves a file exists, which is not a claim worth
#              making.
#
# DOES NOT PROVE, stated rather than implied (residual risk, also in the PR):
#   - PER-FIELD BOUNDS parity. The mirror carries hand-authored maxLength/min/
#     max/description values in a vocabulary Zod introspection does not
#     reproduce 1:1. This check enforces the KEY SET only. A future change that
#     alters `query`'s max from 4000 to 8000 in Zod alone would still drift
#     silently. Deriving the whole mirror from Zod is a contract-shape rewrite,
#     not a drift fix, and would move the hash for reasons unrelated to #678 —
#     so it is deliberately out of scope and named here instead of pretended
#     away.
#   - Anything about a DEPLOYED server. This reads source in this worktree. It
#     is not evidence about core01, which this lane never contacts.
#
# ---------------------------------------------------------------------------
# EXPECTED RESULT BEFORE THE CHANGE (the RED run)
# ---------------------------------------------------------------------------
#   z-control PASS  (the control discriminates)
#   (a) FAIL   in_zod_not_in_mirror=[continue_from,prior_context,repo]
#   (b) PASS   the two trees already agree; only the mirror lags
#   (c) FAIL   version still v23, hash still 4b69e9b4...
#   (d) PASS   the stale pin matches the stale server — which IS the defect:
#              the compat check is green on both sides of a real shape change
#   (e) FAIL   no parity test exists
#   (f) FAIL   nothing to mutate
#
# (b) and (d) passing RED is not a weakness of the check; it is the check
# REPORTING the shape of the defect. (d) is the clause that flips meaning
# after the change: pre-change it is green because both sides are equally
# stale, post-change it is green only because both were moved together.
#
# ---------------------------------------------------------------------------
# ISOLATION AND TEARDOWN
# ---------------------------------------------------------------------------
# No database, no network, no live service. Clause (f) needs a mutated tree; it
# uses a `git stash`-free, copy-based mutation (round 13: lanes do not use
# `git stash` for red/green proofs — the stash stack is shared even when the
# worktree is not). The original file is COPIED aside and restored from that
# copy in an EXIT trap, so an interrupted run cannot leave the mirror mutated.
# Nothing is deleted with `rm`; the backup is moved back over the original with
# `mv`, which is the restore and the cleanup in one operation.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
DRIVER="$SCRIPT_DIR/678-schema-mirror-parity.driver.ts"
MIRROR="$REPO_ROOT/src/contract-schemas.ts"
PARITY_TEST="$REPO_ROOT/src/contract-schema-parity.test.ts"
# Run artifacts land in the repo's gitignored _scratch/ (the temp-workspace rule
# bans /tmp and $TMPDIR; .gitignore:119 already covers this path), so a run
# leaves the working tree clean and `git status` stays readable as a signal.
SCRATCH="$REPO_ROOT/_scratch/678"
mkdir -p "$SCRATCH"
BACKUP="$SCRATCH/contract-schemas.pre-mutation.ts"

echo "=== done-means #678 — schema mirror parity and drift-receipt movement ==="
echo "repo root: $REPO_ROOT"
echo

restore_mirror() {
  if [[ -f "$BACKUP" ]]; then
    mv -f "$BACKUP" "$MIRROR"
    echo "[teardown] mirror restored from backup"
  fi
}
trap restore_mirror EXIT

# ---------------------------------------------------------------------------
# Clauses z-control, a, b, c, d, e — the driver reports, this script judges.
# ---------------------------------------------------------------------------
DRIVER_OUT="$SCRATCH/driver-out.txt"
# Round 21: a pipeline's exit status read outside its own shell prints EMPTY and
# reads like success. Redirect, then read $? directly.
bun "$DRIVER" > "$DRIVER_OUT" 2>&1
DRIVER_STATUS=$?
cat "$DRIVER_OUT"
echo
echo "driver exit status: $DRIVER_STATUS"
echo

FAILURES=0
PASSES=0
for clause in z-control a b c d e; do
  line="$(rg -N "^clause=${clause} " "$DRIVER_OUT" || true)"
  if [[ -z "$line" ]]; then
    echo "clause ${clause}: FAIL — the driver emitted no verdict line (did not run)"
    FAILURES=$((FAILURES + 1))
    continue
  fi
  if [[ "$line" == *"result=PASS"* ]]; then
    echo "clause ${clause}: PASS"
    PASSES=$((PASSES + 1))
  else
    echo "clause ${clause}: FAIL"
    FAILURES=$((FAILURES + 1))
  fi
done

# The control must be green in EVERY run, red or green. A red control means the
# harness is broken and no other verdict on this run is admissible.
CONTROL_LINE="$(rg -N "^clause=z-control " "$DRIVER_OUT" || true)"
if [[ "$CONTROL_LINE" != *"result=PASS"* ]]; then
  echo
  echo "!! CONTROL CLAUSE RED — this run proves nothing about the mirror."
  echo "!! agent_reflex_pointers parity is expected to hold both before and"
  echo "!! after the change; a failure here means the driver or the tree is"
  echo "!! broken, not that agent_context_pack drifted."
fi

# ---------------------------------------------------------------------------
# Clause (f) — PROVE THE PROVER. Run the anti-recurrence test unmodified (must
# pass), then against a mirror with a key deleted (must fail). A parity test
# that cannot be made to fail is decoration.
# ---------------------------------------------------------------------------
echo
echo "--- clause f: mutation-testing the anti-recurrence test ---"
if [[ ! -f "$PARITY_TEST" ]]; then
  echo "clause f: FAIL — $PARITY_TEST does not exist, nothing to mutate"
  FAILURES=$((FAILURES + 1))
else
  UNMUTATED_OUT="$SCRATCH/parity-unmutated.txt"
  bun test "$PARITY_TEST" > "$UNMUTATED_OUT" 2>&1
  UNMUTATED_STATUS=$?
  echo "unmutated parity test exit status: $UNMUTATED_STATUS"

  # Mutate: delete the `continue_from` key line from the mirror's
  # agent_context_pack entry. Marker-anchored (round 25: extract/mutate by
  # markers against the REAL file, never a retyped copy), and the mutation is
  # verified to have actually changed the file before the run is trusted.
  cp "$MIRROR" "$BACKUP"
  bun -e '
    const fs = require("node:fs");
    const path = process.argv[2];
    const src = fs.readFileSync(path, "utf8");
    // Remove the continue_from block from the agent_context_pack entry only.
    const start = src.indexOf("  agent_context_pack: {");
    if (start < 0) { console.error("MUTATION-FAILED: agent_context_pack entry not found"); process.exit(1); }
    const end = src.indexOf("  agent_reflex_pointers: {", start);
    if (end < 0) { console.error("MUTATION-FAILED: entry end marker not found"); process.exit(1); }
    const entry = src.slice(start, end);
    const mutatedEntry = entry.replace(/\n      continue_from: \{[\s\S]*?\n      \},/, "");
    if (mutatedEntry === entry) { console.error("MUTATION-FAILED: continue_from block not matched"); process.exit(1); }
    fs.writeFileSync(path, src.slice(0, start) + mutatedEntry + src.slice(end));
    console.log("MUTATION-APPLIED: continue_from removed from the agent_context_pack mirror entry");
  ' "$MIRROR"
  MUTATION_STATUS=$?

  if [[ $MUTATION_STATUS -ne 0 ]]; then
    echo "clause f: FAIL — the mutation could not be applied, so nothing was proven"
    FAILURES=$((FAILURES + 1))
  else
    MUTATED_OUT="$SCRATCH/parity-mutated.txt"
    bun test "$PARITY_TEST" > "$MUTATED_OUT" 2>&1
    MUTATED_STATUS=$?
    echo "mutated parity test exit status: $MUTATED_STATUS"
    restore_mirror

    if [[ $UNMUTATED_STATUS -eq 0 && $MUTATED_STATUS -ne 0 ]]; then
      echo "clause f: PASS — the parity test passes on the real mirror and FAILS when a key is removed"
      PASSES=$((PASSES + 1))
    else
      echo "clause f: FAIL — unmutated=$UNMUTATED_STATUS (want 0) mutated=$MUTATED_STATUS (want non-zero)"
      echo "  a parity test that stays green under a deleted key does not detect drift"
      FAILURES=$((FAILURES + 1))
    fi
  fi
fi

echo
echo "=== verdict: $PASSES passed, $FAILURES failed ==="
if [[ $FAILURES -gt 0 ]]; then
  echo "DONE-MEANS #678: NOT MET"
  exit 1
fi
echo "DONE-MEANS #678: MET"
exit 0
