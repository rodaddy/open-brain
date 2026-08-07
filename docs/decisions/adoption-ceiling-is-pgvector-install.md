# The adoption ceiling is the pgvector install

**Scope key:** `repo.open_brain.adoption_ceiling_is_pgvector_install`
**Source:** issue #405 (SHAPE-5)
**Recorded:** 2026-08-03 (harvest #522, operator-routed)
**Status:** settled. Recorded from the source issue/PR; verify against current code before relying on an implementation detail.

---

## The decision

Portability analysis on 2026-07-24 found the adoption ceiling is the Postgres 18 + pgvector install, not GPU or platform: most of the design needs no model at all (light is model-free, dedupe is a hash plus a vector compare, authority tiers are known at write time, bi-temporal is four columns, the assertions are SQL), and the two places models appear are already config, not ports. Any decision to accept the heavy install is a deliberate decision to cap adoption, not a default — settle it by timing a cold install on a clean machine with no Postgres.

## Verbatim, from the source

> **Postgres 18 + pgvector is a heavy install for someone who wants to try a thing in ten minutes.** That, not the GPU, is what caps adoption.

## Provenance

Harvested in #522 from the issue/PR text cited above, reviewed by the operator on
2026-08-03, and routed here rather than into a guidance lane: a decision with
rationale worth not re-litigating lives in a file, not only in a closed issue.
The quote is byte-identical to the harvest record; the decision paragraph is the
harvest's distilled rule text, unedited.
