#!/usr/bin/env bash
# DONE-MEANS check for ledger item 17 (docs/issue-graph.md, decisions pass
# 2026-08-08) — "pr-scribe/PR-body enforcement: advisory or forced?" → FORCED.
#
#   bash scripts/done-means/pr-body-gate-fires.sh
#
# ---------------------------------------------------------------------------
# The defect this gates
# ---------------------------------------------------------------------------
# Ledger item 14 (2026-08-07) built the deterministic floor: a template held
# against the validator, a local validation command, and a pr-scribe agent that
# only returns bodies the validator has accepted. All of it was ADVISORY. The
# operator's ruling on 2026-08-08 is that advisory tooling decays:
#
#   "if it's not enforced, it's pretty much useless. Everything that's not
#    enforced eventually gets unused... If I don't hammer it into you and force
#    you to use it, eventually you'll decide that it's not useful and you won't."
#
# So `.claude/hooks/pr-body-gate.ts` runs as a repo-local PreToolUse hook on
# Bash and makes the CI round-trip impossible: a `gh pr create`/`gh pr edit`
# carrying an invalid body never leaves the machine. CI stays the backstop, not
# the first detector.
#
# ---------------------------------------------------------------------------
# Why the NON-FIRING clauses are half this file
# ---------------------------------------------------------------------------
# A guard that blocks too much is a worse tax than the failure it prevents.
# Issue #618 is this repo's standing example: a text-matching guard fired on
# heredoc TEXT — the words appeared inside a string literal a lane was writing,
# not in a command it was running — and every lane paid for it. This hook must
# therefore judge by PARSED ARGUMENTS: tokenize the command with shell quoting
# rules, walk to the `gh` word, confirm the `pr` subcommand and the
# `create`/`edit` verb, and read `--body`/`-b`/`--body-file`/`-F` as OPTIONS of
# that command. Text that merely contains "gh pr create" is not a gh invocation
# and clauses 4a-4c prove the hook agrees.
#
# ---------------------------------------------------------------------------
# Clauses
# ---------------------------------------------------------------------------
#   1  invalid --body            -> BLOCKED, names the hook, echoes validator errors
#   2  valid   --body            -> ALLOWED
#   3a invalid --body-file       -> BLOCKED
#   3b valid   --body-file       -> ALLOWED
#   4a gh pr view 610            -> ALLOWED (no body, not create/edit)
#   4b echo "...gh pr create..." -> ALLOWED (string literal, not an invocation)
#   4c git commit heredoc w/ invalid PR body -> ALLOWED (heredoc TEXT, #618)
#   5  unreadable --body-file    -> BLOCKED with an explicit named reason
#
# Clause 5 is the no-silent-adjustments rule (AGENTS.md Coding Standards,
# 2026-08-08): a hook that cannot read the body must SAY it cannot, not pick a
# side quietly. Silently allowing turns the gate off exactly when a lane is
# doing something unusual; silently blocking wedges the lane with no reason.
#
# Verdict convention matches design-lookup-gate.ts: exit 2 = blocked with the
# reason on stderr, exit 0 = allowed.
#
# Exit 0 only when every clause passes. Exit 3 is a harness error (missing tool,
# unreadable repo), which is NOT a fail of the thing under test.
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
HOOK="$REPO_ROOT/.claude/hooks/pr-body-gate.ts"
TEMPLATE="$REPO_ROOT/.github/pull_request_template.md"
VALIDATOR="$REPO_ROOT/scripts/validate-pr-body.ts"
SCRATCH="$REPO_ROOT/.pr-body-gate-check.$$"

fail_hard() {
  printf 'HARNESS-ERROR: %s\n' "$1" >&2
  exit 3
}

command -v bun >/dev/null 2>&1 || fail_hard "bun not on PATH"
[ -r "$VALIDATOR" ] || fail_hard "validator not readable at $VALIDATOR"
[ -r "$TEMPLATE" ] || fail_hard "template not readable at $TEMPLATE"

mkdir -p "$SCRATCH" || fail_hard "cannot create scratch dir $SCRATCH"

# ---------------------------------------------------------------------------
# Bodies. The VALID body is the committed template, mechanically filled exactly
# the way scripts/done-means/pr-template-passes-validator.sh fills it, so this
# check inherits that gate's guarantee instead of maintaining a second copy of
# the field list. The INVALID body is the template UNFILLED — empty labels and
# both dispositions unchecked — which is precisely what a lane submits when it
# skips the validator.
# ---------------------------------------------------------------------------
DUMMY="dummy specific content for the acceptance gate"
VALID_BODY_FILE="$SCRATCH/valid-body.md"
INVALID_BODY_FILE="$SCRATCH/invalid-body.md"

sed \
  -e 's/\[ \]\(.*\)or \[ \] not applicable because:.*$/[x]\1or [ ] not applicable because:/' \
  -e 's/^- \[ \]/- [x]/' \
  -e "s/^\(- [^][]*:\)[[:space:]]*$/\1 $DUMMY/" \
  "$TEMPLATE" > "$VALID_BODY_FILE" || fail_hard "could not build valid body"
cp "$TEMPLATE" "$INVALID_BODY_FILE" || fail_hard "could not build invalid body"

# Sanity: the validator itself must agree with our labelling, or every clause
# below is measuring the wrong thing.
PR_BODY="$(cat "$VALID_BODY_FILE")" PR_TITLE="gate sanity" bun "$VALIDATOR" >/dev/null 2>&1 \
  || fail_hard "the 'valid' body does not pass the validator — fixture is wrong, not the hook"
if PR_BODY="$(cat "$INVALID_BODY_FILE")" PR_TITLE="gate sanity" bun "$VALIDATOR" >/dev/null 2>&1; then
  fail_hard "the 'invalid' body PASSES the validator — fixture is wrong, not the hook"
fi

VALID_BODY="$(cat "$VALID_BODY_FILE")"
INVALID_BODY="$(cat "$INVALID_BODY_FILE")"

# ---------------------------------------------------------------------------
# Drive the hook the way Claude Code does: a PreToolUse JSON payload on stdin.
# Sets HOOK_EXIT and HOOK_STDERR.
# ---------------------------------------------------------------------------
HOOK_EXIT=0
HOOK_STDERR=""
run_hook() {
  local command_text="$1"
  local payload
  payload="$(
    COMMAND_TEXT="$command_text" bun -e '
      process.stdout.write(JSON.stringify({
        session_id: "pr-body-gate-done-means",
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_input: { command: process.env.COMMAND_TEXT ?? "" },
      }));
    '
  )" || fail_hard "could not build hook payload"

  HOOK_STDERR="$(printf '%s' "$payload" | bun "$HOOK" --event pre-tool-use 2>&1 >/dev/null)"
  HOOK_EXIT=$?
}

# Shell-quote a value for embedding in a synthetic command line.
q() { printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"; }

CLAUSES=()
record() { CLAUSES+=("$1|$2|$3"); }

if [ ! -r "$HOOK" ]; then
  # RED state: the hook does not exist yet. Every clause fails for one honest
  # reason rather than erroring out, so the RED transcript is legible.
  for c in 1 2 3a 3b 4a 4b 4c 5; do
    record "$c" FAIL "no hook at $HOOK — nothing is enforcing PR bodies"
  done
else
  # -- CLAUSE 1: invalid inline body is BLOCKED, by name, with validator text --
  run_hook "gh pr create --title 'feat: thing' --body $(q "$INVALID_BODY")"
  if [ "$HOOK_EXIT" -ne 2 ]; then
    record 1 FAIL "invalid --body was NOT blocked (exit=$HOOK_EXIT)"
  elif ! printf '%s' "$HOOK_STDERR" | rg -qF 'pr-body-gate'; then
    record 1 FAIL "blocked but the refusal never names pr-body-gate"
  elif ! printf '%s' "$HOOK_STDERR" | rg -qF "Critical Self-Review field"; then
    record 1 FAIL "blocked but the validator's own error text is missing"
  elif ! printf '%s' "$HOOK_STDERR" | rg -qF 'pr-scribe'; then
    record 1 FAIL "blocked but never points at .claude/agents/pr-scribe.md"
  elif ! printf '%s' "$HOOK_STDERR" | rg -qF 'validate-pr-body.ts'; then
    record 1 FAIL "blocked but never gives the local validation command"
  else
    record 1 PASS "exit=2, names the hook, echoes validator errors, routes to pr-scribe + local command"
  fi

  # -- CLAUSE 2: valid inline body is ALLOWED --
  run_hook "gh pr create --title 'feat: thing' --body $(q "$VALID_BODY")"
  if [ "$HOOK_EXIT" -eq 0 ]; then
    record 2 PASS "valid --body allowed (exit=0)"
  else
    record 2 FAIL "valid --body was blocked (exit=$HOOK_EXIT): $(printf '%s' "$HOOK_STDERR" | tr '\n' ' ' | cut -c1-300)"
  fi

  # -- CLAUSE 3a: invalid --body-file is BLOCKED --
  run_hook "gh pr create --title 'feat: thing' --body-file $(q "$INVALID_BODY_FILE")"
  if [ "$HOOK_EXIT" -eq 2 ] && printf '%s' "$HOOK_STDERR" | rg -qF 'Critical Self-Review field'; then
    record 3a PASS "invalid --body-file blocked with validator errors (exit=2)"
  else
    record 3a FAIL "invalid --body-file not properly blocked (exit=$HOOK_EXIT)"
  fi

  # -- CLAUSE 3b: valid --body-file is ALLOWED, including the -F spelling --
  run_hook "gh pr edit 610 -F $(q "$VALID_BODY_FILE")"
  if [ "$HOOK_EXIT" -eq 0 ]; then
    record 3b PASS "valid -F body-file on 'gh pr edit' allowed (exit=0)"
  else
    record 3b FAIL "valid -F body-file blocked (exit=$HOOK_EXIT): $(printf '%s' "$HOOK_STDERR" | tr '\n' ' ' | cut -c1-300)"
  fi

  # -- CLAUSE 4a: a gh pr command with no body at all is ALLOWED --
  run_hook "gh pr view 610"
  if [ "$HOOK_EXIT" -eq 0 ]; then
    record 4a PASS "gh pr view 610 allowed (exit=0)"
  else
    record 4a FAIL "gh pr view was blocked (exit=$HOOK_EXIT) — the gate is over-firing"
  fi

  # -- CLAUSE 4b: the phrase inside a string literal is NOT an invocation --
  run_hook "echo 'run gh pr create --body bad next time'"
  if [ "$HOOK_EXIT" -eq 0 ]; then
    record 4b PASS "echo of a string literal containing 'gh pr create' allowed (exit=0)"
  else
    record 4b FAIL "echo'd string literal was blocked (exit=$HOOK_EXIT) — substring matching, the #618 defect"
  fi

  # -- CLAUSE 4c: #618 proper. An invalid PR body inside heredoc TEXT. --
  HEREDOC_CMD="git commit -F - <<'EOF'
docs: record the PR body format

A lane once submitted this and CI rejected it:

$INVALID_BODY

Do not do that; run gh pr create only after the validator passes.
EOF"
  run_hook "$HEREDOC_CMD"
  if [ "$HOOK_EXIT" -eq 0 ]; then
    record 4c PASS "git commit heredoc carrying an invalid PR body allowed (exit=0) — #618 not reintroduced"
  else
    record 4c FAIL "heredoc TEXT triggered the gate (exit=$HOOK_EXIT) — this is exactly the #618 defect"
  fi

  # -- CLAUSE 5: unreadable body file refuses OUT LOUD --
  MISSING_FILE="$SCRATCH/definitely-not-here.md"
  run_hook "gh pr create --title 'feat: thing' --body-file $(q "$MISSING_FILE")"
  if [ "$HOOK_EXIT" -ne 2 ]; then
    record 5 FAIL "unreadable --body-file silently ALLOWED (exit=$HOOK_EXIT) — the gate turns itself off"
  elif ! printf '%s' "$HOOK_STDERR" | rg -qF 'pr-body-gate'; then
    record 5 FAIL "refused but does not name the hook"
  # NOTE: ripgrep's -E is --encoding, NOT grep's extended-regex. Use -e for the
  # pattern; rg is regex by default. Getting this wrong makes the assertion
  # error out and read as a hook failure, which it did on the first GREEN run.
  elif ! printf '%s' "$HOOK_STDERR" | rg -qi -e 'could not read|unreadable|cannot read'; then
    record 5 FAIL "refused but never says the body file was unreadable — a silent block"
  else
    record 5 PASS "unreadable --body-file refused with an explicit named reason (exit=2)"
  fi
fi

# ---------------------------------------------------------------------------
# Report
# ---------------------------------------------------------------------------
label_for() {
  case "$1" in
    1)  printf 'invalid inline --body is BLOCKED by name with validator errors' ;;
    2)  printf 'valid inline --body is ALLOWED' ;;
    3a) printf 'invalid --body-file is BLOCKED' ;;
    3b) printf 'valid --body-file/-F is ALLOWED' ;;
    4a) printf 'gh pr view (no body) is ALLOWED' ;;
    4b) printf "echo of a 'gh pr create' string literal is ALLOWED" ;;
    4c) printf 'git commit heredoc containing an invalid PR body is ALLOWED (#618)' ;;
    5)  printf 'unreadable --body-file is REFUSED with a named reason, never silent' ;;
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

# Scratch fixtures are this script's own; retire them into the temp workspace
# archive rather than deleting (AGENTS.md: the agent's cleanup verb is mv).
ARCHIVE_DIR="/Volumes/ThunderBolt/_tmp/open-brain/_archive"
if mkdir -p "$ARCHIVE_DIR" 2>/dev/null; then
  mv "$SCRATCH" "$ARCHIVE_DIR/$(basename "$SCRATCH").$(date +%s)" 2>/dev/null
fi

[ "$ALL_PASS" -eq 1 ] && exit 0
exit 1
