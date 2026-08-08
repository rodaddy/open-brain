---
lane: gotcha-agent
order: 22
gap: 0
---
## [2026-07-26] Four defects that three review passes all missed

**Provenance:** PR #424, final independent gate. **Severity:** HIGH.
**Status:** fixed.

An author self-review and two swarm lanes all cleared `src/logger.ts`. A fourth
independent pass found four more defects in the same file, all reproduced. What
unites them is that every one is a **guard that was correct about its intent and
wrong about its mechanism** — so reading the code, and the comment above it,
confirms the intent and hides the flaw. Three passes read the intent.

**1. A redactor that cannot see what it is redacting.** Every detector was
value-shaped (`sk-…`, `ghp_…`, the literal text `password=…`). But a JSON
logger hands its replacer each value *in isolation*, so `{"password":
"hunter2driveway"}` emitted in clear. The pattern set already contained
`json_labeled_secret`, which matches that exact pair — when given the pair as
text. It was never shown the key. The detector list looked complete because it
was; the call site never supplied the context the detectors needed.

**2. A bound that manufactured the leak it existed to prevent.** Input was
truncated at 16 KB *before* the patterns ran, so a DSN straddling the boundary
was cut mid-credential, nothing matched the surviving head, and the tail went
out readable. Truncating cannot create a secret, but it can destroy the evidence
that one is present. Order of operations, not the operations.

**3. Cycle detection that flagged non-cycles.** A `WeakSet` that only ever grew
marked *any* object seen a second time as `"[Circular]"` — including one
referenced from two sibling fields, which is not a cycle. Sharing one
config/job/namespace object across fields is ordinary, so the false positive was
the common case, silently dropping real data. "Seen before" and "is its own
ancestor" are different questions; only the second one means circular.

**4. A reentrancy guard keyed on a value that collides.** `minLevel === widened`
cannot distinguish "my temporary value is still installed" from "a nested call
deliberately chose that same value." An existing test covered nested
`setLogLevel` and passed throughout — because its nested call picks a level that
*differs* from the widened one. The colliding case inverted the result while
telling the nested caller it had succeeded.

### Review Questions

- **Does this guard ever see the information it needs to decide?** A redactor
  handed one value at a time cannot act on the field name; a validator handed a
  parsed object cannot act on the raw bytes. Check the call site's data flow,
  not the guard's logic.
- **Does a sanitizer run before or after the thing that bounds it?** Truncate,
  normalize, encode, and redact are all order-sensitive. Ask which one runs
  first and what the other one can no longer see.
- **Is "have I seen this?" standing in for "is this an ancestor?"** A
  monotonically growing set answers the first. Cycle, recursion, and depth
  guards need the second, and the difference only shows on a DAG — repeated
  siblings, not loops.
- **Does the guard's key have collisions?** Comparing a *value* to detect "did
  someone else change this" fails whenever someone else picks the same value.
  Identity tokens, generation counters, and sentinels do not collide; values do.
- **Does the existing test for this exercise the colliding case?** A passing
  reentrancy/idempotency test often picks distinct values precisely because
  distinct values are easier to assert on. That is the case that cannot fail.
