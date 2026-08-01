# Captured Claude Code hook stdin

Real hook stdin, byte-exact as the harness delivered it. These exist so the
step-8 entrypoint tests parse what the harness actually sends, not a fixture
hand-written from docs. Each `<EventName>.json` is a single JSON object on one
line, no trailing newline, no pretty-printing, no normalization.

## Provenance

- **Harness version:** Claude Code 2.1.220 (`claude --version`).
- **Capture date:** 2026-07-31.
- **Method:** a throwaway project (`hookcap`) registered, in its own
  `.claude/settings.json`, a command hook per event that appended stdin
  verbatim to `captured/<EventName>.jsonl` and exited 0 with **empty stdout**.
  Events were fired with three headless runs plus one `/compact`:
  `claude -p '<trivial>' --max-turns N --settings .claude/settings.json`.
  Each `<EventName>.json` here is the first captured occurrence of that event.
- **`PostCompact` addendum (2026-07-31):** the earlier `/compact` ran in a
  near-empty session and declined with "Not enough messages to compact", so it
  fired only `PreCompact`. A second capture forced a REAL completed compaction:
  a fixed `--session-id` session was filled with several `claude -p --resume`
  turns (cheapest model, `claude-haiku-4-5-20251001` — hooks fire regardless of
  model), then `/compact` was invoked over the same session with
  `claude -p --resume "$SID" --settings … '/compact'`. Compaction COMPLETED
  (the transcript now carries `"isCompactSummary":true`; no "not enough
  messages"), and **`PostCompact` fired** — captured here byte-exact. A second
  `SessionStart` with **`source":"compact"`** fired in the same run (see
  caveats). Harness 2.1.220.

## Verified event-name set

Confirmed against the live harness docs (`https://code.claude.com/docs/en/hooks`,
which now redirects there from the old `docs.anthropic.com` path). The docs list
~29 events; the ones this capture proves by firing are below. The plan's worry
that `PostCompact` may not exist is now RESOLVED: it exists and fired once a real
compaction completed (2026-07-31). `PreCompact` DOES exist and fired too.

## Captured (fired and recorded here)

| Event | Fired by | Notable real fields beyond the common set |
|-------|----------|-------------------------------------------|
| `SessionStart` | every run | `source` (`"startup"`) |
| `UserPromptSubmit` | every run | `prompt`, `prompt_id`, `permission_mode` |
| `Stop` | every run | `stop_hook_active`, `last_assistant_message`, `effort`, `background_tasks`, `session_crons` |
| `SessionEnd` | every run | `reason` (`"other"`) |
| `PreToolUse` | a run that forced a `Bash` call | `tool_name`, `tool_input`, `tool_use_id` |
| `PostToolUse` | same run's tool result | `tool_name`, `tool_input`, `tool_response`, `tool_use_id`, `duration_ms` |
| `SubagentStop` | a run that spawned a `Task` subagent | `agent_id`, `agent_type`, `agent_transcript_path`, `last_assistant_message` |
| `PreCompact` | a `/compact` run | `trigger` (`"manual"`), `custom_instructions` (`null`) |
| `PostCompact` | a `/compact` run whose compaction COMPLETED | `trigger` (`"manual"`), `compact_summary` (the generated summary that replaces the discarded context) |

The common fields present on every capture are `session_id`,
`transcript_path`, `cwd`, and `hook_event_name`; most also carry `prompt_id`
once a prompt exists.

## Uncaptured (with reason)

- Every other documented event (Setup, PermissionRequest, Notification,
  MessageDisplay, TaskCreated/Completed, WorktreeCreate/Remove, FileChanged,
  CwdChanged, Elicitation, etc.) — out of scope for this task; not triggered.

## Proven-accepted hook response

Each capture hook wrote ONLY to its capture file and exited 0 with **no bytes
on stdout**. Every headless run completed with exit 0 and the expected model
reply, so **empty stdout + exit code 0 is an accepted hook response for all
nine captured events** — including the tool, decision, and compaction events.
This matches the docs' "empty stdout with exit code 0 ... means 'proceed
normally'".

## Capture-condition caveats

- These runs were headless (`claude -p`), which defaults to
  `permission_mode: "bypassPermissions"`. That value is a fact about the
  capture condition, not about how an interactive session would report; a
  parser must not assume `bypassPermissions`.
- Paths (`transcript_path`, `cwd`, `agent_transcript_path`) point at the
  throwaway `hookcap` project and at this machine's `~/.claude`. They are real
  and byte-exact, but environment-specific; tests should assert on shape and
  key presence, not on these literal paths.
- `SessionStart.source` is `"startup"` in the `SessionStart.json` fixture
  because that capture was a fresh session. The `PostCompact` run also exercised
  `"resume"` (each `--resume` turn) and **`"compact"`** — after compaction the
  harness fires a fresh `SessionStart` with `source":"compact"`, and that record
  additionally carries `prompt_id` and `model`, which the `"startup"` variant
  does not. `clear` and `fork` remain the two documented `source` values not yet
  exercised. The stored `SessionStart.json` fixture is left as the original
  `"startup"` capture; the compact-source observation is recorded here as a
  fact, not as a second SessionStart fixture (one representative stdin per event).
