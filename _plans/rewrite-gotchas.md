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

- **Exact stdout bytes per hook event.** What Claude Code expects on stdout
  for each hook event the entrypoints will serve (`SessionStart`,
  `UserPromptSubmit`, `Stop`, `PreCompact`, `SessionEnd` — verify the real
  event-name set against the harness docs before building). Source must be
  **captured real input/output** from a live session, not the old
  `claude-hook.ts` and not a fixture written from docs. Owned by step 8.

## Answered

(move a question here with where the answer landed — a decision record,
`docs/GOTCHAS.md`, or a test using captured real data)
