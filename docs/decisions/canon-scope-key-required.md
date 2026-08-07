# A canon lifecycle action requires a scope key

**Scope key:** `canon.lifecycle.scope_key_required`
**Source:** https://github.com/rodaddy/open-brain/issues/445
**Recorded:** 2026-08-03 (harvest #522, operator-routed)
**Status:** settled. Recorded from the source issue/PR; verify against current code before relying on an implementation detail.

---

## The decision

Every promotable canon rule MUST carry a stable metadata.candidate_scope.key. The lifecycle stream is append-only with no server-enforced identity, so supersession is reconciled only through that key: retiring a rule is a newer relegate/discard on the SAME key, never a database hand-edit. A promoted row with no scope key can never be proven current or cleanly retired.

## Verbatim, from the source

> **A promoted item with no `candidate_scope.key` cannot be proven current.** ... So the missing prerequisite is: **require a stable `candidate_scope.key` on every promotable `user_preference` / `process_rule`**

## Provenance

Harvested in #522 from the issue/PR text cited above, reviewed by the operator on
2026-08-03, and routed here rather than into a guidance lane: a decision with
rationale worth not re-litigating lives in a file, not only in a closed issue.
The quote is byte-identical to the harvest record; the decision paragraph is the
harvest's distilled rule text, unedited.
