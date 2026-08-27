---
lane: correctness
order: 95
---
## [2026-08-27] A hoisted module-scope const that calls a lower-defined function throws at import

**Severity:** MEDIUM
**Source:** PR #935; session-9 #878 split-and-convert lanes
**Scope:** any test file whose `it` bodies were hoisted to module scope to satisfy `max-lines-per-function`

**Status:** active

### Pattern

Hoisting an `it` body out of a describe callback to a named module-scope function moves every line it declared with it, including consts. A `const` whose initializer calls a function declared further down the file is fine inside the callback — the callback runs after the whole module has evaluated — and throws `ReferenceError` the moment it becomes module-scope, because module-scope initializers evaluate top to bottom at import.

The trap is that this typechecks clean. `tsc` resolves the function by declaration, not by evaluation order, so a green typecheck over a hoist of this shape says nothing about whether the module can be loaded at all. The failure surfaces as an import-time crash of the entire file, which reads as a broken suite rather than a bad hoist.

### Check

- After a hoist, run the suite. A green `tsc` is not the receipt for this class of change.
- Hoist a const's callees alongside it, or convert the callee to a `function` declaration so it hoists on its own.
- `rg` the hoisted const's initializer for identifiers defined later in the file before accepting the move.
