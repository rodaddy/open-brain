#!/usr/bin/env bash
# DONE-MEANS check for issue #679 / cutover pre-flight blocker B7 —
# "Development-wide safety gates fail OPEN in open-brain".
#
#   bash scripts/done-means/679-dev-safety-gates-registered.sh
#
# Pre-flight ordered item 7 states the acceptance in one line:
#   "register the Development-wide safety gates so they resolve for open-brain;
#    done-means: a destructive-delete and a fast-tool call are REFUSED in this
#    repo."
#
# ---------------------------------------------------------------------------
# THE DEFECT
# ---------------------------------------------------------------------------
# /Volumes/ThunderBolt/Development/.claude/settings.json registers four gates as
#
#   "${CLAUDE_PROJECT_DIR}"/_ob/bin/ob-gate <gate>
#
# When open-brain is CLAUDE_PROJECT_DIR that expands to open-brain/_ob/bin/ob-gate,
# which does not exist (open-brain is a SEPARATE git repo, gitignored by
# Development — `git check-ignore -v open-brain` -> `.gitignore:3:* open-brain` —
# so Development's own _ob/ tree is not part of this checkout and never will be).
# The shell exits 127, and PreToolUse treats any non-2 exit as ALLOW. The gate
# FAILS OPEN.
#
# ob-gate's own header says it "FAILS CLOSED, DELIBERATELY / converts every
# breakage into exit 2". It cannot, because the file that would do that is the
# missing one. The exact failure mode ob-gate exists to prevent, one level up.
#
# The gate LOGIC is fine and is not what this check tests. Running
# Development/_ob/bin/ob-gate by absolute path from this repo already refuses
# correctly. What is broken is REACHABILITY FROM THIS REPO, and that is a
# registration-boundary question, so this check reads the registration.
#
# ---------------------------------------------------------------------------
# WHY THIS CHECK READS settings.json INSTEAD OF CALLING A GATE DIRECTLY
# ---------------------------------------------------------------------------
# This is the load-bearing design decision, and it is round 25's rule
# ("when a gate has no clause-level seam, EXTRACT the clause from the real file
# — never retype it"). A check that invokes a dispatcher at a path it spells
# itself proves that the dispatcher works. It proves NOTHING about whether the
# harness will ever call it, which IS the defect: on 2026-08-09 the gate binary
# worked perfectly and agents in this repo ran `rm -rf` unblocked anyway.
#
# So every clause below extracts the ACTUAL hook commands out of the committed
# .claude/settings.json, substitutes CLAUDE_PROJECT_DIR exactly as Claude Code
# does, and executes the result. If the registration is missing, mis-pathed, or
# points at something absent, these clauses fail. If somebody deletes the
# registration and leaves the dispatcher on disk, they still fail.
#
# ---------------------------------------------------------------------------
# WHICH TREE RUNS (round 12 / round 23)
# ---------------------------------------------------------------------------
# REPO_ROOT is derived from THIS FILE's own location, and every path below hangs
# off it, so the check structurally cannot reach across trees: run from a lane
# worktree it tests that worktree's settings.json; run from the primary checkout
# it tests the primary checkout's. CLAUDE_PROJECT_DIR is set to REPO_ROOT for
# the same reason — that is what the harness sets it to when a session is open
# on this repo, and it is the value under which the defect occurs.
#
# ---------------------------------------------------------------------------
# CLAUSES
# ---------------------------------------------------------------------------
#   1  DESTRUCTIVE-DELETE IS REFUSED. The registered destructive-delete hook,
#      driven with a crafted `rm -rf` payload, exits 2. This is half of the
#      pre-flight's literal done-means sentence.
#
#   2  FAST-TOOL IS REFUSED. The registered fast-tools hook, driven with a
#      crafted `grep -r` payload, exits 2, AND the refusal names `rg` — a
#      refusal that does not name the replacement is the dead-end-error class
#      (round 15/19), and AGENTS.md promises "the replacement is in the refusal
#      text". `find` is asserted too: the issue records the audit subagent
#      running BOTH grep and find unblocked, and settings.local.json explicitly
#      allowed `Bash(find:*)`.
#
#   3  ALL FOUR GATES ARE REGISTERED AND REACHABLE. fast-tools,
#      destructive-delete, irreversible-command, worktree-hygiene — the set
#      Development registers. Asserted in BOTH directions (round 11: "a hook-set
#      assertion needs both directions"): none missing, and none extra. A fifth
#      unexplained safety hook is config drift and should be seen.
#
#   4  NEGATIVE CONTROL — BENIGN COMMANDS STILL PASS. Every registered gate
#      exits 0 on `echo hello` and on `rg -n foo src/`. Without this, a
#      dispatcher that exited 2 unconditionally — i.e. one that had failed
#      closed and wedged the repo — would satisfy clauses 1-3 and look like
#      success. This is the clause that distinguishes "enforced" from "broken".
#
#   5  FAIL-CLOSED. With NO Development tree reachable by ANY of the resolver's
#      strategies, the dispatcher must exit 2 with a stated reason — never 0,
#      and never a non-verdict 127. This is the property whose ABSENCE is the
#      entire issue: the pre-fix world exits 127 and the harness reads that as
#      ALLOW. A fix that merely made the happy path work, while still exiting
#      non-2 when the Development tree is absent (a laptop without the volume
#      mounted, a fresh clone), would reintroduce #679 on the next machine.
#
#      HOW THIS CLAUSE IS DRIVEN, AND WHY IT IS NOT THE OBVIOUS WAY. The first
#      version set DEV_ROOT/OPENBRAIN_DEVELOPMENT_ROOT to a bogus path and
#      asserted exit 2. It PASSED — for the wrong reason, and the refusal text
#      gave it away: it was the UPSTREAM dispatcher's "Development root does not
#      exist" message, not this repo's. The resolver had correctly rejected the
#      bogus env roots and fallen through to $HOME/Development, which on this
#      machine is a symlink to the real tree. So the env vars alone can never
#      starve the resolver here, and the fail-closed branch was never reached:
#      a green clause proving nothing (round 9 — a clause whose PASS comes from
#      a negative match must be mutation-checked).
#
#      Driven instead by COPYING the dispatcher to a scratch location whose
#      walk-up parent holds no _ob/bin/ob-gate, with HOME and both env vars
#      pointed at that same barren directory. That starves all four strategies
#      at once, which is the only state in which the fail-closed branch runs.
#      The clause additionally asserts the refusal is THIS file's — it must name
#      OPENBRAIN_DEVELOPMENT_ROOT — so it can never again be satisfied by the
#      upstream dispatcher answering on the real tree's behalf.
#
#   6  permissions.deny CARRIES THE HARD FLOOR. Hooks are the actionable layer;
#      `permissions.deny` is the layer that holds when bun is missing or a file
#      is deleted (destructive-delete-gate.ts:26-33 — "deny is the floor; this
#      is the explanation layered on top"). open-brain had NO permissions block
#      at all. Assert the rm and fast-tool spellings are denied here.
#
#   7  NOTHING RE-ALLOWS WHAT THE FLOOR DENIES. settings.local.json must not
#      carry a `Bash(find:*)` allow. The issue names this explicitly: an allow
#      entry for a denied binary is a standing invitation to the exact call the
#      gate exists to refuse, and it is how this repo got here. Deny wins over
#      allow in the harness, so this is belt-and-braces — but a stale allow is
#      a misleading signal to every future reader of the file.
#
# Exit 0 only when every clause passes. Exit 3 is a HARNESS error (missing tool,
# unreadable repo) which is NOT a fail of the thing under test — a harness error
# must never be readable as a green.
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SETTINGS="$REPO_ROOT/.claude/settings.json"
LOCAL_SETTINGS="$REPO_ROOT/.claude/settings.local.json"

fail_hard() {
  printf 'HARNESS-ERROR: %s\n' "$1" >&2
  exit 3
}

command -v bun >/dev/null 2>&1 || fail_hard "bun not on PATH"
[ -r "$SETTINGS" ] || fail_hard "settings.json not readable at $SETTINGS"

# The four gates Development registers. Named here so clause 3 can assert the
# set in both directions.
EXPECTED_GATES="destructive-delete fast-tools irreversible-command worktree-hygiene"

# ---------------------------------------------------------------------------
# Extract the REGISTERED hook commands from the real settings.json.
#
# Round 25: extract from the real file, never retype. This emits one line per
# PreToolUse Bash hook command that mentions ob-gate, with ${CLAUDE_PROJECT_DIR}
# and $CLAUDE_PROJECT_DIR substituted the way Claude Code substitutes them.
#
# A retyped copy of the command would prove the copy. Reading the file is the
# only thing that proves the REGISTRATION, which is the defect.
# ---------------------------------------------------------------------------
extract_registered_commands() {
  SETTINGS_PATH="$SETTINGS" PROJECT_DIR="$REPO_ROOT" bun -e '
    const fs = require("node:fs");
    const settings = JSON.parse(fs.readFileSync(process.env.SETTINGS_PATH, "utf8"));
    const projectDir = process.env.PROJECT_DIR;
    const out = [];
    for (const entry of settings?.hooks?.PreToolUse ?? []) {
      // The matcher must actually cover Bash, or the hook never runs on the
      // tool that runs rm and grep. A gate registered under a matcher that
      // excludes Bash is registered and useless.
      if (!/(^|\|)Bash(\||$)/.test(entry?.matcher ?? "")) continue;
      for (const hook of entry?.hooks ?? []) {
        const raw = hook?.command ?? "";
        if (!raw.includes("ob-gate")) continue;
        out.push(raw
          .replaceAll("${CLAUDE_PROJECT_DIR}", projectDir)
          .replaceAll("$CLAUDE_PROJECT_DIR", projectDir));
      }
    }
    process.stdout.write(out.join("\n"));
  ' 2>/dev/null
}

REGISTERED_COMMANDS="$(extract_registered_commands)"

# Round 25: "0 lines extracted, all cases as expected" is a vacuous green. If
# nothing was extracted that is a legitimate RED (the pre-fix world), not a
# harness error — so it is recorded as failing clauses, never as exit 3.
REGISTERED_COUNT=0
if [ -n "$REGISTERED_COMMANDS" ]; then
  REGISTERED_COUNT="$(printf '%s\n' "$REGISTERED_COMMANDS" | wc -l | tr -d ' ')"
fi

# Which gate name does a registered command carry? (last whitespace token)
gate_name_of() { printf '%s' "${1##* }"; }

# ---------------------------------------------------------------------------
# Drive one registered hook command the way Claude Code does: a PreToolUse JSON
# payload on stdin. Sets HOOK_EXIT and HOOK_STDERR.
#
# Round 21: never read an exit status through a pipeline whose PIPESTATUS is
# evaluated in another shell. The command substitution below captures stderr and
# $? is read immediately, in this shell.
# ---------------------------------------------------------------------------
HOOK_EXIT=0
HOOK_STDERR=""
run_registered() {
  local hook_command="$1"
  local command_text="$2"
  local payload
  payload="$(
    COMMAND_TEXT="$command_text" bun -e '
      process.stdout.write(JSON.stringify({
        session_id: "679-dev-safety-gates-done-means",
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_input: { command: process.env.COMMAND_TEXT ?? "" },
      }));
    '
  )" || fail_hard "could not build hook payload"

  HOOK_STDERR="$(printf '%s' "$payload" | CLAUDE_PROJECT_DIR="$REPO_ROOT" \
    /usr/bin/env bash -c "$hook_command" 2>&1 >/dev/null)"
  HOOK_EXIT=$?
}

# Find the registered command for one gate. Empty when it is not registered.
command_for_gate() {
  local want="$1" line
  [ -n "$REGISTERED_COMMANDS" ] || return 0
  while IFS= read -r line; do
    [ -n "$line" ] || continue
    if [ "$(gate_name_of "$line")" = "$want" ]; then
      printf '%s' "$line"
      return 0
    fi
  done <<< "$REGISTERED_COMMANDS"
}

CLAUSES=()
record() { CLAUSES+=("$1|$2|$3"); }

# ---------------------------------------------------------------------------
# CLAUSE 1 — a destructive delete is REFUSED
# ---------------------------------------------------------------------------
DD_CMD="$(command_for_gate destructive-delete)"
if [ -z "$DD_CMD" ]; then
  record 1 FAIL "no destructive-delete hook is registered for Bash in $SETTINGS — rm runs unguarded"
else
  # A path under the temp workspace, deliberately: the rule has NO carve-out,
  # and a crafted violation that a carve-out would excuse proves less.
  run_registered "$DD_CMD" "rm -rf /Volumes/ThunderBolt/_tmp/open-brain/_scratch/679-crafted-violation"
  if [ "$HOOK_EXIT" -ne 2 ]; then
    record 1 FAIL "crafted \`rm -rf\` was NOT refused (exit=$HOOK_EXIT; PreToolUse reads any non-2 as ALLOW)"
  elif ! printf '%s' "$HOOK_STDERR" | rg -qiF 'BLOCKED'; then
    record 1 FAIL "exit=2 but the refusal text never says it blocked anything"
  else
    record 1 PASS "crafted \`rm -rf\` refused by the registered hook (exit=2)"
  fi
fi

# ---------------------------------------------------------------------------
# CLAUSE 2 — a fast-tool call is REFUSED, and the refusal names the replacement
# ---------------------------------------------------------------------------
FT_CMD="$(command_for_gate fast-tools)"
if [ -z "$FT_CMD" ]; then
  record 2 FAIL "no fast-tools hook is registered for Bash in $SETTINGS — grep/find run unguarded"
else
  run_registered "$FT_CMD" "grep -r needle ."
  GREP_EXIT="$HOOK_EXIT"
  GREP_STDERR="$HOOK_STDERR"
  run_registered "$FT_CMD" "find . -name '*.ts'"
  FIND_EXIT="$HOOK_EXIT"

  if [ "$GREP_EXIT" -ne 2 ]; then
    record 2 FAIL "crafted \`grep -r\` was NOT refused (exit=$GREP_EXIT)"
  elif [ "$FIND_EXIT" -ne 2 ]; then
    record 2 FAIL "\`grep\` refused but crafted \`find\` was NOT (exit=$FIND_EXIT) — the issue records both running unblocked"
  elif ! printf '%s' "$GREP_STDERR" | rg -qF 'rg '; then
    record 2 FAIL "grep refused but the refusal never names \`rg\` — a dead-end refusal (round 15/19)"
  else
    record 2 PASS "crafted \`grep -r\` and \`find\` both refused (exit=2), and the grep refusal names rg"
  fi
fi

# ---------------------------------------------------------------------------
# CLAUSE 3 — all four gates registered and reachable, none missing, none extra
# ---------------------------------------------------------------------------
MISSING=""
UNREACHABLE=""
for gate in $EXPECTED_GATES; do
  cmd="$(command_for_gate "$gate")"
  if [ -z "$cmd" ]; then
    MISSING="$MISSING $gate"
    continue
  fi
  # Reachable means: driven with a benign payload it returns a VERDICT (0 or 2),
  # not a shell "command not found" (127) or an interpreter error. 127 is the
  # pre-fix world and is precisely what fails open.
  run_registered "$cmd" "echo reachability probe"
  if [ "$HOOK_EXIT" -ne 0 ] && [ "$HOOK_EXIT" -ne 2 ]; then
    UNREACHABLE="$UNREACHABLE $gate(exit=$HOOK_EXIT)"
  fi
done

EXTRA=""
if [ -n "$REGISTERED_COMMANDS" ]; then
  while IFS= read -r line; do
    [ -n "$line" ] || continue
    name="$(gate_name_of "$line")"
    case " $EXPECTED_GATES " in
      *" $name "*) ;;
      *) EXTRA="$EXTRA $name" ;;
    esac
  done <<< "$REGISTERED_COMMANDS"
fi

if [ -n "$MISSING" ]; then
  record 3 FAIL "gates not registered:$MISSING (registered command count: $REGISTERED_COUNT)"
elif [ -n "$UNREACHABLE" ]; then
  record 3 FAIL "registered but UNREACHABLE (non-verdict exit — this is failing OPEN):$UNREACHABLE"
elif [ -n "$EXTRA" ]; then
  record 3 FAIL "unexpected extra safety gate registered:$EXTRA — config drift, name it or remove it"
else
  record 3 PASS "all 4 gates registered for Bash and returning verdicts:$(printf ' %s' $EXPECTED_GATES)"
fi

# ---------------------------------------------------------------------------
# CLAUSE 4 — NEGATIVE CONTROL: benign commands still pass every gate
# ---------------------------------------------------------------------------
OVERFIRE=""
if [ -z "$REGISTERED_COMMANDS" ]; then
  record 4 FAIL "no gates registered, so the control cannot discriminate (see clause 3)"
else
  # Distinguish the two non-zero worlds by name. exit 2 is a real over-fire (the
  # gate blocked something benign — a wedged repo). Any OTHER non-zero is a
  # non-verdict: the hook crashed or was never found, which the harness reads as
  # ALLOW. Reporting the second as "BLOCKED" would send the next reader to fix
  # over-firing when the actual defect is that nothing ran at all (round 6: a
  # wrong cause is the dangerous half of a wrong clause).
  NONVERDICT=""
  while IFS= read -r line; do
    [ -n "$line" ] || continue
    name="$(gate_name_of "$line")"
    for benign in "echo hello" "rg -n needle src/"; do
      run_registered "$line" "$benign"
      if [ "$HOOK_EXIT" -eq 2 ]; then
        OVERFIRE="$OVERFIRE $name:[$benign]"
      elif [ "$HOOK_EXIT" -ne 0 ]; then
        NONVERDICT="$NONVERDICT $name:[$benign]=exit$HOOK_EXIT"
      fi
    done
  done <<< "$REGISTERED_COMMANDS"

  if [ -n "$NONVERDICT" ]; then
    record 4 FAIL "gates returned NO VERDICT on benign commands (crashed/not found, read as ALLOW):$NONVERDICT"
  elif [ -n "$OVERFIRE" ]; then
    record 4 FAIL "benign commands were BLOCKED (exit=2) —$OVERFIRE — a wedged repo is not an enforced one"
  else
    record 4 PASS "\`echo hello\` and \`rg -n needle src/\` allowed by every registered gate (exit=0)"
  fi
fi

# ---------------------------------------------------------------------------
# CLAUSE 5 — FAIL-CLOSED when the gate cannot be found
#
# Drives the REAL registered dispatcher, with its root resolution pointed at a
# directory that exists but holds no gates. Exit 2 (block + explain) is the only
# acceptable answer. Exit 0 is #679 itself; 127 is the pre-fix world.
# ---------------------------------------------------------------------------
DISPATCHER="$REPO_ROOT/.claude/hooks/ob-gate"
if [ ! -x "$DISPATCHER" ]; then
  record 5 FAIL "no repo-local dispatcher at .claude/hooks/ob-gate to test the fail-closed property against"
else
  # Starve EVERY resolution strategy at once. A barren directory serves as the
  # walk-up parent, as $HOME, and as both env roots; none of them contains
  # _ob/bin/ob-gate, so the resolver has nowhere left to fall through to. This
  # is the only state in which the fail-closed branch executes.
  FC_SCRATCH="$REPO_ROOT/.679-fail-closed-probe.$$"
  FC_BARREN="$FC_SCRATCH/barren"
  mkdir -p "$FC_BARREN/open-brain/.claude/hooks" || fail_hard "cannot create fail-closed probe dir"
  cp "$DISPATCHER" "$FC_BARREN/open-brain/.claude/hooks/ob-gate" \
    || fail_hard "cannot stage dispatcher for the fail-closed probe"
  chmod +x "$FC_BARREN/open-brain/.claude/hooks/ob-gate" 2>/dev/null

  payload="$(
    bun -e '
      process.stdout.write(JSON.stringify({
        session_id: "679-fail-closed",
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_input: { command: "echo hello" },
      }));
    '
  )" || fail_hard "could not build fail-closed payload"

  FC_STDERR="$(printf '%s' "$payload" | \
    HOME="$FC_BARREN" \
    DEV_ROOT="$FC_BARREN/nonexistent" \
    OPENBRAIN_DEVELOPMENT_ROOT="$FC_BARREN/nonexistent" \
    "$FC_BARREN/open-brain/.claude/hooks/ob-gate" destructive-delete 2>&1 >/dev/null)"
  FC_EXIT=$?

  if [ "$FC_EXIT" -eq 0 ]; then
    record 5 FAIL "an unresolvable gate root exited 0 — FAILS OPEN, which is #679 reintroduced"
  elif [ "$FC_EXIT" -ne 2 ]; then
    record 5 FAIL "an unresolvable gate root exited $FC_EXIT; PreToolUse reads any non-2 as ALLOW, so this fails open"
  elif [ -z "$FC_STDERR" ]; then
    record 5 FAIL "blocked at exit=2 but said nothing — a silent block wedges the lane with no reason"
  elif ! printf '%s' "$FC_STDERR" | rg -qF 'OPENBRAIN_DEVELOPMENT_ROOT'; then
    # Guards against the false green this clause was rewritten to kill: an exit
    # 2 produced by the UPSTREAM dispatcher on a real tree, rather than by this
    # repo's resolver running out of strategies.
    record 5 FAIL "exit=2 but the refusal is not this repo's fail-closed message (never names OPENBRAIN_DEVELOPMENT_ROOT) — the probe did not starve the resolver: $(printf '%s' "$FC_STDERR" | tr '\n' ' ' | cut -c1-200)"
  else
    record 5 PASS "with no Development tree reachable by any strategy, exits 2 naming the remedy — fails CLOSED"
  fi

  ARCHIVE_DIR="/Volumes/ThunderBolt/_tmp/open-brain/_archive"
  if mkdir -p "$ARCHIVE_DIR" 2>/dev/null; then
    mv "$FC_SCRATCH" "$ARCHIVE_DIR/679-fail-closed-probe.$(date +%s).$$" 2>/dev/null
  fi
fi

# ---------------------------------------------------------------------------
# CLAUSE 6 — permissions.deny carries the hard floor
# ---------------------------------------------------------------------------
DENY_MISSING="$(
  SETTINGS_PATH="$SETTINGS" bun -e '
    const fs = require("node:fs");
    const s = JSON.parse(fs.readFileSync(process.env.SETTINGS_PATH, "utf8"));
    const deny = s?.permissions?.deny ?? [];
    const required = ["Bash(rm:*)", "Bash(grep:*)", "Bash(find:*)"];
    process.stdout.write(required.filter((r) => !deny.includes(r)).join(" "));
  ' 2>/dev/null
)"
if [ -n "$DENY_MISSING" ]; then
  record 6 FAIL "permissions.deny is missing the hard floor: $DENY_MISSING"
else
  record 6 PASS "permissions.deny carries Bash(rm:*), Bash(grep:*), Bash(find:*)"
fi

# ---------------------------------------------------------------------------
# CLAUSE 7 — nothing re-allows what the floor denies
#
# settings.local.json is untracked machine-local state, so its ABSENCE is a
# pass, not a harness error.
# ---------------------------------------------------------------------------
if [ ! -r "$LOCAL_SETTINGS" ]; then
  record 7 PASS "no settings.local.json present — nothing re-allows a denied binary"
else
  BAD_ALLOWS="$(
    LOCAL_PATH="$LOCAL_SETTINGS" bun -e '
      const fs = require("node:fs");
      let s = {};
      try { s = JSON.parse(fs.readFileSync(process.env.LOCAL_PATH, "utf8")); } catch { }
      const allow = s?.permissions?.allow ?? [];
      const banned = ["grep", "egrep", "fgrep", "find", "rm", "mktemp", "shred"];
      process.stdout.write(
        allow.filter((a) => banned.some((b) => a.startsWith(`Bash(${b}:`) || a === `Bash(${b})`)).join(" "));
    ' 2>/dev/null
  )"
  if [ -n "$BAD_ALLOWS" ]; then
    record 7 FAIL "settings.local.json re-allows denied binaries: $BAD_ALLOWS"
  else
    record 7 PASS "settings.local.json carries no allow entry for a denied binary"
  fi
fi

# ---------------------------------------------------------------------------
# Report
# ---------------------------------------------------------------------------
label_for() {
  case "$1" in
    1) printf 'a crafted destructive delete is REFUSED in this repo' ;;
    2) printf 'a crafted fast-tool call is REFUSED, naming the replacement' ;;
    3) printf 'all 4 Development safety gates registered + reachable (none missing, none extra)' ;;
    4) printf 'CONTROL — benign commands still pass every gate' ;;
    5) printf 'an unresolvable gate root FAILS CLOSED (exit 2), never open' ;;
    6) printf 'permissions.deny carries the hard floor' ;;
    7) printf 'settings.local.json re-allows nothing the floor denies' ;;
  esac
}

printf 'registered ob-gate hook commands extracted from %s: %s\n\n' \
  "${SETTINGS#"$REPO_ROOT"/}" "$REGISTERED_COUNT"

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
