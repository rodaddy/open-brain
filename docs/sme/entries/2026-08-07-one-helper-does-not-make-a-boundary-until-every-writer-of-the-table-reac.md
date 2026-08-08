---
lane: correctness
order: 64
section: harvest-522
---
## [2026-08-07] One helper does not make a boundary until every writer of the table reaches it

**Severity:** HIGH
**Source:** issue #605, PR #611 (thought-write chunk routing)
**Scope key:** `review.shared_write_boundary_reaches_all_writers`
**Status:** active

### Pattern

`src/chunk-write.ts` defined how a long thought must be stored — complete parent plus per-section chunk rows — and only ONE of the four writers that insert into `thoughts` called it. The rewrite-tree `log_thought` (`server/tools/capture.ts`), REST `POST /api/v1/thoughts` (`src/rest-api.ts`), and lane graduation (`src/tiering.ts`) each wrote a parent and stopped, so whether a 6 KB thought kept its per-section resolution depended on which door it came through. The storage rule existed, was documented, was tested, and was still false for three of four callers.

The tell was a receipt field hardcoded to a constant: `capture.ts` returned `chunks_written: 0` unconditionally. A literal in a count field reports the shape of a code path rather than the state of the row, and it reads as a legitimate value (a short entry really does write zero chunks), so it survives review and makes the bypass invisible in the response.

Review questions when any helper is described as "the" boundary for a table:

- Count the writers first (`rg` the INSERT against the table name), then name which ones call the helper. "The write path" is a claim about a set, not about one file.
- Refactor the already-compliant caller ONTO the shared function rather than leaving it as a fourth copy that happens to agree. Four implementations that agree today are not one boundary; they are four things that will drift.
- Fixtures do not catch this when they exercise the trivial case. The parity fixture asserting `chunks_written: 0` passed both before and after the fix, because its thought was under the threshold — the field is genuinely 0 on both sides. A fixture that can never distinguish the defect from correct behavior is not coverage.
- In the acceptance gate, drive each path at its REAL entry point and assert on distinct provenance (here: `source` values `mcp` / `rest` / `lane-tiering`). Calling the shared helper three times, or driving three paths that quietly funnel into one, proves nothing about routing.
