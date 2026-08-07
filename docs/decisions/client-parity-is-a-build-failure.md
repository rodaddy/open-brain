# Client parity is a build failure

**Scope key:** `process.client_parity_is_a_build_failure`
**Source:** issue #311
**Recorded:** 2026-08-03 (harvest #522, operator-routed)
**Status:** settled. Recorded from the source issue/PR; verify against current code before relying on an implementation detail.

---

## The decision

The TS and Python Open Brain memory clients are maintained as contract peers against one runtime-neutral fixture set in `contracts/memory/`, with a machine-checkable parity manifest. Parity is enforced as a build failure (the `contract-parity` CI job plus a repo-local pre-push hook) rather than by reviewer discipline, because the pair drifted in both directions within one week of shipping. Client-touching PRs must carry a `Contract parity:` line declaring fixtures updated or a stated runtime-specific reason.

## Verbatim, from the source

> Drift reality check: the clients are already asymmetric in both directions within one week of shipping (#307 drain is Python-only, #308 error_category is TS-adapter-only). Parity by discipline is not a plan; parity must be a build failure.

## Provenance

Harvested in #522 from the issue/PR text cited above, reviewed by the operator on
2026-08-03, and routed here rather than into a guidance lane: a decision with
rationale worth not re-litigating lives in a file, not only in a closed issue.
The quote is byte-identical to the harvest record; the decision paragraph is the
harvest's distilled rule text, unedited.
