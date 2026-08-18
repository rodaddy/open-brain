#!/usr/bin/env bash
# DONE-MEANS check for issue #512 — Codex sessions carry the same direct Python
# Open Brain provider structure already proven on Claude.
#
#   bash scripts/done-means/512-codex-adapter.sh
#
# ---------------------------------------------------------------------------
# What was MEASURED on 2026-08-09 before this check was written
# ---------------------------------------------------------------------------
# Codex CLI 0.147.0 has a NATIVE hook engine (`features.hooks = true`), config
# at `~/.codex/hooks.json`. Its event vocabulary, read out of the Rust binary's
# own strings (`hooks/src/events/*.rs`), is Claude-Code-shaped: PreToolUse,
# PermissionRequest, PostToolUse, PreCompact, PostCompact, SessionStart,
# SessionEnd, SubagentStart, SubagentStop, UserPromptSubmit, Stop.
#
# Three facts decide this gate's shape, all observed live, none inferred:
#
#   1. PAYLOADS ARE FIELD-COMPATIBLE. A real `codex exec` run emitted
#      SessionStart {session_id, transcript_path, cwd, hook_event_name, model,
#      permission_mode, source=startup}. All snake_case. `SessionStartHook` and
#      `StopHook` are all-optional with extra="ignore", so the CANON (read) path
#      needs no payload change and is not what this gate measures.
#
#   2. A CODEX TRANSCRIPT READER ALREADY EXISTS — and it is BROKEN on the
#      installed Codex. `openbrain.apps.bulk.formats.codex_raw_turn_from_line`
#      already maps `event_msg/user_message` to a user turn and
#      `event_msg/task_complete` to an assistant turn. But
#      `CodexTaskCompletePayload.time_to_first_token_ms` is a REQUIRED int, and
#      Codex 0.147.0 OMITS that field when a turn produced no tokens. Measured
#      against a real rollout:
#          codex_raw_turn_from_line -> MalformedCodexRecordError
#          "observed shape failed at time_to_first_token_ms"
#          lines=10 turns=0 errors=1
#      Across every rollout written on 2026-08-09: 144 `task_complete` records
#      carry the field, 1 does not — and the one that does not came from
#      `codex exec`, which is precisely the automation path a Workflow lane
#      uses. `ingest.py:179` RE-RAISES, so ONE such line aborts the WHOLE
#      ingest with a file:line. Rare input, total failure.
#
#      The minimal correct change is therefore to make the field optional
#      (it is pure telemetry — no turn content depends on it), NOT to write a
#      second parser. Round 22's "stub the boundary, don't extract a helper"
#      applies: the owning boundary is the payload model.
#
#   3. HOOK TRUST IS A HARD, SILENT GATE. Codex hash-pins every hook entry.
#      Binary strings: "New hook - review required", "Modified since last
#      trusted - review required", "Continue without trusting (hooks won't
#      run)". Measured: newly-added hooks did NOT run under `codex exec` and a
#      deliberately-blocking hook could not block; with
#      `--dangerously-bypass-hook-trust` the same hooks fired and the blocker
#      returned `UserPromptSubmit Blocked`. Corroboration that this is
#      longstanding, not an artifact of this session: an unrelated PreToolUse
#      trace hook registered on 2026-07-30 has never once written its log file.
#
# ---------------------------------------------------------------------------
# The existing design, and the delta
# ---------------------------------------------------------------------------
# `_ob/scripts/ob-memory-provider/wiring/codex-hooks.json` and
# `codex-config.toml` are INACTIVE shape-reference fixtures ("No hook command is
# registered by this fixture") describing the RETIRED TypeScript adapter.
# `docs/agent-memory-adapter-contract.md` keeps auth/namespace server-side and
# distillation client-side, so a Codex transcript reader is an additive
# CLIENT-side concern, not a contract change.
#
# `docs/memory-contract.md` states Codex's durable route is daemon-mode
# `mcp2cli open-brain`. Per #512 that route STAYS for remote/uninstalled boxes;
# this adapter is additive where the Python stack is installed. Clause (e) pins
# that, because removing it would strand remote boxes and is out of scope.
#
# ---------------------------------------------------------------------------
# Clauses
# ---------------------------------------------------------------------------
#   (a) RED ANCHOR — a real-shaped Codex rollout whose `task_complete` omits
#       `time_to_first_token_ms` parses without raising, yielding turns.
#       Today this raises MalformedCodexRecordError and yields 0.
#   (b) BOTH ROLES — that rollout yields a human prompt AND an assistant reply,
#       so capture cannot report agent volume as operator volume (the
#       `is_human_prompt` invariant capture-never-drops-a-turn.md relies on).
#   (c) CONTROL, STRICTNESS PRESERVED — a genuinely malformed record (a
#       `task_complete` missing `turn_id`, a field turn identity depends on)
#       must STILL raise. Without this, "fixing" the gate by setting
#       extra="ignore" on everything, or by swallowing all errors, would pass
#       (a) and (b) while destroying the loud-quarantine contract.
#   (d) CONTROL, SILENCE IS NOT A TURN — non-speech records (session_meta,
#       turn_context, world_state, task_started) must NOT become turns. Without
#       this, returning a turn per line passes (a) and (b) by inventing content.
#   (e) SCOPE PIN — the documented mcp2cli route for Codex survives.
#   (f) The adapter doc exists and names the hook trust gate and its bypass,
#       because a correct hooks.json that is never trusted is a silent no-op,
#       and "document the gap, never fake it" is the issue's own instruction.
#
# Output is content-free: counts, roles, statuses, and exception class names
# only. No transcript text, no tokens, no memory bodies.
#
# EXPECTED TO FAIL until #512 is implemented. It is the reward function, not a
# test of the fix's author.
set -uo pipefail

# When the subject IS repo code, resolve the repo from THIS script's own tree so
# the check structurally cannot reach across worktrees (lane-contract round 12,
# sharpened round 21).
SCRIPT_DIR="$(CDPATH='' cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(CDPATH='' cd -- "$SCRIPT_DIR/../.." && pwd)"
PKG="$REPO_ROOT/python/openbrain"

fail_hard() {
  printf 'HARNESS-ERROR: %s\n' "$1" >&2
  exit 3
}

[ -d "$PKG" ] || fail_hard "python package missing at $PKG"
command -v uv >/dev/null 2>&1 || fail_hard "uv not on PATH (the Python runner; system python is forbidden by policy)"

FIXTURE="$REPO_ROOT/scripts/done-means/fixtures/512-codex-rollout.jsonl"
# The fixture is a REAL `codex exec` rollout's line shapes with content replaced
# by neutral text — captured 2026-08-09, no session ids, no instructions, no user
# data. Its `task_complete` omits `time_to_first_token_ms` exactly as the live
# one did. A fixture invented by the same reasoning as the fix would prove only
# that the reasoning is self-consistent (lane-contract round 20).
[ -r "$FIXTURE" ] || fail_hard "codex rollout fixture missing at $FIXTURE"

ADAPTER_DOC="$REPO_ROOT/docs/codex-adapter.md"
MEMORY_CONTRACT="$REPO_ROOT/docs/memory-contract.md"

printf '=== done-means #512 — Codex adapter (direct Python provider) ===\n'

# ---------------------------------------------------------------------------
# Clauses (a)-(d) are decided by ONE probe run so every assertion is judged by
# the same parser in the same interpreter.
#
# The import is DYNAMIC (importlib), not a top-level `from ... import`: a static
# import of a not-yet-existing symbol dies at module resolution before any
# clause prints, which is a FALSE RED indistinguishable in shape from a real one
# (lane-contract round 22).
# ---------------------------------------------------------------------------
PROBE_OUT="$(cd "$PKG" && FIXTURE="$FIXTURE" uv run --quiet python - <<'PY' 2>&1
import importlib
import json
import os
import sys

try:
    formats = importlib.import_module("openbrain.apps.bulk.formats")
    parse = formats.codex_raw_turn_from_line
except Exception as error:  # the reader itself is missing or broken
    print(f"IMPORT_ERROR={type(error).__name__}")
    sys.exit(0)

turns, roles, humans, raised = [], set(), 0, ""
with open(os.environ["FIXTURE"], encoding="utf-8") as handle:
    for line in handle:
        if not line.strip():
            continue
        try:
            turn = parse(line)
        except Exception as error:
            raised = type(error).__name__
            break
        if turn is not None:
            turns.append(turn)
            roles.add(str(getattr(turn, "role", "?")).split(".")[-1].lower())
            humans += 1 if getattr(turn, "is_human_prompt", False) else 0

print(f"RAISED={raised}")
print(f"TURNS={len(turns)}")
print(f"ROLES={','.join(sorted(roles))}")
print(f"HUMANS={humans}")

# Clause (c): strictness must survive. `turn_id` is a field turn identity
# depends on, so its absence must STILL be a loud rejection.
bad = json.dumps({
    "timestamp": "2026-08-09T18:22:36.000Z",
    "type": "event_msg",
    "payload": {
        "type": "task_complete",
        "last_agent_message": "x",
        "started_at": 1,
        "completed_at": 2,
        "duration_ms": 3,
    },
})
try:
    parse(bad)
    print("STRICT=no-raise")
except Exception as error:
    print(f"STRICT={type(error).__name__}")
PY
)"

case "$PROBE_OUT" in
  *IMPORT_ERROR=*)
    # A reader that cannot be imported is a RED for (a), not a harness fault.
    RAISED="$(printf '%s\n' "$PROBE_OUT" | sed -n 's/^IMPORT_ERROR=//p' | tail -1)"
    TURNS=0; ROLES=""; HUMANS=0; STRICT="import-failed"
    ;;
  *)
    RAISED="$(printf '%s\n' "$PROBE_OUT" | sed -n 's/^RAISED=//p' | tail -1)"
    TURNS="$(printf '%s\n' "$PROBE_OUT" | sed -n 's/^TURNS=//p' | tail -1)"
    ROLES="$(printf '%s\n' "$PROBE_OUT" | sed -n 's/^ROLES=//p' | tail -1)"
    HUMANS="$(printf '%s\n' "$PROBE_OUT" | sed -n 's/^HUMANS=//p' | tail -1)"
    STRICT="$(printf '%s\n' "$PROBE_OUT" | sed -n 's/^STRICT=//p' | tail -1)"
    ;;
esac

# An empty capture must not read as a clean 0 and look like an honest RED.
[ -n "${TURNS:-}" ] || fail_hard "probe produced no TURNS line; output was: $(printf '%s' "$PROBE_OUT" | tr '\n' ' ')"
[ -n "${STRICT:-}" ] || fail_hard "probe produced no STRICT line; output was: $(printf '%s' "$PROBE_OUT" | tr '\n' ' ')"

# --- (a) red anchor ---------------------------------------------------------
if [ -z "$RAISED" ] && [ "$TURNS" -gt 0 ]; then
  CLAUSE_A=PASS
  CLAUSE_A_EVIDENCE="real-shaped rollout parsed to $TURNS turns with no exception"
elif [ -n "$RAISED" ]; then
  CLAUSE_A=FAIL
  CLAUSE_A_EVIDENCE="parser raised $RAISED on a real Codex rollout — one such line aborts the whole ingest"
else
  CLAUSE_A=FAIL
  CLAUSE_A_EVIDENCE="parsed to 0 turns with no exception — silent zero capture"
fi

# --- (b) both roles present -------------------------------------------------
case ",$ROLES," in *,user,*) HAS_USER=1 ;; *) HAS_USER=0 ;; esac
case ",$ROLES," in *,assistant,*) HAS_ASSISTANT=1 ;; *) HAS_ASSISTANT=0 ;; esac

if [ "$HAS_USER" -eq 1 ] && [ "$HAS_ASSISTANT" -eq 1 ] && [ "${HUMANS:-0}" -ge 1 ]; then
  CLAUSE_B=PASS
  CLAUSE_B_EVIDENCE="roles=[$ROLES] human_prompts=$HUMANS"
else
  CLAUSE_B=FAIL
  CLAUSE_B_EVIDENCE="roles=[${ROLES:-<none>}] human_prompts=${HUMANS:-0} (need both roles and >=1 human prompt)"
fi

# --- (c) control: strictness preserved --------------------------------------
case "$STRICT" in
  MalformedCodexRecordError)
    CLAUSE_C=PASS
    CLAUSE_C_EVIDENCE="a task_complete missing turn_id still raises MalformedCodexRecordError"
    ;;
  no-raise)
    CLAUSE_C=FAIL
    CLAUSE_C_EVIDENCE="a task_complete missing turn_id was ACCEPTED — the loud-quarantine contract was loosened into a no-op"
    ;;
  *)
    CLAUSE_C=FAIL
    CLAUSE_C_EVIDENCE="strictness probe returned '$STRICT' instead of MalformedCodexRecordError"
    ;;
esac

# --- (d) control: silence is not a turn -------------------------------------
# The fixture holds 6 records; exactly 2 are speech (user_message,
# task_complete). A reader inventing a turn per line would report 6.
FIXTURE_RECORDS=6
if [ "$TURNS" -gt 0 ] && [ "$TURNS" -lt "$FIXTURE_RECORDS" ]; then
  CLAUSE_D=PASS
  CLAUSE_D_EVIDENCE="$TURNS turns from $FIXTURE_RECORDS records — non-speech records correctly declined"
elif [ "$TURNS" -ge "$FIXTURE_RECORDS" ]; then
  CLAUSE_D=FAIL
  CLAUSE_D_EVIDENCE="$TURNS turns from $FIXTURE_RECORDS records — non-speech records are being invented as turns"
else
  CLAUSE_D=FAIL
  CLAUSE_D_EVIDENCE="no turns parsed, so the not-faked control cannot be satisfied"
fi

# --- (e) scope pin ----------------------------------------------------------
if [ -r "$MEMORY_CONTRACT" ] && grep -q 'mcp2cli open-brain' "$MEMORY_CONTRACT"; then
  CLAUSE_E=PASS
  CLAUSE_E_EVIDENCE="memory-contract still documents the mcp2cli route (additive change; remote boxes unaffected)"
else
  CLAUSE_E=FAIL
  CLAUSE_E_EVIDENCE="the documented mcp2cli route for Codex is gone; #512 is additive and must not strand remote boxes"
fi

# --- (f) trust gate documented ----------------------------------------------
if [ -r "$ADAPTER_DOC" ] \
  && grep -qi 'trust' "$ADAPTER_DOC" \
  && grep -q 'dangerously-bypass-hook-trust' "$ADAPTER_DOC"; then
  CLAUSE_F=PASS
  CLAUSE_F_EVIDENCE="docs/codex-adapter.md documents the hook trust gate and its bypass"
else
  CLAUSE_F=FAIL
  CLAUSE_F_EVIDENCE="docs/codex-adapter.md missing, or does not name the trust gate that makes an untrusted hook a silent no-op"
fi

printf '  (a) real rollout parses           : %s — %s\n' "$CLAUSE_A" "$CLAUSE_A_EVIDENCE"
printf '  (b) both roles, human attributed  : %s — %s\n' "$CLAUSE_B" "$CLAUSE_B_EVIDENCE"
printf '  (c) control, strictness preserved : %s — %s\n' "$CLAUSE_C" "$CLAUSE_C_EVIDENCE"
printf '  (d) control, silence is not a turn: %s — %s\n' "$CLAUSE_D" "$CLAUSE_D_EVIDENCE"
printf '  (e) mcp2cli route preserved       : %s — %s\n' "$CLAUSE_E" "$CLAUSE_E_EVIDENCE"
printf '  (f) trust gate documented         : %s — %s\n' "$CLAUSE_F" "$CLAUSE_F_EVIDENCE"

if [ "$CLAUSE_A" = PASS ] && [ "$CLAUSE_B" = PASS ] && [ "$CLAUSE_C" = PASS ] \
  && [ "$CLAUSE_D" = PASS ] && [ "$CLAUSE_E" = PASS ] && [ "$CLAUSE_F" = PASS ]; then
  printf 'DONE-MEANS 512: PASS\n'
  exit 0
fi
printf 'DONE-MEANS 512: FAIL\n'
exit 1
