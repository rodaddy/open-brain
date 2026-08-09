# Codex Adapter — the direct Python Open Brain provider on Codex

State: **WRITTEN**, with one RUNNING measurement set (below). The repo-side
parser fix and this document are merged code and prose; the machine-side hook
registration is described here but is NOT claimed as running on any box other
than where its receipt says so.

Issue: #512. Sibling of the Claude swap (2026-08-02) and the Pi adapter.

## Why this exists

Claude sessions on this box reach Open Brain through wrapper-invoked console
scripts from the installed `openbrain` / `openbrain-provider` packages:

```
sh /Users/rico/.local/share/openbrain-memory/env/openbrain-hook-env <console-script>
```

Codex's route, per `docs/memory-contract.md`, is daemon-mode
`mcp2cli open-brain`. That route **stays** — it is the correct answer for remote
and uninstalled boxes, and #512 is explicitly additive. This document covers the
native Codex runtime on a box where the Python stack IS installed.

## Codex's real hook surface (measured, Codex CLI 0.147.0)

Codex has a native hook engine. It is enabled by `features.hooks = true` in
`~/.codex/config.toml` and configured in **`~/.codex/hooks.json`** — a separate
file from `config.toml`, in Claude's `{"hooks": {EventName: [{matcher, hooks:
[{type, command, timeout}]}]}}` shape.

Event vocabulary, read from the binary's own strings (`hooks/src/events/*.rs`):

| Codex event | Claude counterpart | OB use |
| --- | --- | --- |
| `SessionStart` | `SessionStart` | canon injection |
| `UserPromptSubmit` | `UserPromptSubmit` | gates |
| `PreToolUse` | `PreToolUse` | `ob-guard`, gates |
| `PostToolUse` | `PostToolUse` | — |
| `PermissionRequest` | (none) | — |
| `PreCompact` / `PostCompact` | same | checkpoint |
| `SessionEnd` | `SessionEnd` | wrap |
| `SubagentStart` / `SubagentStop` | `SubagentStop` | subagent capture |
| `Stop` | `Stop` | capture |

Codex emits **snake_case payload fields identical to Claude's**. Captured live
from a real `codex exec` run:

```json
{"session_id":"...","transcript_path":"/Users/rico/.codex/sessions/.../rollout-....jsonl",
 "cwd":"...","hook_event_name":"SessionStart","model":"...",
 "permission_mode":"bypassPermissions","source":"startup"}
```

`UserPromptSubmit` adds `turn_id` and `prompt`; `SessionEnd` adds `reason`.
Because `SessionStartHook` and `StopHook` are all-optional with
`extra="ignore"`, **the canon read path needs no payload change at all.**

## THE TRUST GATE — read this before registering anything

Codex **hash-pins every hook entry**. A new or edited entry is untrusted until
reviewed, and an untrusted hook **does not run**. The binary's own strings:

- `New hook - review required`
- `Modified since last trusted - review required`
- `Continue without trusting (hooks won't run)`
- `--dangerously-bypass-hook-trust`

**This fails silently and it looks like success.** Measured 2026-08-09: a probe
hook and a deliberately-blocking hook were added to `~/.codex/hooks.json`, then
`codex exec` was run twice. Codex printed `hook: ... Completed` for the
already-trusted entries, the new entries never ran, no files were written, and
the blocker could not block. With `--dangerously-bypass-hook-trust` the same
entries fired and the blocker correctly returned `UserPromptSubmit Blocked`.

Corroboration that this is longstanding rather than an artifact of that session:
an unrelated `PreToolUse` trace hook registered on 2026-07-30 has **never once**
written its log file.

Consequences for anyone wiring this:

1. Editing `hooks.json` de-trusts the entries you touched.
2. Trust is granted in the **interactive TUI** (`startup_hooks_review.rs`:
   "Review hooks" / "Trust all and continue"). `codex exec` is non-interactive
   and therefore cannot grant it.
3. For non-interactive lanes, either trust the entries once in the TUI first, or
   pass `--dangerously-bypass-hook-trust` deliberately and record that you did.
4. **Never conclude a hook works because Codex printed `Completed`** — that line
   is emitted for the hooks that ran, and says nothing about the one you added.

## Transcript compatibility — the real gap, and what was fixed

Codex rollout JSONL is **not** Claude's format. It carries `session_meta`,
`turn_context`, `world_state`, `event_msg/*`, and `response_item/*` records,
with no `uuid`, no `promptSource`, and no Claude `message` envelope. The Claude
hook-path parser (`openbrain.apps.capture.records.raw_turn_from_line`) requires
`uuid`, so a real Codex rollout parses to **0 turns** through it — a silent zero
capture with a clean exit 0, the #525/#544 failure class.

A Codex reader already existed for the bulk ingester:
`openbrain.apps.bulk.formats.codex_raw_turn_from_line`, mapping
`event_msg/user_message` to a user turn and `event_msg/task_complete` to an
assistant turn. It was **broken on Codex 0.147.0**:
`CodexTaskCompletePayload.time_to_first_token_ms` was required, and Codex omits
it when a turn produced no tokens. Because `ingest.py` re-raises rather than
skipping, one such line aborted an entire ingest.

Measured across every rollout written on 2026-08-09: 144 `task_complete` records
carried the field, 1 did not — and that one came from `codex exec`, the path
automation uses. The fix makes the field optional (it is telemetry; no turn
content depends on it) while `turn_id`, `last_agent_message`, and the timestamps
stay required so malformed records are still quarantined loudly.

After the fix, across all of 2026-08-09's rollouts:

```
lines=27196 turns=430 errors=0
```

Gate: `scripts/done-means/512-codex-adapter.sh`.

### Why `event_msg`, not `response_item`

`response_item/message:user` is contaminated: Codex injects AGENTS.md,
environment context, and policy text as `user`-role records, so treating it as
operator speech would attribute injected instructions to Rico. The
`event_msg/user_message` and `event_msg/task_complete` records carry the clean
prompt and the final answer, which is why the existing adapter keys on them.

## Gaps where Codex's surface does not reach Claude's

Stated explicitly rather than papered over, per #512.

1. **No `Notification` event.** Claude's `Notification` registration has no
   Codex counterpart. Not emulated.
2. **Trust gating has no non-interactive grant.** There is no
   `codex hooks trust <path>` command; the only paths are the TUI review or the
   bypass flag. A fleet rollout cannot grant trust by writing a file, which
   makes this the main obstacle to wiring the remaining boxes.
3. **`additionalContext` is bounded by Codex.** `HookMetadata` carries an
   `additionalContextLimit`. Claude's canon path already learned that an
   oversized injection gets diverted to a preview file (see
   `session_start.py`); the Codex limit is a separate, unmeasured bound. The
   two-emission split that canon already performs is what keeps this tolerable,
   but the exact Codex ceiling has NOT been measured here.
4. **Capture is not wired by this change.** The parser now handles Codex
   rollouts, but `openbrain-capture-stop` reads Claude transcripts via
   `records.raw_turn_from_line`. Routing the hook path to the Codex adapter by
   transcript shape is follow-on work and is deliberately not claimed here.
5. **Subagent capture is unverified.** Codex has `SubagentStart`/`SubagentStop`,
   but Codex subagents write their own rollouts and the per-subagent watermark
   key has not been exercised on this runtime.

## Registration shape (WRITTEN, not deployed by this change)

For a box where the Python stack is installed, the Codex-side registrations
mirror Claude's one-for-one, using the same wrapper so the environment contract
(`openbrain-hook-env`) is identical:

```json
{
  "hooks": {
    "SessionStart": [
      { "matcher": "*", "hooks": [
        { "type": "command", "timeout": 10,
          "command": "sh /Users/rico/.local/share/openbrain-memory/env/openbrain-hook-env openbrain-session-start" },
        { "type": "command", "timeout": 10,
          "command": "sh /Users/rico/.local/share/openbrain-memory/env/openbrain-hook-env openbrain-session-start-remaining" }
      ]}
    ]
  }
}
```

The wrapper is required, not optional: the Python config rejects any
`OPENBRAIN_*` variable it does not declare, the hook entrypoints swallow that
rejection by design, and the result is a silent zero capture with exit 0. The
wrapper's own header documents this at length.

Do **not** point Codex at core01 or hardcode a host: endpoint and token come
from `$OPENBRAIN_BASE_URL` / `$OPENBRAIN_TOKEN` in `claudex-observation.env`.
