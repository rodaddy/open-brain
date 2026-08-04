# Only idempotent writes are retried; the rest spool for explicit replay

**Scope key:** `decision.only_idempotent_writes_are_retried`
**Source:** rodaddy/open-brain#74, #85 (comments by rodaddy)
**Recorded:** 2026-08-03 (harvest #522, operator-routed)
**Status:** settled. Recorded from the source issue/PR; verify against current code before relying on an implementation detail.

---

## The decision

In the Python memory client, only `session_start` is retried in-process because it is idempotent by session_key; every other write spools on failure for explicit replay rather than being retried. Replay dispatchers receive the whole SpoolRecord (not just operation/payload) so the idempotency key survives, and replay removes only successfully dispatched records while preserving anything appended during the replay.

## Verbatim, from the source

> Non-idempotent writes are not automatically retried; they spool redacted payloads for explicit replay. Replay dispatch receives SpoolRecord so callers can inspect idempotency_key and decide how to map it to supported backend fields.

## Provenance

Harvested in #522 from the issue/PR text cited above, reviewed by the operator on
2026-08-03, and routed here rather than into a guidance lane: a decision with
rationale worth not re-litigating lives in a file, not only in a closed issue.
The quote is byte-identical to the harvest record; the decision paragraph is the
harvest's distilled rule text, unedited.
