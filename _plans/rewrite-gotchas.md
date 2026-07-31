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

- **`PostCompact` stdin/stdout.** Only `PostCompact` remains uncaptured: a real
  compaction must complete for it to fire, and the one `/compact` run fired
  `PreCompact` then reported "Not enough messages to compact", so it never ran.
  Forcing a real compaction is a large, memory-polluting run out of proportion
  to a nice-to-have. Capture it if step 8 ends up serving `PostCompact`.

### Step 8 stub capabilities — what each hook should DO for the Python app

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
  needs to act is undecided. (Its sibling `PostCompact` has no module at all —
  see above.)

## Answered

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
