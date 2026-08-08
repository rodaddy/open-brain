---
lane: gotcha-agent
order: 26
---
## An allowlist that drops unrecognized keys is accept-and-ignore, not tolerance

**Provenance:** #464, found 2026-08-03 during the canon seeding run. Same
family as #447 and #515 — a request key the reader does not recognize is
discarded while the caller is told the write succeeded.
**Severity:** HIGH — false receipt on the advertised durable-write path.
**Status:** active.

### Pattern

The provider JSON-stdin CLI projects each request through a per-operation key
allowlist and drops everything else. That behavior was deliberate and
documented — "N-1 tolerant reader," so a newer caller does not break an older
reader — and it was the right idea applied without a boundary.

`capture` allowed `content`/`distilled`/`event_type`. The #445 promotion
vocabulary (`candidate_type`, `memory_lifecycle_action`, `candidate_scope`) was
not in that set, so a scripted promotion returned `status:saved`, wrote a row
with none of the metadata that makes it promotable, and seeded nothing. The
only trace was `compatibility_note: ignored_optional_request_keys` with a
COUNT and no names, which nothing fails on and nobody can act on.

Forward tolerance is for keys a future caller adds that this reader has no
opinion about. It is NOT a place to put keys the system already defines: those
have a meaning, and dropping one silently is the defect the tolerance was never
meant to cover.

### Review Questions

- **Does the drop path name what it dropped?** A count tells a caller that
  something was ignored without saying what, which is unactionable at the exact
  moment it matters. Names cost one list and make the receipt diagnosable.
- **Is any dropped key part of a vocabulary this codebase already defines?** Grep
  the dropped name against the project's own constant sets. A key that appears in
  `CANDIDATE_TYPES`, an enum, or a schema is not an unknown future field — it is
  a supported concept the reader forgot, and dropping it is a bug in both
  directions (honor it or reject it by name).
- **Does a sibling path accept what this one drops?** The client library
  (`AgentMemory.promote_candidate`) had carried the full vocabulary all along.
  One surface of the same product accepting what its sibling silently discards is
  the same asymmetry signal as #447.
- **Does a test assert the ABSENCE of a compatibility note on the happy path?**
  Asserting `status == "saved"` passes on both the honored and the dropped case.
  Only `"compatibility_note" not in receipt` distinguishes them.
