---
lane: correctness
order: 55
section: harvest-522
---
## [2026-08-03] The SQL visibility gate and the return-payload filter must enforce the same invariant

**Severity:** not stated in source
**Source:** https://github.com/rodaddy/open-brain/issues/255; harvested in #522
**Scope key:** `sme.sql_gate_and_return_filter_must_agree`
**Status:** active

### Pattern

When a SQL predicate gates row visibility and a separate application-layer schema filters the returned payload, the two must enforce the SAME invariant. If the schema is stricter than the SQL gate, a malformed row passes the gate and leaks its existence and content while returning an empty payload. Review visibility gates and return-path filters as a pair and assert they agree on every invariant, not just the primary one.

Verbatim, from the source:

> Scope `{client_id:"acme"}` → SQL `EXISTS` matches (it only checks the 5 scope keys via `->>`, never requires a doc id) so `get_entry` returns the row; but `filterSourceRefsForScope`→`sourceRefsSchema` rejects that element, so returned `source_refs` is `[]`. The row's *existence and content* leak under a scope that its refs don't legitimately satisfy per the ref contract.
