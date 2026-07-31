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
