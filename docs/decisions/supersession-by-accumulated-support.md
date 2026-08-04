# Supersession by accumulated support

**Scope key:** `repo.open_brain.supersession_by_accumulated_support`
**Source:** issue #396 (DREAM-7: Supersession)
**Recorded:** 2026-08-03 (harvest #522, operator-routed)
**Status:** settled. Recorded from the source issue/PR; verify against current code before relying on an implementation detail.

---

## The decision

Supersession in Open Brain resolves by accumulated support, not recency. An older claim defends itself with occurrence count, attached rationale, survival of prior contradictions, access count, `occurred_at` span, and source tier; a new claim with none of those is one utterance and must not beat a position reinforced twenty times over three months. Default to NOT superseding when close — a wrongly-kept contradiction is recoverable, a wrongly-erased position with tacit reasoning is gone permanently — and backfill-era conflicts are never auto-resolved.

## Verbatim, from the source

> **The rule is not newest-wins or oldest-wins: new must outweigh accumulated support, and a bare assertion carries almost no weight against a well-supported one.**

## Provenance

Harvested in #522 from the issue/PR text cited above, reviewed by the operator on
2026-08-03, and routed here rather than into a guidance lane: a decision with
rationale worth not re-litigating lives in a file, not only in a closed issue.
The quote is byte-identical to the harvest record; the decision paragraph is the
harvest's distilled rule text, unedited.
