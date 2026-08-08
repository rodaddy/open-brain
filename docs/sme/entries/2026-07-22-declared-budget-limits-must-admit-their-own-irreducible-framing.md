---
lane: adversarial
order: 16
---
## [2026-07-22] Declared budget limits must admit their own irreducible framing

**Severity:** P3 (LOW)
**Source:** PR #349 / Issue #326 confirmed finding
**Scope:** `src/tools/agent-context-pack.ts` whole-pack budget derivation
**Status:** active — fixed regression in
`src/tools/__tests__/agent-context-pack-budget.test.ts`

### Pattern

`agent_context_pack` reported `budget.whole_pack.content_char_limit` as the raw
member budget (`max_tokens * 4 - 1200`, clamped to 0). But
`JSON.stringify(payload.sections)` is irreducibly `"{}"` (2 chars) even when
every section is omitted, so for `max_tokens <= 300` (budget clamps to 0) the
contract "content_char_limit bounds the serialized sections object" was violated:
`2 <= 0` is false. Two omit tests masked it with `+ 2` slack instead of asserting
the true invariant. The declared serialized-section limit must account for the
irreducible empty object (floor of 2) while still leaving zero characters for
section members at those tiny budgets, and `content_chars_used` must stay
truthful and `<= content_char_limit`.

### Review Questions

- Does a declared serialized-size limit account for the container's irreducible
  framing (e.g. the `{}` an empty object always serializes to), or does a clamp
  to zero leave the limit below what `JSON.stringify` can ever emit?
- Do budget/limit tests assert `serialized.length <= limit` with NO additive
  slack, so a limit that is genuinely too small cannot pass?
- At the smallest budgets, is the member allocation still zero even though the
  declared limit is raised to the framing floor?
