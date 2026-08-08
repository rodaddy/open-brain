---
lane: security
order: 33
section: harvest-522
---
## [2026-08-03] A wildcard namespace value must not erase the scope for a delegated caller

**Severity:** not stated in source
**Source:** rodaddy/open-brain#65 (review swarm comment by rodaddy); harvested in #522
**Scope key:** `sme.security.wildcard_namespace_erases_scope`
**Status:** active

### Pattern

When a namespace-scoping layer has a wildcard value (`all`, `*`), check that a delegated/header-scoped caller cannot pass it to erase the scope: a wildcard that resolves to an undefined filter is an isolation bypass, not a convenience. Delegated requests must stay scoped and the wildcard must only expand for non-delegated privileged callers; also verify the wildcard does not become a literal string predicate (`namespace = 'all'`) for the callers who are allowed it.

Verbatim, from the source:

> `src/read-policy.ts` allowed header-sourced admin/n8n callers to pass `namespace=all`, which made `namespaceFilterFor()` return `undefined` and removed namespace filtering entirely. Impact: a delegated request with `X-Namespace: bilby` could still request all namespaces on supported read paths.
