#!/usr/bin/env bash
# DONE-MEANS check for issue #712 — "pre-push fails every push: bun test aborts
# with WriteFailed when its stdout is git's pipe (tests are green)".
#
#   bash scripts/done-means/712-pre-push-pipe-safe.sh
#
# ---------------------------------------------------------------------------
# THE DEFECT THIS GATES
# ---------------------------------------------------------------------------
# `_githooks/pre-push` ran `bun test` bare, inheriting git's stdout and stderr.
# When git's own output is CAPTURED by the caller (`git push ... | tail`, or any
# wrapper reading it), those fds are pipes, and bun 1.3.14 aborts partway
# through the full-suite coverage table with
#
#     error: An internal error occurred (WriteFailed)
#
# exiting 1 on a suite that is GREEN. Measured on the untouched primary at
# e3917ab by redirecting each fd independently:
#
#   stdout PIPE + stderr PIPE -> exit 1 (WriteFailed)
#   stdout FILE + stderr FILE -> exit 0 (3372 pass, 0 fail)
#   stdout FILE + stderr PIPE -> exit 1 (WriteFailed)   <-- stderr is the writer
#   stdout PIPE + stderr FILE -> exit 0
#
# The failing writer is bun's STDERR (where the coverage table and the summary
# go), which is why clause (a) below asserts on stderr specifically: a "fix"
# that redirected only stdout would leave the defect fully live while looking
# correct, and this check must fail against that fix. Same family as CLOSED
# #483 — something the hook INHERITED from its caller decided its verdict.
#
# ---------------------------------------------------------------------------
# WHY THE FIXTURE'S EMITTER IS PIPE-SENSITIVE RATHER THAN A REAL FULL SUITE
# ---------------------------------------------------------------------------
# Lane-contract round 28: a seam that avoids the real invocation shape proves
# nothing. The shape that MUST be real here is the one the defect lives in —
# THE HOOK, run through a genuine pipe, with its verdict read from the pipe.
# Every clause below runs the SHIPPED `_githooks/pre-push`, copied byte for
# byte, with its stdout and stderr attached to a real pipe.
#
# What is NOT reproduced literally is bun's internal 214 KB-of-stderr timing
# threshold. That was attempted first and is recorded here so the next lane does
# not repeat it: a synthetic 4 MB stderr writer exits 0, and fixture suites of
# 300 and then 1200 modules (138 KB of coverage table) both exit 0 through a
# pipe. The trigger is internal to bun's test reporter at real-suite scale, and
# a check that depended on it would be a multi-minute, version-coupled coin
# flip — it would go green the day bun fixes the bug, silently un-testing the
# hook's own classification logic, which is what this check actually owns.
#
# So the fixture's test command is a deterministic stand-in with the SAME
# OBSERVABLE CONTRACT as bun 1.3.14: it inspects fd 2, and when fd 2 is a FIFO
# it prints the exact `An internal error occurred (WriteFailed)` text and exits
# 1; otherwise it prints a passing summary and exits 0. Verified against the
# real thing before being used (probe transcripts in the PR body). The subject
# under test is the HOOK's handling of a runner whose write fails, and that
# contract is exactly what the hook must survive.
#
# ---------------------------------------------------------------------------
# CLAUSES
# ---------------------------------------------------------------------------
#   (a) THE DEFECT. The real hook, driven through a genuine PIPE with a
#       pipe-hostile test runner, must PASS — because a green suite is green
#       regardless of how the caller captured output. RED pre-fix: the hook
#       inherits the pipe, the runner dies with WriteFailed, the push fails.
#       Asserted on the hook's OWN success marker, and the runner is proven to
#       have been genuinely pipe-hostile in the same run, so a hook that passed
#       by never running the suite cannot satisfy it.
#
#   (b) MUTANT CONTROL — A GENUINELY FAILING SUITE STILL FAILS, AND IS NAMED
#       "TESTS FAILED". This is the half that stops (a) being "fixed" by
#       ignoring the exit code. A runner that exits non-zero WITHOUT a
#       WriteFailed marker must fail the hook AND be classified as a test
#       failure, never masked as a write error.
#
#   (c) THE TWO FAILURES ARE DISTINGUISHED, AND IT SAYS WHICH. A runner that
#       fails WITH the WriteFailed marker must fail the hook and be reported as
#       a RUNNER/WRITE problem — explicitly NOT a test failure. Before the fix
#       both worlds presented as one bare `WriteFailed` plus a refused push,
#       which is the "gate has stopped carrying information" state the issue
#       names.
#
#   (d) THE REDIRECT IS ANNOUNCED (AGENTS.md, nothing is adjusted silently).
#       The hook moves its runner's output to a log file — a self-made decision
#       — so it must SAY so and name the log. Anchored on a marker the hook owns.
#
#   (e) THE OUTPUT IS STILL REPLAYED. Redirecting to a file must not cost the
#       operator the output they came for; the suite's text must still reach
#       the caller. Without this clause, "redirect to a file" passes (a)-(d) by
#       swallowing the run entirely.
#
#   (f) STDERR SPECIFICALLY IS OFF THE PIPE. The measured root cause. A fix
#       redirecting only stdout passes a naive reading of (a) on a runner that
#       fails on stdout, so this clause drives a runner that is hostile to
#       STDERR ONLY — the real bun shape — and pins that the hook survives it.
#
# Exit 0 only when every clause passes. Exit 3 is a harness error, which is NOT
# a failure of the thing under test.
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
HOOK="$REPO_ROOT/_githooks/pre-push"
RUN_ID="712-$$-$(date +%s)"
SCRATCH="${OPENBRAIN_TEMP_WORKSPACE:-/Volumes/ThunderBolt/_tmp}/open-brain/_scratch/$RUN_ID"

fail_hard() {
  printf 'HARNESS-ERROR: %s\n' "$1" >&2
  exit 3
}

command -v git >/dev/null 2>&1 || fail_hard "git not on PATH"
command -v bun >/dev/null 2>&1 || fail_hard "bun not on PATH"
[ -r "$HOOK" ] || fail_hard "pre-push hook not readable at $HOOK"
mkdir -p "$SCRATCH" || fail_hard "cannot create scratch dir $SCRATCH"

FIXTURE="$SCRATCH/fixture"
mkdir -p "$FIXTURE" || fail_hard "cannot create fixture dir"

git_f() { git -C "$FIXTURE" -c user.name="done-means-712" -c user.email="done-means-712@invalid" "$@"; }

# ---------------------------------------------------------------------------
# The pipe-sensitive runner: bun 1.3.14's observable contract, deterministically.
#
# MODE is read from the environment so one fixture serves every clause:
#   writefail-stderr : fd 2 is a FIFO -> WriteFailed on stderr, exit 1  (the real shape)
#   writefail-stdout : fd 1 is a FIFO -> WriteFailed on stdout, exit 1  (clause f's foil)
#   testfail         : always exit 1, NO WriteFailed marker             (the mutant)
#   pass             : always exit 0
# ---------------------------------------------------------------------------
write_runner() {
  cat > "$FIXTURE/fake-bun-test.ts" <<'RUNNER'
import { fstatSync } from "node:fs";

const mode = process.env.DM712_MODE ?? "writefail-stderr";
const isFIFO = (fd: number): boolean => {
  try {
    return (fstatSync(fd).mode & 0o170000) === 0o010000;
  } catch {
    return false;
  }
};

// Suite-shaped output first, so a hook that replays the log has something real
// to replay and clause (e) is asserting on genuine runner output.
process.stderr.write("bun test v1.3.14 (fixture)\n");
for (let i = 0; i < 200; i++) {
  process.stderr.write(` src/mod${i}.ts       |  100.00 |   90.00 |\n`);
}

if (mode === "testfail") {
  process.stderr.write("DM712-RUNNER-RAN\n");
  process.stderr.write(" 1 fail\n");
  process.stderr.write("error: 1 test failed\n");
  process.exit(1);
}

const hostileFd = mode === "writefail-stdout" ? 1 : 2;
if (mode.startsWith("writefail") && isFIFO(hostileFd)) {
  // The exact text bun 1.3.14 emits, on the same fd it emits it on.
  const out = hostileFd === 1 ? process.stdout : process.stderr;
  out.write("error: An internal error occurred (WriteFailed)\n");
  process.exit(1);
}

// Not hostile -> the suite genuinely passed. The marker proves the runner
// actually executed, so a hook that skipped the suite cannot fake a green.
process.stderr.write("DM712-RUNNER-RAN\n");
process.stderr.write(" 3372 pass\n 0 fail\n");
process.exit(0);
RUNNER
}

setup_fixture() {
  git -C "$FIXTURE" init -q -b main 2>/dev/null || return 1
  mkdir -p "$FIXTURE/contracts" "$FIXTURE/_githooks" "$FIXTURE/docs" || return 1

  printf 'contracts/schema.json\n' > "$FIXTURE/contracts/parity-paths.txt" || return 1
  printf '{}\n' > "$FIXTURE/contracts/schema.json" || return 1
  printf '# base\n' > "$FIXTURE/docs/readme.md" || return 1

  write_runner || return 1

  # `typecheck` is trivially green so the run reaches the test phase and is
  # judged there. Python/parity gates never arm: the fixture has no python/
  # paths and parity is pinned to a file no commit here touches, so nothing but
  # the test phase can decide these clauses.
  #
  # NOTE the hook invokes `bun test` DIRECTLY, not `bun run test`, so a `test`
  # script here would never be consulted — the first draft of this check put the
  # runner there and clause (a) went red with "0 test files matching", a false
  # RED that proved the fixture wrong rather than the hook broken (lane-contract
  # rounds 18/22/23). The runner is therefore interposed on PATH below, which is
  # what makes `bun test` itself resolve to it.
  cat > "$FIXTURE/package.json" <<'PKG' || return 1
{
  "name": "done-means-712-fixture",
  "private": true,
  "scripts": {
    "typecheck": "true"
  }
}
PKG

  # A `bun` shim earlier on PATH than the real one. `bun test` -> the
  # pipe-sensitive runner; every other subcommand (`bun run typecheck`, and the
  # runner's own `bun`) is delegated to the REAL bun, so the hook is otherwise
  # running unmodified. This is how the hook's genuine `bun test` line is driven
  # without depending on bun's own version-coupled WriteFailed threshold.
  mkdir -p "$FIXTURE/.shim" || return 1
  REAL_BUN="$(command -v bun)" || return 1
  cat > "$FIXTURE/.shim/bun" <<SHIM || return 1
#!/usr/bin/env bash
if [ "\${1:-}" = "test" ]; then
  exec "$REAL_BUN" run "$FIXTURE/fake-bun-test.ts"
fi
exec "$REAL_BUN" "\$@"
SHIM
  chmod +x "$FIXTURE/.shim/bun" || return 1

  cp "$HOOK" "$FIXTURE/_githooks/pre-push" || return 1
  chmod +x "$FIXTURE/_githooks/pre-push" || return 1

  git_f add -A >/dev/null || return 1
  git_f commit -q -m "base" || return 1
  git_f remote add origin "$FIXTURE" || return 1
  git_f checkout -q -b wip || return 1
  printf 'wip\n' >> "$FIXTURE/docs/readme.md" || return 1
  git_f add -A >/dev/null || return 1
  git_f commit -q -m "wip" || return 1
  git_f fetch -q origin || return 1
  return 0
}

setup_fixture || fail_hard "could not build the fixture repository (see $FIXTURE)"

ZERO_SHA_FIXTURE=0000000000000000000000000000000000000000

# ---------------------------------------------------------------------------
# run_hook_through_pipe <mode> -- drive the REAL hook on the REAL push path with
# BOTH fds attached to a genuine pipe, and capture what the pipe carried.
#
# This is the round-28 clause: a real stdin range with a zero remote SHA (the
# new-branch shape, every first lane push), and the hook's own output travelling
# down a pipe exactly as it does under `git push ... | tail`. HOOK_EXIT is
# recovered through the pipe rather than via PIPESTATUS because the whole point
# is that the pipe is the channel under suspicion.
# ---------------------------------------------------------------------------
HOOK_OUT=""
HOOK_EXIT=0
run_hook_through_pipe() {
  local mode="$1"
  local tip ref out

  tip="$(git -C "$FIXTURE" rev-parse HEAD)"
  ref="refs/heads/$(git -C "$FIXTURE" rev-parse --abbrev-ref HEAD)"

  # The subshell's stdout AND stderr go into the pipe feeding `cat`. The
  # sentinel carries the hook's real exit code back out.
  out="$(
    cd "$FIXTURE" && {
      (
        DM712_MODE="$mode" \
        OPENBRAIN_TEMP_WORKSPACE="$SCRATCH/ws" \
        PATH="$FIXTURE/.shim:$PATH" \
          "$FIXTURE/_githooks/pre-push" origin "$FIXTURE" \
          < <(printf '%s %s %s %s\n' "$ref" "$tip" "$ref" "$ZERO_SHA_FIXTURE")
        printf 'DM712_HOOK_EXIT=%s\n' "$?"
      ) 2>&1 | cat
    }
  )"

  HOOK_OUT="$out"
  HOOK_EXIT="$(printf '%s\n' "$out" | sed -n 's/^DM712_HOOK_EXIT=\([0-9]*\)$/\1/p' | tail -1)"
  [ -n "$HOOK_EXIT" ] || HOOK_EXIT=missing
}

# Proof that the pipe really is a pipe and the runner really is hostile to it —
# otherwise clause (a) could go green because the environment quietly handed the
# hook a non-pipe, certifying nothing. Runs the SAME runner, same mode, with the
# fds attached the way the BROKEN hook attached them.
PRECHECK_EXIT=0
precheck_pipe_is_hostile() {
  local mode="$1"
  # Driven through the SAME `bun test` spelling the hook uses, via the shim, so
  # the hostility proven here is the hostility the hook will meet.
  ( cd "$FIXTURE" && PATH="$FIXTURE/.shim:$PATH" DM712_MODE="$mode" bun test >/dev/null 2>&1 ) >/dev/null 2>&1
  local direct=$?
  local piped
  piped="$(
    cd "$FIXTURE" && {
      ( PATH="$FIXTURE/.shim:$PATH" DM712_MODE="$mode" bun test; printf 'E=%s\n' "$?" ) 2>&1 | sed -n 's/^E=\([0-9]*\)$/\1/p' | tail -1
    }
  )"
  PRECHECK_EXIT="${piped:-missing}"
  # hostile means: fine when not piped, non-zero when piped.
  [ "$direct" -eq 0 ] && [ "$PRECHECK_EXIT" != "0" ] && [ "$PRECHECK_EXIT" != "missing" ]
}

CLAUSES=()
record() { CLAUSES+=("$1|$2|$3"); }

# --- (a) the defect --------------------------------------------------------
if precheck_pipe_is_hostile "writefail-stderr"; then
  run_hook_through_pipe "writefail-stderr"
  A_OUT="$HOOK_OUT"
  A_EXIT="$HOOK_EXIT"
  if [ "$A_EXIT" = "0" ] \
    && printf '%s' "$A_OUT" | grep -qF "pre-push: all checks passed" \
    && printf '%s' "$A_OUT" | grep -qF "DM712-RUNNER-RAN"; then
    record a PASS "the real hook, through a genuine pipe, with a runner that cannot write to a pipe (proven hostile: piped exit=$PRECHECK_EXIT): exit 0, suite genuinely ran"
  else
    record a FAIL "a GREEN suite through a pipe still failed the hook (exit=$A_EXIT): $(printf '%s' "$A_OUT" | tr '\n' ' ' | tail -c 400)"
  fi
else
  record a FAIL "harness could not establish a pipe-hostile runner (piped exit=$PRECHECK_EXIT) — clause (a) would prove nothing"
fi

# --- (b) mutant control: a real test failure still fails, and says so -------
run_hook_through_pipe "testfail"
B_OUT="$HOOK_OUT"
B_EXIT="$HOOK_EXIT"
B_FAILS=()
[ "$B_EXIT" != "0" ] || B_FAILS+=("a genuinely failing suite PASSED the hook (exit=$B_EXIT) — the exit code is not being gated on")
printf '%s' "$B_OUT" | grep -qiF "TESTS FAILED" \
  || B_FAILS+=("a genuine test failure was not reported as a test failure")
if printf '%s' "$B_OUT" | grep -qiF "could not write its output"; then
  B_FAILS+=("a genuine test failure was MASKED as a write/runner error — the two worlds are crossed")
fi
if [ "${#B_FAILS[@]}" -eq 0 ]; then
  record b PASS "a genuinely failing suite still fails the hook (exit=$B_EXIT) and is named a TEST failure, not a write error"
else
  record b FAIL "$(printf '%s; ' "${B_FAILS[@]}")"
fi

# --- (c) the two failures are distinguished --------------------------------
# A runner that fails WITH the WriteFailed marker even when its fds are files:
# the hook must still fail (it cannot claim a verdict it never got) but must say
# RUNNER/WRITE problem, explicitly not a test failure.
cat > "$FIXTURE/fake-bun-test.ts" <<'RUNNER2'
process.stderr.write("bun test v1.3.14 (fixture)\n");
process.stderr.write("error: An internal error occurred (WriteFailed)\n");
process.exit(1);
RUNNER2
git_f add -A >/dev/null && git_f commit -q -m "clause c runner"
run_hook_through_pipe "writefail-stderr"
C_OUT="$HOOK_OUT"
C_EXIT="$HOOK_EXIT"
C_FAILS=()
[ "$C_EXIT" != "0" ] || C_FAILS+=("a runner that could not write its output was reported as a PASS (exit=$C_EXIT)")
printf '%s' "$C_OUT" | grep -qiF "could not write its output" \
  || C_FAILS+=("the write/runner failure was not named as one")
printf '%s' "$C_OUT" | grep -qiF "NOT a test failure" \
  || C_FAILS+=("the hook did not state that this is NOT a test failure")
if printf '%s' "$C_OUT" | grep -qiF "TESTS FAILED"; then
  C_FAILS+=("a write/runner failure was blamed on the tests")
fi
if [ "${#C_FAILS[@]}" -eq 0 ]; then
  record c PASS "a runner that cannot write its output fails the hook and is named a WRITE/RUNNER problem, explicitly not a test failure"
else
  record c FAIL "$(printf '%s; ' "${C_FAILS[@]}")"
fi
write_runner
git_f add -A >/dev/null && git_f commit -q -m "restore runner"

# --- (d) the redirect is announced -----------------------------------------
run_hook_through_pipe "writefail-stderr"
D_OUT="$HOOK_OUT"
if printf '%s' "$D_OUT" | grep -qF "bun test ..." \
  && printf '%s' "$D_OUT" | grep -qF "$SCRATCH/ws"; then
  record d PASS "the hook announces that it redirected the runner's output, and names the log path"
else
  record d FAIL "the redirect was silent — no announcement naming the log: $(printf '%s' "$D_OUT" | tr '\n' ' ' | tail -c 300)"
fi

# --- (e) the output is still replayed --------------------------------------
# Read from the same run as (d). The runner's own coverage-shaped lines must
# reach the caller, or the hook bought its verdict by swallowing the output.
if printf '%s' "$D_OUT" | grep -qF "DM712-RUNNER-RAN" \
  && printf '%s' "$D_OUT" | grep -qF "src/mod100.ts"; then
  record e PASS "the runner's output still reaches the caller — the redirect did not cost the operator the transcript"
else
  record e FAIL "the runner's output never reached the caller; the redirect swallowed the run: $(printf '%s' "$D_OUT" | tr '\n' ' ' | tail -c 300)"
fi

# --- (f) stderr specifically is off the pipe -------------------------------
# The measured root cause. A fix that redirected only stdout leaves this live.
if precheck_pipe_is_hostile "writefail-stderr"; then
  run_hook_through_pipe "writefail-stderr"
  F_EXIT="$HOOK_EXIT"
  F_OUT="$HOOK_OUT"
  if [ "$F_EXIT" = "0" ] && printf '%s' "$F_OUT" | grep -qF "DM712-RUNNER-RAN"; then
    record f PASS "a runner hostile to STDERR ONLY (the measured bun shape) survives — stderr is genuinely off the pipe, not just stdout"
  else
    record f FAIL "the runner's STDERR is still attached to a pipe (exit=$F_EXIT) — redirecting stdout alone does not fix #712"
  fi
else
  record f FAIL "harness could not establish a stderr-hostile runner (piped exit=$PRECHECK_EXIT)"
fi

# ---------------------------------------------------------------------------
# Teardown. The fixture is a throwaway repository this script created inside the
# temp workspace; it is MOVED to the archive, never deleted (AGENTS.md: the
# agent's cleanup verb is mv). No worktree is registered against the real repo,
# so nothing is stranded by moving it.
# ---------------------------------------------------------------------------
ARCHIVE_DIR="${OPENBRAIN_TEMP_WORKSPACE:-/Volumes/ThunderBolt/_tmp}/open-brain/_archive"
if mkdir -p "$ARCHIVE_DIR" 2>/dev/null; then
  mv "$SCRATCH" "$ARCHIVE_DIR/$RUN_ID" 2>/dev/null \
    || printf 'TEARDOWN-WARNING: fixture left at %s\n' "$SCRATCH" >&2
fi

# ---------------------------------------------------------------------------
# Report
# ---------------------------------------------------------------------------
label_for() {
  case "$1" in
    a) printf 'a green suite through a genuine pipe passes the hook' ;;
    b) printf 'MUTANT: a genuinely failing suite still fails, named TESTS FAILED' ;;
    c) printf 'a write/runner failure is named as one, not as a test failure' ;;
    d) printf 'the redirect is announced and the log is named' ;;
    e) printf "the runner's output is still replayed to the caller" ;;
    f) printf 'STDERR specifically is off the pipe (the measured root cause)' ;;
  esac
}

ALL_PASS=1
for entry in "${CLAUSES[@]}"; do
  id="${entry%%|*}"
  rest="${entry#*|}"
  status="${rest%%|*}"
  evidence="${rest#*|}"
  printf 'CLAUSE %s (%s): %s — %s\n' "$id" "$(label_for "$id")" "$status" "$evidence"
  [ "$status" = PASS ] || ALL_PASS=0
done

[ "$ALL_PASS" -eq 1 ] && exit 0
exit 1
