# Dream proposes; the promoter applies

**Scope key:** `architecture.dream_proposes_promoter_applies`
**Source:** issue #161 (comment by rodaddy, design correction 2026-06-19)
**Recorded:** 2026-08-03 (harvest #522, operator-routed)
**Status:** settled. Recorded from the source issue/PR; verify against current code before relying on an implementation detail.

---

## The decision

Shared-truth promotion is server-side and identity-gated: a classifier/dreamer proposes shared-kb candidates and a separate privileged promoter identity (`openbrain-promoter`/`hermes-promoter`) applies them with provenance and audit receipts. Normal agents can read shared knowledge but cannot casually write shared truth — Dream proposes, promoter applies. No automatic unreviewed LLM truth promotion.

## Verbatim, from the source

> **Classifier/dreamer:** scores lane memories for shared-worthiness ... **Promoter/executor (promoter identity):** applies approved promotions into physical `shared-kb` with full provenance and audit receipts. Explicitly gated — Dream proposes, promoter applies.

## Provenance

Harvested in #522 from the issue/PR text cited above, reviewed by the operator on
2026-08-03, and routed here rather than into a guidance lane: a decision with
rationale worth not re-litigating lives in a file, not only in a closed issue.
The quote is byte-identical to the harvest record; the decision paragraph is the
harvest's distilled rule text, unedited.
