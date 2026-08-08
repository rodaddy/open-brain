---
lane: adversarial
order: 17
---
## [2026-07-22] Per-member object framing must be position-aware, not uniform

**Severity:** P2 (MEDIUM)
**Source:** PR #349 / Issue #326 Terra terminal-audit finding
**Scope:** `src/tools/agent-context-pack-budget.ts` `sectionFrameCost`,
`src/tools/agent-context-pack.ts` whole-pack section allocation
**Status:** active — fixed regression in
`src/tools/__tests__/agent-context-pack-budget.test.ts`

### Pattern

The whole-pack allocator reserved the enclosing `{}` once (2 chars) up front,
then charged `sectionFrameCost = key.length + 3 + 1` — a comma — for **every**
admitted section. But JSON writes object members as `"key":<body>` joined by a
single `,` *between* adjacent members: the FIRST member has no leading comma.
Charging a comma for the first admitted member overcounted exactly one character,
so content whose serialized section sat on the exact whole-pack boundary was
falsely truncated. Reproduction: a single small working-set item whose unbounded
serialized `sections` length equals the limit exactly (e.g. 804 chars, the budget
for `max_tokens=501`) was dropped even though it fit.

The fix makes framing position-aware:
- the **first** admitted member charges `key.length + 3` (quoted key + colon,
  no comma);
- each **subsequent** admitted member charges `key.length + 3 + 1` (add one
  comma).

Crucially, "first" tracks whether any earlier candidate was *actually admitted* —
a starved-out or omitted candidate must not consume the comma-free first-member
slot, so the next admitted section still frames as the first. This is distinct
from the [zero-floor entry above](#2026-07-22-declared-budget-limits-must-admit-their-own-irreducible-framing):
that one is about the *container's* irreducible `{}` floor; this one is about
*per-member* delimiter accounting between members inside the container.

**Fixed invariant:** for any admitted set of sections, the running budget spent
equals `2 (outer braces) + Σ member framing + Σ member bodies`, where member
framing is `key.length + 3` for the first admitted member and `key.length + 3 + 1`
for each subsequent one — i.e. exactly `JSON.stringify(sections).length`. Content
that fits the limit exactly is retained; nothing is dropped by an off-by-one
delimiter overcharge.

### Review Questions

- When a helper charges "framing" or "delimiter" cost per collection member, is
  the cost position-sensitive (first member has no separator) or does it
  uniformly charge a separator that the first element never pays?
- Does a "first member" flag flip only on *actual admission*, so a starved,
  omitted, or absent earlier candidate cannot steal the separator-free slot from
  a later admitted one?
- Is there an exact-boundary regression (serialized length == limit, no additive
  slack) proving content on the limit is retained, not truncated?
- Is the framing accounting validated against real `JSON.stringify` output for
  single-member and multi-member objects, not just an asserted formula?
