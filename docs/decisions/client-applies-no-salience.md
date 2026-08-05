# The client applies no salience

**Scope key:** `repo.open_brain.client_applies_no_salience`
**Source:** issue #380 (INGEST-1)
**Recorded:** 2026-08-03 (harvest #522, operator-routed)
**Status:** settled. Recorded from the source issue/PR; verify against current code before relying on an implementation detail.

---

## The decision

Full-send ingest is a hard non-goal boundary: the client applies no salience judgment — no summarizing, scoring, or skipping — it ships what happened, and all derivation is server-side. This exists because hand-picked capture produced 3 session events in a full working day while 445 tool calls were recorded content-free. The ingest call must never block or error the interactive turn; failures spool locally and replay.

## Verbatim, from the source

> The client applies **no** salience judgment: no summarizing, scoring, or skipping. It ships what happened.

## Provenance

Harvested in #522 from the issue/PR text cited above, reviewed by the operator on
2026-08-03, and routed here rather than into a guidance lane: a decision with
rationale worth not re-litigating lives in a file, not only in a closed issue.
The quote is byte-identical to the harvest record; the decision paragraph is the
harvest's distilled rule text, unedited.
