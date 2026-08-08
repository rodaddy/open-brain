---
lane: gotcha-agent
order: 2
---
## [2026-07-06] Python DreamEngine wrappers must enforce server schema bounds

**Severity:** MEDIUM
**Source:** PR #254 gotcha lane for Issue #247
**Scope:** `python/openbrain-memory/src/openbrain_memory/dream.py`, any Python
wrapper that pre-validates MCP tool arguments
**Status:** fixed in PR #254; recurrence of #82 wrapper contract drift

### Pattern

`DreamEngine.decompose_entry()` initially accepted `max_chunk_chars` values from
`1..8000`, while the server schema and contract require `500..8000`. Happy-path
wrapper tests passed, but the wrapper could still emit a request the server
would reject.

### Review Questions

- Do Python wrapper bounds exactly match the server Zod schema and contract
  manifest, including lower bounds?
- Are boundary tests present for just-below-minimum, minimum, maximum, and
  just-above-maximum values?
- Do gotcha lanes check schema-compatible payloads rather than only method names
  or happy-path forwarding?
