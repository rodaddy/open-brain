---
lane: correctness
order: 38
---
## [2026-07-23] Canonical anchor identity must also satisfy display-name uniqueness

**Severity:** MEDIUM (P2)
**Source:** PR #358 exact-head terminal audit (issue #346)
**Scope:** `src/graph-derivation.ts`, entity tables with independent canonical-id and display-name unique indexes
**Status:** fixed-pre-merge

### Pattern

An anchor upsert correctly arbitrated on stable `canonical_id`, but the table also
enforced live uniqueness on `(namespace, entity_type, lower(name))`. Two distinct
source IDs with the same title therefore missed the canonical conflict and failed
on the name index with deterministic `23505`; a rename onto a sibling title failed
the same way.

### Rule

When one row is constrained by independent identity indexes, the stored values
must satisfy all of them. Keep the human label readable, append the stable
canonical identity to form a bounded collision-safe storage name, and preserve
the complete display label separately. Prove same-title creation and
rename-to-existing-title against real PostgreSQL.

### Review Questions

- Does an upsert arbitrate one unique index while another applicable index can
  still reject the proposed row?
- Can two stable IDs legitimately share a human title, and if so is the stored
  name deterministic, readable, bounded, and collision-safe?
- Does a real-PostgreSQL regression cover both duplicate-title creation and a
  rename onto an existing title?

### Follow-up: display state must refresh independently of structural derivation

A collision-safe name is incomplete if the unchanged short-circuit ignores a
pure title rename. The derivation hash intentionally covers the node set, not the
human label, so the `unchanged` path must separately compare and refresh the
stored name plus `metadata.display_name`. Production callers must pass the full
label to the primitive and bound only the indexed storage name; slicing upstream
silently destroys the supposedly preserved display value. Tests need a pure
rename with identical topics/people and a label longer than the storage limit.
