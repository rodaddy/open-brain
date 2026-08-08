---
lane: gotcha-agent
order: 25
---
## A port is complete when the BEHAVIOUR matches, not when the tests pass

**Provenance:** #447, found 2026-08-03 during the capture-both-sides fix.
**Severity:** HIGH — silent, permanent data loss on the primary product path.
**Status:** active.

### Pattern

The Python capture port replaced a TypeScript adapter and passed its own full
suite — 453 tests, mypy clean, ruff clean, plus a live Postgres gate. It had
also silently stopped recording half of every conversation.

The old adapter captured the assistant's replies
(`scripts/backfill-transcripts.ts:125`). The port's record parser only ever
returned a turn for operator records, so every `type == "assistant"` line
became `None`. Measured on the dogfood database, `ob_raw_turns`:

| Day | assistant | tool | user | Path |
|---|---|---|---|---|
| 2026-07-27 | 5,773 | 3,022 | 495 | TypeScript adapter |
| 2026-07-30 | 3,332 | 1,877 | 255 | TypeScript adapter |
| 2026-08-02 | 13 | 0 | 365 | Python port |

and all 13 of those were `PostCompact` summaries, not replies.

**Why every gate stayed green.** The tests were written FROM the port, so they
asserted what it did. A helper named `assistant_line` existed in `conftest.py`
and was used only to prove an assistant record was *correctly declined*. The
suite encoded the defect as intended behaviour, at which point no amount of
coverage can surface it.

**Why review missed it.** Nothing in the diff looked wrong. `is_operator_turn`
is a correct predicate, `operator_text` is a correct accessor, and the module
docstring described operator parsing accurately and in detail. The defect was
not a bad line — it was an ABSENT branch, and absence does not appear in a
diff. The one artifact that would have caught it was the governing decision doc
sitting in the same repo, which had already settled the scope in one sentence:
*"the operator's words and the assistant's replies, in full"*
(`docs/decisions/capture-never-drops-a-turn.md:215`).

**The corroborating signal that was already present.** The Codex adapter in the
same package had captured both sides all along, and `test_bulk_ingest.py`
asserted a `TurnRole.ASSISTANT` turn for it. One adapter satisfying a contract
its sibling silently did not is a defect signal, not a style difference.

### Review Questions

- **Does a row count exist for before and after?** A port that changes what
  reaches durable storage must be checked against the volume the old path
  produced. "The tests pass" and "the same data lands" are different claims, and
  only the second one is about the product. One `GROUP BY` answers it.
- **Were the tests written from the new code or from the contract?** Tests
  derived from the implementation cannot fail on a missing branch, because they
  never knew to ask for it. Check that at least one assertion traces to a
  decision doc, an issue, or the replaced implementation.
- **Does a test helper exist whose only use is to prove something is DECLINED?**
  That is where an unimplemented branch hides — the helper documents the gap as
  if it were a rule. Ask what would use it if the branch existed.
- **Is there a sibling adapter, client, or runtime that handles the same input?**
  If one captures a field, a role, or a record type the other drops, name the
  asymmetry and make someone justify it. Two implementations of one contract
  disagreeing is the cheapest defect signal available and it is usually free.
- **Does the replaced implementation still exist to diff against?** Read it for
  branches, not for style. An absent branch is invisible in the new file and
  obvious side by side.
- **For a capture/ingest path specifically: does an end-to-end test assert a
  COUNT, not just per-record shape?** Every per-record assertion in #447 passed.
  Only "a two-speaker transcript delivers 2" fails on the defect.

---
