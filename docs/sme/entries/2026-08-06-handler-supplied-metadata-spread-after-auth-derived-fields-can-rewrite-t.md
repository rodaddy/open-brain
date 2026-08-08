---
lane: security
order: 42
section: harvest-522
---
## [2026-08-06] Handler-supplied metadata spread after auth-derived fields can rewrite trace identity

**Severity:** MEDIUM
**Source:** PR #599 review swarm, finding M1 (found independently by the security AND adversarial lanes)
**Scope key:** `review.auth_derived_fields_win_merge_order`
**Status:** active

### Pattern

In any record that mixes server-derived authority fields (caller_role, caller_client_id, namespace_source, status) with handler- or caller-supplied maps, the spread/merge ORDER is a security control: `{...authFields, ...suppliedMap}` lets the supplied map silently displace the identity and outcome evidence — making a failed call read as success or a trace disagree with the audit log exactly where a review needs them to agree. Safe shape is supplied-first, authority-last, plus a regression that stamps a forged `caller_role`/`status` from inside a handler that then throws and asserts the emitted record keeps the token-derived values. "No current call site collides" is not a defense; the exported API is the surface.
