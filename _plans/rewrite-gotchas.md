# Rewrite gotchas — stub questions the old adapter must not answer

**What this is:** the questions file named by
`_plans/python-port-sequence.md` ("Build from the decisions, not from the old
file"). When a step needs a fact whose only source is the old TypeScript
adapter, the step writes a **stub**, records the question HERE, and asks the
operator. It does not read the answer out of a file scheduled for deletion.

This file was referenced by the plan since 2026-07-30 but did not exist until
2026-07-31 — an executing session had nowhere to put the question, which is
one way "just peek at the old file" happens.

Measured record-shape facts (answered questions) live in `docs/GOTCHAS.md`.
This file is only the OPEN questions.

---

## Open

### Step 8 stub capabilities — RESOLVED 2026-07-31, defaults grounded in existing design

Operator directive 2026-07-31 ("get all of this done"): proceed on grounded
defaults, operator veto stands. Testing budget per the same directive: fast
mechanical gates per step; heavy testing deferred to one end pass.

| event | ruling | grounded in |
|---|---|---|
| `SessionStart` | **stays stub** | the package-owned ob-memory-provider already injects SessionStart hydration today; a second injection is a second implementation (`_plans/consolidation-2026-07-30.md:99`) |
| `UserPromptSubmit` | **stays stub** | Stop already captures operator turns from the transcript; capturing here double-stores |
| `PreToolUse` | **stays stub** | gating is enforcement, not capture; policy hooks own it |
| `PostToolUse` | **stays stub** | deciding it here would resolve the open memory-vs-observability decision by accident (this file, above) |
| `PreCompact` | **stays stub** | turns are durable on every Stop; nothing to flush |
| `PostCompact` | **implemented `64cba18` 2026-07-31** | the compact summary record (transcript line, `isCompactSummary:true`) has no `promptSource`, so `is_operator_turn` is False and `raw_turn_from_line` returns None (`apps/capture/records.py`); the Stop spine reads forward over it and drops it. `post_compact` now records it: `run_post_compact` (`apps/hooks/session.py`) builds one `RawTurn` from `compact_summary` and sends it through the SAME `_started_memory` factory + `RawLane.ingest_raw_turns` the Stop spine uses, keyed on `prompt_id` for server-side dedup, WHOLE (no bound), fail-open |
| `SessionEnd` | **implement: close the session** | lifecycle belongs to `AgentMemory` (`agent.py:222`); closing releases a finite per-worker session slot |
| `SubagentStop` | **implement: same spine over `agent_transcript_path`** | namespace is TOKEN-derived (`_plans/python-port-sequence.md:11`), so the lane question answers itself; `capture-never-drops-a-turn.md` says turns get captured |

### Original questions (kept for the record)

Step 8 (2026-07-31) landed `apps/hooks/` with `stop.py` real (delivers through
the spine) and one stub per other VERIFIED event. Each stub parses stdin and
exits 0; what capability it should serve is NOT decided and must not be invented
from the old TypeScript (`takeover.ts`, `qmd-startup.ts` are out of scope to
read). One open question per stub:

- **`SessionStart` — inject startup context, and if so what?** The old adapter's
  `qmd-startup.ts` did. Whether the Python app reproduces that, and from where,
  is undecided.
- **`UserPromptSubmit` — capture the prompt here too, or leave it to `Stop`?**
  The spine already stores operator turns from the transcript on `Stop`; also
  capturing on this event risks double-storing. Undecided.
- **`SessionEnd` — final flush, session close, or nothing?** The watermark
  advances on every `Stop`, so turns are durable without a close. Whether a hook
  should call the client's `close` (releasing the server session) is separate
  and undecided.
- **`PreToolUse` — observation or enforcement?** This event can GATE a tool call
  (a policy hook), a different job from capture. Whether the capture app owns any
  `PreToolUse` behaviour, or a separate guard does, is undecided.
- **`PostToolUse` — capture the tool stream, and where?** Tool input/output is
  the ~96% of `ob_raw_turns` that `capture-never-drops-a-turn.md` explicitly
  leaves UNDECIDED (memory vs observability). Resolving this here would resolve
  that open decision by accident.
- **`SubagentStop` — drive the spine against the subagent transcript?** A
  subagent carries its own `agent_transcript_path`, so this could run the same
  delivery. Whether subagent turns belong in the same lane, a different
  namespace, or nowhere is undecided.
- **`PreCompact` — flush before context is discarded?** The spine already
  captures every `Stop`, so turns survive compaction regardless. Whether this
  needs to act is undecided.
- **`PostCompact` — record the `compact_summary`, or nothing?** Now that the
  event is captured (2026-07-31), it has a stub module like the others. It
  carries `compact_summary`, the generated summary that replaces the discarded
  context; the spine already made the pre-compaction turns durable on `Stop`, so
  whether this hook should also record the summary is undecided.

## Answered

- **`PostCompact` stdin/stdout** (was open above). A REAL completed compaction
  was forced on 2026-07-31 against Claude Code 2.1.220: a fixed-`--session-id`
  headless session (cheapest model, `claude-haiku-4-5-20251001`) was filled with
  several `claude -p --resume` turns, then `/compact` was invoked over the same
  session. Compaction COMPLETED (the transcript carries `"isCompactSummary":true`;
  no "not enough messages"), and **`PostCompact` fired**. Captured byte-exact at
  `python/openbrain/tests/fixtures/captured_hooks/PostCompact.json`; it carries
  `trigger` (`"manual"`) and `compact_summary`. **Bonus:** a second
  `SessionStart` with **`source":"compact"`** fired in the same run (carrying
  `prompt_id` and `model`, which the `"startup"` variant lacks) — the documented
  post-compaction alternative, now observed. Step 8 gained a `post_compact.py`
  stub, a dispatch entry, and the fixture-driven test; the response answer holds
  — empty stdout + exit 0 was accepted for `PostCompact` too.
- **Exact stdout bytes per hook event** (was: verify the real event-name set,
  then capture real I/O). Captured 2026-07-31 against Claude Code 2.1.220 as
  byte-exact fixtures in `python/openbrain/tests/fixtures/captured_hooks/` (one
  representative stdin per event, plus a `README.md` with method, verified
  event-name set, and the proven response). Covered: `SessionStart`,
  `UserPromptSubmit`, `Stop`, `SessionEnd`, `PreToolUse`, `PostToolUse`,
  `SubagentStop`, `PreCompact`. **Response answer:** empty stdout + exit 0 is an
  accepted hook response for all eight — the capture hooks emitted no stdout and
  every run exited 0. `PreCompact` exists and fires (the plan's `PostCompact`
  worry is the one still open, above). Source is captured real input, not the
  old `claude-hook.ts` and not docs prose.
