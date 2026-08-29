---
lane: correctness
order: 99
---
## [2026-08-29] A done-means grep anchors on the formatter output, not the typed line

**Severity:** MEDIUM
**Source:** PR #964
**Scope:** every `scripts/done-means/` clause that greps a source line, and every brief that dictates one
**Status:** active

### Pattern

The pre-commit prettier pass rewrites the staged file, so a checker anchored on a
hand-typed multi-token line stops matching after the commit and passes nothing.
The brief for #964 named the literal closer `}, GROWTH_SCAN_ALLOWANCE_MS);`;
prettier expands a three-argument `it()` onto separate lines and deletes that
exact string, which voids the checker itself rather than merely a receipt.

### Check

- Run prettier on the edited file before writing the clause, so the clause is
  written against the text that will actually exist on the committed tree.
- Anchor on a semantic token or a single-token line rather than a multi-token
  layout the formatter owns.
- Re-take RED, the deliberate miss, and GREEN on the committed tree, not on the
  pre-commit working copy.
