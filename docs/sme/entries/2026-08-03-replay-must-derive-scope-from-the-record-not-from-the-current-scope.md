---
lane: security
order: 40
section: harvest-522
---
## [2026-08-03] Replay must derive scope from the record, not from the current scope

**Severity:** not stated in source
**Source:** issue #310; harvested in #522
**Scope key:** `review.replay_must_be_scope_aware_not_current_scope`
**Status:** active

### Pattern

When a strict scope/tenant proof gates dispatch, any replay or drain loop must derive each record's scope from the record's own persisted payload -- or filter to scope-matching units without dispatching the rest. Replaying every parked unit through the *current* runtime scope makes cross-scope records undeliverable indefinitely and burns a wasted live round trip per unit per drain, with the failure swallowed as a warning.

Verbatim, from the source:

> A unit parked under project A ... therefore fails dispatch with `session_start result did not prove exact Open Brain scope` when the drain is triggered by a healthy operation in project B ... Units can sit undelivered indefinitely if the client rarely operates in that project again. Every drain attempt re-dispatches mismatched units, issuing a wasted live `session_start` per unit per healthy operation, plus a swallowed warning.
