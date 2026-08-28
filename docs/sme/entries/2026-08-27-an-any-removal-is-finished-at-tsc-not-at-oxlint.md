---
lane: correctness
order: 97
---
## [2026-08-27] An `as any` removal is finished at tsc, not at oxlint

**Severity:** MEDIUM
**Source:** pull request #948
**Scope:** any test or source file where `as any` casts are replaced under the oxlint sweep

**Status:** active

### Pattern

`any` suppresses resolution errors as well as type errors, so removing a cast can expose a same-name type from a dependency that lint cannot see. In #948 this repo's `AuthInfo` and the MCP SDK's `AuthInfo` share a name and differ in shape: twelve `auth: AuthInfo` annotations resolved to the SDK global once the casts went, tsc failed, and oxlint stayed clean throughout.

A green lint run therefore says nothing about whether the cast removal is finished.

### Check

- `bunx tsc --noEmit` on the committed tree is a required receipt of every cast-removal lane, not an optional extra after lint.
- A repo type that shares a name with a dependency type is aliased on import, and where a split produces two halves, the alias is re-exported from the shared lane helper so both halves annotate the same symbol. Cast only at the transport seam, using the SDK's own signature (`NonNullable<SendOptions>["authInfo"]`).
