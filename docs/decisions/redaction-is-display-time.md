# Redaction is display-time, not write-path

**Scope key:** `architecture.redaction_is_display_time_not_write_path`
**Source:** https://github.com/rodaddy/open-brain/issues/232
**Recorded:** 2026-08-03 (harvest #522, operator-routed)
**Status:** settled, with a superseded half recorded below — see the rule text.

---

## The decision

Open Brain's redaction architecture is deliberate and layered: there is NO server-side redaction and the memory contract is "do not store secrets" (the caller is responsible). A review finding that "writes and reads do not route through redaction" is describing the intended design, not a gap. Do not add write-path secret filtering to the client package without re-basing the premise on the current contract. PARTIALLY SUPERSEDED: the local JSONL spool specifically now redacts before persist (issue #304 / PR #305, `spool.py::_record_line`); the no-server-side-redaction and display-time-defense points stand.

## Verbatim, from the source

> The current OB memory contract is "don't store secrets," not "redact on write." ... **`redact_text`/`redacted_payload()` are scoped to DISPLAY-TIME defense-in-depth** ... NOT a write-path secret filter. That's why writes/reads don't route through it (the security lane's "gap" is actually the intended architecture).

## Provenance

Harvested in #522 from the issue/PR text cited above, reviewed by the operator on
2026-08-03, and routed here rather than into a guidance lane: a decision with
rationale worth not re-litigating lives in a file, not only in a closed issue.
The quote is byte-identical to the harvest record; the decision paragraph is the
harvest's distilled rule text, unedited.
