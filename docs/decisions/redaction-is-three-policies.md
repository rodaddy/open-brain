# Redaction is three policies, not one

**Scope key:** `decision.redaction_is_three_policies_not_one`
**Source:** rodaddy/open-brain#77 (issue body)
**Recorded:** 2026-08-03 (harvest #522, operator-routed)
**Status:** settled, with a superseded half recorded below — see the rule text.

---

## The decision

Redaction policy is three separate policies and must not be collapsed into one: live writes send the caller's ORIGINAL payload (redacting them silently corrupts legitimate memory content that merely matches a secret pattern), and logs/errors are redacted. SUPERSEDED HALF: the spool originally stored raw payloads for faithful replay; issue #304 / PR #305 changed `spool.py::_record_line` to `redact_value(...)` before persist, so the spool now stores the redacted form and replays it. Pre-#305 spool files on disk still contain raw payloads.

## Verbatim, from the source

> This conflates three separate policies: live storage, diagnostics/log safety, and offline replay durability. ... Live Open Brain writes use the original caller payload unless an explicit configured write policy says otherwise.

## Provenance

Harvested in #522 from the issue/PR text cited above, reviewed by the operator on
2026-08-03, and routed here rather than into a guidance lane: a decision with
rationale worth not re-litigating lives in a file, not only in a closed issue.
The quote is byte-identical to the harvest record; the decision paragraph is the
harvest's distilled rule text, unedited.
