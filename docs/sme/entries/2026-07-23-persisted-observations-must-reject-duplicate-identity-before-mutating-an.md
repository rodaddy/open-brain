---
lane: correctness
order: 41
---
## [2026-07-23] Persisted observations must reject duplicate identity before mutating, and receipt fields must be reachable and truthful

**Severity:** MEDIUM
**Source:** PR #365 review swarm, 2026-07-23
**Scope:** any tool that persists an observation/record keyed by a derived
identity and returns a structured receipt
**Status:** fixed-pre-merge

### Pattern

Two coupled receipt-truth defects shipped together:

1. **Dedupe-after-mutation.** The write checked for an existing row with the same
   derived identity but only AFTER it had already begun mutating (or after the
   INSERT raced), so a duplicate identity could either partially apply or return a
   "created" receipt for a row it did not create. Identity-keyed persistence must
   reject the duplicate BEFORE any mutation — either a pre-mutation existence
   check inside the same locked transaction, or an `ON CONFLICT` that provably
   distinguishes a fresh create from a merge and returns the honest verdict
   (compare the [2026-07-22] seed-proof entry: `merged:false` proves a real
   create; a merge must not be reported as a creation).
2. **Unreachable / untruthful receipt fields.** The receipt advertised fields
   whose producing branch could never run (a status the code path no longer
   emits) or whose value contradicted what was persisted (a count/id that did not
   reflect the actual write). A receipt field that no branch can populate, or that
   is derived from a different value than the one written, is a dead or lying
   contract — every advertised field must be reachable and derived from the
   persisted row.

### Review Questions

- Does the write reject a duplicate derived identity BEFORE mutating (locked
  existence check or conflict-aware upsert), or can a duplicate partially apply /
  be reported as a fresh create?
- Is every receipt field reachable — is there a code path that actually emits
  each advertised status/field, and a test asserting the dead ones are absent
  (see the quality lane's unreachable-bucket entry)?
- Do the receipt's counts/ids/flags derive from the persisted row, so they cannot
  contradict what was written (see the seed-proof and whole-pack-truth entries)?
- Is there a regression that submits the same identity twice and proves the second
  call is rejected (no mutation, honest verdict), failing on the pre-fix
  mutate-then-check ordering?
