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

## Verified event-name set

Confirmed against the live harness docs (`https://code.claude.com/docs/en/hooks`,
which now redirects there from the old `docs.anthropic.com` path). The docs list
~29 events; the ones this capture proves by firing are below. The plan's worry
that `PostCompact` may not exist is unresolved by capture — it was not
triggered here (see uncaptured). `PreCompact` DOES exist and fired.

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

The common fields present on every capture are `session_id`,
`transcript_path`, `cwd`, and `hook_event_name`; most also carry `prompt_id`
once a prompt exists.

## Uncaptured (with reason)

- **`PostCompact`** — would require a real compaction to complete. The one
  `/compact` run fired `PreCompact` but then reported "Not enough messages to
  compact", so compaction never completed and `PostCompact` never fired.
  Filling context to force a real compaction is a large, expensive run that
  pollutes real session-lane memory out of proportion to a nice-to-have; not
  attempted.
- Every other documented event (Setup, PermissionRequest, Notification,
  MessageDisplay, TaskCreated/Completed, WorktreeCreate/Remove, FileChanged,
  CwdChanged, Elicitation, etc.) — out of scope for this task; not triggered.

## Proven-accepted hook response

Each capture hook wrote ONLY to its capture file and exited 0 with **no bytes
on stdout**. Every headless run completed with exit 0 and the expected model
reply, so **empty stdout + exit code 0 is an accepted hook response for all
eight captured events** — including the tool and decision events. This matches
the docs' "empty stdout with exit code 0 ... means 'proceed normally'".

## Capture-condition caveats

- These runs were headless (`claude -p`), which defaults to
  `permission_mode: "bypassPermissions"`. That value is a fact about the
  capture condition, not about how an interactive session would report; a
  parser must not assume `bypassPermissions`.
- Paths (`transcript_path`, `cwd`, `agent_transcript_path`) point at the
  throwaway `hookcap` project and at this machine's `~/.claude`. They are real
  and byte-exact, but environment-specific; tests should assert on shape and
  key presence, not on these literal paths.
- `SessionStart.source` is `"startup"` here because each run was a fresh
  session; `resume`, `clear`, `compact`, and `fork` are the other documented
  values and were not exercised.
