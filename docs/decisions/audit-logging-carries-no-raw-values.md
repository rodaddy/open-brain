# Audit logging carries no raw values

**Scope key:** `architecture.audit_logging_no_raw_values`
**Source:** https://github.com/rodaddy/open-brain/issues/269
**Recorded:** 2026-08-03 (harvest #522, operator-routed)
**Status:** settled. Recorded from the source issue/PR; verify against current code before relying on an implementation detail.

---

## The decision

Privacy-safe MCP/tool audit logging records operation name, status, duration, caller identity/namespace source, declared parameter keys, unknown key COUNT, and a bucketed approximate payload size. It never persists raw parameter values, body text, secret-shaped values, file paths, or attacker-submitted key names; byte counts are bucketed specifically to avoid a size side channel. Retention and disable are configurable.

## Verbatim, from the source

> Store operation name, status, duration, caller identity/namespace source, declared parameter keys, unknown key count, and coarse approximate payload size. Never store raw param values by default. Bucket byte counts to avoid size side channels. Avoid logging unknown attacker-controlled key names. Add retention/disable configuration.

## Provenance

Harvested in #522 from the issue/PR text cited above, reviewed by the operator on
2026-08-03, and routed here rather than into a guidance lane: a decision with
rationale worth not re-litigating lives in a file, not only in a closed issue.
The quote is byte-identical to the harvest record; the decision paragraph is the
harvest's distilled rule text, unedited.
