#!/usr/bin/env bash
# DONE-MEANS check for #750 -- the pre-commit oxlint gate actually REFUSES a
# violation, rather than existing and examining nothing.
#
#   bash scripts/done-means/750-precommit-lint-gate-fires.sh
#
# WHY A DELIBERATE VIOLATION AND NOT A GREEN RUN. A clean commit passing proves
# only that nothing objected; a step that is skipped, misconfigured, or pointed
# at zero files passes identically. The gate is only proven by content it MUST
# reject. This script therefore builds a probe carrying one violation of each of
# three rules and asserts the commit is refused BY THE OXLINT STEP, naming them.
#
# The three rules are chosen to cover the config's distinct rule families:
# a typescript/ rule (no-explicit-any), a plain eslint rule (no-console), and a
# SIZE rule (max-lines-per-function) whose threshold lives in .oxlintrc.json
# rather than in the rule's default. The last is what catches a config that
# loaded but was not applied.
#
# HOOKSPATH IS PART OF WHAT IS UNDER TEST. `core.hooksPath` selects exactly one
# directory, and this repo's is `_githooks` (see _githooks/install.sh). If it
# still points at an operator's global hooks dir, the hook under test is not the
# one git executes -- observed 2026-08-26, where an earlier probe committed
# clean for exactly that reason and looked like a passing gate. This script
# asserts the path before it trusts any result.
#
# NOTHING IS COMMITTED. The probe is staged, committed AGAINST, and expected to
# be refused. On the way out the stage is reset and the probe is moved into the
# temp workspace archive -- `mv`, never a recursive delete (AGENTS.md).
set -uo pipefail

ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT" || exit 1

PROBE="server/tools/__done_means_750_probe__.ts"
ARCHIVE="${HOOK_SCRATCH_ROOT:-/Volumes/ThunderBolt/_tmp/open-brain/_scratch}/../_archive"

fail() { echo "FAIL: $*" >&2; exit 1; }

# --- cleanup ---------------------------------------------------------------
# Runs on EVERY exit path — success, assertion failure, and interrupt — because
# a probe left behind in `server/tools/` is a `.ts` file the NEXT commit will
# stage and lint, turning one failed check into a blocked repo. `trap ... EXIT`
# alone does not fire on SIGINT/SIGTERM under `set -u`, so both are named.
#
# Every step is CHECKED, not suppressed. The previous version sent mkdir and mv
# failures to /dev/null with `|| true`: an unwritable archive then left the
# probe in the worktree while the script printed PASS on the next line. A
# cleanup that cannot clean must say so, or the check is reporting on a repo
# state it did not actually restore.
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

# --- precondition: the hook git runs is this repo's ------------------------
hooks_path="$(git config --get core.hooksPath 2>/dev/null || true)"
if [ "$hooks_path" != "_githooks" ]; then
  fail "core.hooksPath is '${hooks_path:-<unset>}', not '_githooks'. Run _githooks/install.sh.
      A gate that git does not execute cannot refuse anything, and this check
      would otherwise report a pass for a hook that never ran."
fi
[ -x "$ROOT/_githooks/pre-commit" ] || fail "_githooks/pre-commit is missing or not executable."
[ -f "$ROOT/.oxlintrc.json" ] || fail ".oxlintrc.json is absent; the hook's oxlint step is config-guarded and would SKIP."

# --- precondition: the probe path is FREE ----------------------------------
# Never overwrite. The path is fixed, so a pre-existing file at it — a real
# source file, or a leftover from an interrupted earlier run — would be
# clobbered by the build below and then ARCHIVED by cleanup, destroying content
# this check does not own. Both the worktree and the index are asked, because a
# staged-but-deleted probe is just as much a collision.
if [ -e "$PROBE" ]; then
  fail "$PROBE already exists in the working tree. This check refuses to overwrite it.
      Move it aside yourself and re-run; it is never deleted for you."
fi
if git ls-files --error-unmatch "$PROBE" >/dev/null 2>&1 || \
   ! git diff --cached --quiet -- "$PROBE"; then
  fail "$PROBE is already tracked or staged. This check refuses to overwrite it.
      Reset or move it aside yourself and re-run."
fi

# --- precondition: the index carries nothing but this check's probe --------
# The script is about to run `git commit`, which commits the WHOLE index, not
# just the probe. If the gate under test is broken and accepts the probe, a
# dirty index means unrelated staged work is swept into a commit nobody asked
# for — the check's failure mode would be worse than the bug it hunts.
if ! git diff --cached --quiet; then
  fail "the index is not clean. This check stages a probe and attempts a commit,
      so anything already staged would be committed with it if the gate under
      test wrongly accepts. Stash or reset your staged changes and re-run:
          git diff --cached --name-only"
fi

# HEAD is recorded so the attempted commit can be PROVEN not to have landed,
# rather than merely assumed from an exit status.
head_before="$(git rev-parse HEAD)" || fail "cannot read HEAD"

# --- build the probe -------------------------------------------------------
# THE INDEX AND THE WORKING TREE MUST DIFFER, and that difference is the whole
# experiment. If the probe carried its violations in BOTH, a hook that lints
# working-tree paths would emit exactly the same three rule names and this
# check would pass it — certifying the bug it exists to catch. So: the
# violating content is staged, then the working-tree copy is OVERWRITTEN with a
# clean, rule-conforming version. Only the index carries the violations, so
# only a hook that reads the index can possibly refuse.
probe_created=1
{
  echo "const x: any = 1;"
  echo "console.log(x);"
  echo ""
  echo "export function doneMeans750Oversized(): number {"
  echo "  let total = 0;"
  for i in $(seq 0 120); do echo "  total += $i;"; done
  echo "  return total;"
  echo "}"
} > "$PROBE" || fail "could not write the probe"

git add "$PROBE" || fail "could not stage the probe"

# The clean counterpart: no `any`, no `console`, one short function. If the hook
# lints this instead of the staged content, it finds nothing and the assertions
# below fail loudly — which is the intended signal, not a flake.
cat > "$PROBE" <<'CLEAN_PROBE' || fail "could not write the clean working-tree probe"
export function doneMeans750Clean(): number {
  return 1;
}
CLEAN_PROBE

# Belt and braces: prove the two really do differ before drawing any conclusion
# from the result. A silently-identical probe would make the whole check
# vacuous, and vacuous checks are exactly what this file exists to prevent.
if git diff --quiet -- "$PROBE"; then
  fail "the staged and working-tree probes are identical, so this check could not
      distinguish an index-reading hook from a worktree-reading one. Refusing to
      report a result."
fi

out="$(git commit -m "done-means 750 probe -- expected to be REFUSED" 2>&1)"
status=$?

echo "$out"

# --- assertions ------------------------------------------------------------
# HEAD FIRST. An exit status can be produced by anything; a moved HEAD is proof
# the gate let the probe through, and it must be undone before this script
# returns, or a broken gate leaves a junk commit on the branch.
head_after="$(git rev-parse HEAD)"
if [ "$head_after" != "$head_before" ]; then
  git reset --soft "$head_before" || \
    echo "  AND THE RESET FAILED: HEAD is $head_after, expected $head_before." >&2
  git restore --staged "$PROBE" 2>/dev/null || true
  fail "the commit LANDED ($head_before -> $head_after). The lint gate did not
      refuse a file carrying no-explicit-any, no-console, and an over-length
      function. HEAD has been reset to $head_before; verify with git log."
fi

[ $status -ne 0 ] || fail "the commit SUCCEEDED. The lint gate did not refuse a file
      carrying no-explicit-any, no-console, and an over-length function."

case "$out" in
  *"oxlint (staged content"*) ;;
  *) fail "refused, but not by the oxlint step -- its header never printed. Something
      else blocked the commit, so this is not evidence the lint gate works." ;;
esac

case "$out" in *"SKIPPED"*"oxlintrc"*)
  fail "the oxlint step SKIPPED for want of a config while .oxlintrc.json exists." ;;
esac

for rule in "no-explicit-any" "no-console" "max-lines-per-function"; do
  case "$out" in
    *"$rule"*) ;;
    *) fail "the refusal never named $rule. Each of the three must fire; a partial
      refusal means the rule set loaded incompletely. Note the working-tree copy of
      the probe is deliberately CLEAN: a hook that lints the working tree finds
      nothing and fails here, which is what this check is for." ;;
  esac
done

echo
echo "PASS: the commit was REFUSED by the oxlint step, naming no-explicit-any,"
echo "      no-console, and max-lines-per-function. The violations existed ONLY"
echo "      in the index -- the working-tree copy was clean -- so the gate is"
echo "      proven to read staged content. HEAD is unmoved at $head_before."
