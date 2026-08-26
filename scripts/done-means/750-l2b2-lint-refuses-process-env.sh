#!/usr/bin/env bash
# DONE-MEANS check for #825 State 7 -- the `node/no-process-env` rule is armed
# in server/, the two-file door is genuinely open, and the pre-commit gate
# REFUSES a new env reader rather than merely having the rule in its config.
#
#   bash scripts/done-means/750-l2b2-lint-refuses-process-env.sh
#
# WHY A PROBE AND NOT A GREEN SWEEP. A clean sweep of server/ proves only that
# nothing objected today; a rule that failed to load, a plugin that was never
# enabled, and an override that switched the rule off everywhere all produce
# the same silent pass. The rung is self-defending only if a NEW reader is
# refused, so this script writes one, stages it, and asserts the hook says no
# and names the rule.
#
# THREE CLAUSES, and each answers a different question:
#
#   PROBE  -- does the gate REFUSE a newly staged server/ file that reads
#             process.env, naming node/no-process-env? (the rule is armed)
#   DOOR   -- do server/config.ts and server/main.ts still lint clean? (the
#             composition root can still read the environment; a rule that
#             refuses everything is not enforcement, it is a wall)
#   SERVER -- is non-test server/ at zero readers?
#
# THE SERVER CLAUSE IS RED ON PURPOSE AT THIS PR. At the commit that introduces
# this script, `server/tools/shared-namespace.ts` (3 reads) and
# `server/observability/langfuse-tracing.ts` (1) still read the environment
# directly. Those are the final rewiring lane's to move, not this one's, so the
# clause is written to FAIL until they land. It is the check that closes the
# rung, and a check that only goes green after the work it measures is the
# right shape -- writing it to pass today would have measured nothing.
#
# HOOKSPATH IS PART OF WHAT IS UNDER TEST, for the reason the sibling check
# records: `core.hooksPath` selects exactly one directory, and if it is not
# `_githooks` the hook under test is not the one git runs, so a clean commit
# would look like a passing gate.
#
# NOTHING IS COMMITTED. The probe is staged, committed AGAINST, expected to be
# refused, then unstaged and moved into the temp workspace archive -- `mv`,
# never a recursive delete (AGENTS.md).
set -uo pipefail

ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT" || exit 1

PROBE="server/tools/__probe-process-env.ts"
ARCHIVE="${HOOK_SCRATCH_ROOT:-/Volumes/ThunderBolt/_tmp/open-brain/_scratch}/../_archive"
OXLINT="./node_modules/.bin/oxlint"

fail_hard() { echo "FAIL: $*" >&2; exit 1; }

# --- cleanup ---------------------------------------------------------------
# Runs on EVERY exit path -- success, assertion failure, and interrupt --
# because a probe left in `server/tools/` is a `.ts` file the NEXT commit will
# stage and lint, turning one failed check into a blocked repo. `trap ... EXIT`
# alone does not fire on SIGINT/SIGTERM under `set -u`, so both are named.
#
# Every step is CHECKED rather than suppressed: a cleanup that cannot clean
# must say so, or the script reports on a repo state it did not restore.
probe_created=0
cleanup() {
  local rc=$?
  set +u
  git restore --staged "$PROBE" 2>/dev/null || true
  if [ "$probe_created" -eq 1 ] && [ -e "$PROBE" ]; then
    if ! mkdir -p "$ARCHIVE"; then
      echo "CLEANUP FAILED: cannot create archive '$ARCHIVE'." >&2
      echo "  The probe is STILL AT $PROBE. Move it yourself before committing:" >&2
      echo "      mv $PROBE <somewhere outside the repo>" >&2
      exit 1
    fi
    if ! mv "$PROBE" "$ARCHIVE/$(basename "$PROBE" .ts)-$(date +%s).ts"; then
      echo "CLEANUP FAILED: cannot move the probe into '$ARCHIVE'." >&2
      echo "  The probe is STILL AT $PROBE. Move it yourself before committing." >&2
      exit 1
    fi
  fi
  exit $rc
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# --- preconditions ---------------------------------------------------------
hooks_path="$(git config --get core.hooksPath 2>/dev/null || true)"
if [ "$hooks_path" != "_githooks" ]; then
  fail_hard "core.hooksPath is '${hooks_path:-<unset>}', not '_githooks'. Run _githooks/install.sh.
      A gate that git does not execute cannot refuse anything, and this check
      would otherwise report a pass for a hook that never ran."
fi
[ -x "$ROOT/_githooks/pre-commit" ] || fail_hard "_githooks/pre-commit is missing or not executable."
[ -f "$ROOT/.oxlintrc.json" ] || fail_hard ".oxlintrc.json is absent; the hook's oxlint step is config-guarded and would SKIP."
[ -x "$OXLINT" ] || fail_hard "$OXLINT is missing. Run bun install --frozen-lockfile."

# The probe path must be FREE. Never overwrite: a real source file or a
# leftover from an interrupted run would be clobbered here and then ARCHIVED by
# cleanup, destroying content this check does not own.
if [ -e "$PROBE" ]; then
  fail_hard "$PROBE already exists in the working tree. This check refuses to overwrite it.
      Move it aside yourself and re-run; it is never deleted for you."
fi
if git ls-files --error-unmatch "$PROBE" >/dev/null 2>&1 || \
   ! git diff --cached --quiet -- "$PROBE"; then
  fail_hard "$PROBE is already tracked or staged. This check refuses to overwrite it.
      Reset or move it aside yourself and re-run."
fi

# The index must carry nothing but this check's probe. The script runs
# `git commit`, which commits the WHOLE index: if the gate under test wrongly
# ACCEPTS the probe, a dirty index sweeps unrelated staged work into a commit
# nobody asked for.
if ! git diff --cached --quiet; then
  fail_hard "the index is not clean. This check stages a probe and attempts a commit,
      so anything already staged would be committed with it if the gate under
      test wrongly accepts. Stash or reset your staged changes and re-run:
          git diff --cached --name-only"
fi

head_before="$(git rev-parse HEAD)" || fail_hard "cannot read HEAD"

# --- clause 1: PROBE -- the gate refuses a new env reader ------------------
probe_created=1
cat > "$PROBE" <<'PROBE_BODY' || fail_hard "could not write the probe"
export const probe = process.env.PROBE;
PROBE_BODY

git add "$PROBE" || fail_hard "could not stage the probe"

out="$(git commit -m "done-means 825 probe -- expected to be REFUSED" 2>&1)"
status=$?

echo "$out"

# HEAD FIRST. An exit status can be produced by anything; a moved HEAD is proof
# the gate let the probe through, and it must be undone before this script
# returns, or a broken gate leaves a junk commit on the branch.
head_after="$(git rev-parse HEAD)"
if [ "$head_after" != "$head_before" ]; then
  git reset --soft "$head_before" || \
    echo "  AND THE RESET FAILED: HEAD is $head_after, expected $head_before." >&2
  git restore --staged "$PROBE" 2>/dev/null || true
  fail_hard "the commit LANDED ($head_before -> $head_after). The lint gate did not
      refuse a server/ file reading process.env. HEAD has been reset to
      $head_before; verify with git log."
fi

[ $status -ne 0 ] || fail_hard "the commit SUCCEEDED. The lint gate did not refuse a
      server/ file reading process.env, so the rule is not armed."

case "$out" in
  *"oxlint (staged content"*) ;;
  *) fail_hard "refused, but not by the oxlint step -- its header never printed.
      Something else blocked the commit, so this is not evidence the rule works." ;;
esac

case "$out" in *"SKIPPED"*"oxlintrc"*)
  fail_hard "the oxlint step SKIPPED for want of a config while .oxlintrc.json exists." ;;
esac

case "$out" in
  *"no-process-env"*) ;;
  *) fail_hard "the refusal never named no-process-env. The commit was blocked by
      something else, so this run is not evidence the rule is armed." ;;
esac

echo "CLAUSE probe: PASS -- the commit was REFUSED by the oxlint step, naming"
echo "                     node/no-process-env. HEAD is unmoved at $head_before."

git restore --staged "$PROBE" 2>/dev/null || true

# THE PROBE LEAVES THE WORKTREE HERE, not at exit. Clause 3 lints the whole of
# non-test `server/`, and a probe still sitting in `server/tools/` would be
# counted as one of the readers it is measuring -- so the clause could never
# pass, and its failure list would name a file this script created. Cleanup at
# exit is retained as the backstop for the failure paths above.
if [ -e "$PROBE" ]; then
  mkdir -p "$ARCHIVE" || fail_hard "cannot create archive '$ARCHIVE' to retire the probe."
  mv "$PROBE" "$ARCHIVE/$(basename "$PROBE" .ts)-$(date +%s).ts" \
    || fail_hard "cannot move the probe out of the worktree; clause 3 would count it."
  probe_created=0
fi

# --- clause 2: DOOR -- the two allowed readers still lint clean ------------
# The positive control. A rule that refuses the composition root too would pass
# clause 1 while making the server unbuildable, so the door is asserted OPEN
# against the real files rather than against a copy of the probe.
if "$OXLINT" --deny-warnings server/config.ts server/main.ts; then
  echo "CLAUSE door: PASS -- server/config.ts and server/main.ts lint clean, so the"
  echo "                    override keeps the composition root able to read the"
  echo "                    environment."
else
  fail_hard "the door is CLOSED: server/config.ts and/or server/main.ts no longer lint
      clean. The override that exempts them is the only way the composition root
      can read the environment at all."
fi

# --- clause 3: SERVER -- non-test server/ is at zero readers ---------------
# RED BY DESIGN at the commit that introduces this script. See the header.
if "$OXLINT" --deny-warnings --ignore-pattern '**/*.test.ts' server; then
  echo "CLAUSE server: PASS -- non-test server/ lints clean with the rule armed, so"
  echo "                      the rung is closed and self-defending."
else
  fail_hard "CLAUSE server: non-test server/ still has direct env readers (listed
      above). EXPECTED at the PR that introduces this script -- the final
      rewiring lane moves them, and a rebase re-proves this clause. Not a
      reason to touch those files from this lane."
fi

echo
echo "PASS: node/no-process-env is armed across server/, the two-file door is"
echo "      open, and non-test server/ is at zero direct readers."
