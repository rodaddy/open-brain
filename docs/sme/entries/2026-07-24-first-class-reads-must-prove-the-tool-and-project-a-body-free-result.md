---
lane: gotcha-agent
order: 17
---
## [2026-07-24] First-class reads must prove the tool and project a body-free result

**Severity:** HIGH
**Source:** PR #374 review (issue #371 runtime reflex operation)
**Scope:** `python/openbrain-memory` first-class read routing, contract gating,
response validation, and read receipts
**Status:** fixed-pre-merge

A read can be direct-only and exact-scope while still leaking or drifting. The
first reflex runtime gated on the live v23 manifest but omitted
`agent_reflex_pointers` from the first-class required-tool/version set, so a
manifest without the tool still passed. It then validated only schema + scope
and returned the untrusted server mapping unchanged, allowing body-bearing or
incomplete pointer envelopes through. Its failure receipt also reused generic
redacted exception text, which preserves private non-secret-shaped messages.

### Review Questions

- Does the live pre-call contract gate require the exact read tool and semantic
  version, not only sibling lifecycle tools?
- Does the runtime rebuild a new response from explicit body-free fields and
  validate pointer/citation counts, structural refs, and bijection, rather than
  returning the server mapping after a shallow scope check?
- Are pointer ids, source types, namespaces, structural source refs, and citations
  identity-bound to each other, while still accepting server-authorized readable
  namespaces such as `shared-kb` instead of incorrectly forcing every pointer to
  the envelope scope namespace?
- Can arbitrary text survive in known query, scope-source, pointer-namespace,
  tier, empty-reason, warning, or budget fields, or are values omitted or
  restricted to published
  content-free enums, token shapes, and numeric bounds?
- Are bounded arrays such as whole-pack allocation order capped, unique, and
  equal to the published order rather than accepting duplicate amplification?
- Are malformed server envelopes classified as result-invalid while real
  transport/dispatch failures retain the distinct dispatch-failed category?
- Does a failed read receipt use a stable category derived from failure type,
  never exception text, response bodies, paths, identities, or query content?
- Do regressions remove the tool/version, inject bodies and private text into
  both unknown and known fields, break citation invariants, and prove the full
  serialized output contains none of the sentinels?
