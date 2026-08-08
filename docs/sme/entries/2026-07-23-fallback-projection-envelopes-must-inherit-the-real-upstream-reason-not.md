---
lane: correctness
order: 40
---
## [2026-07-23] Fallback/projection envelopes must inherit the real upstream reason, not fabricate a complete empty

**Severity:** MEDIUM
**Source:** PR #361 review swarm, 2026-07-23 (issue #334 cited reflex pointers)
**Scope:** `src/tools/agent-reflex-pointers.ts` and any thin wrapper/projection
that re-derives a section envelope from an upstream context-pack section
**Status:** fixed-pre-merge

### Pattern

The new `agent_reflex_pointers` tool projects a subset of the shared
`agent_context_pack` build. On the degraded/empty path it built its own envelope
with `truncated: false` and a locally-invented empty reason, discarding the
upstream section's actual `truncated` flag and `empty_reason`. So a reflex
response reported a clean complete read while the upstream `durable_memory` /
pointers section had truncated its ranked tail or was empty for a specific
content-free cause. A projection layer that fabricates its own "everything is
here" envelope is the same lie as a fallback that maps any success to
"complete" — the truncation/empty truth lives upstream and must be carried
through, not regenerated. The fix inherits the upstream section's `truncated`,
`empty_reason`, and counts verbatim into the projected envelope, only narrowing
the item/citation set, and reconciles the projected `truncated`/`empty_reason`
if the projection itself drops rows.

This is the projection-layer sibling of the whole-pack reconciliation entries
([2026-07-22] whole-pack-trimming-must-reconcile-section-truth and
[2026-07-22] empty-envelope-empty_reason-must-reconcile-with-the-counters):
those fix the fitter/loader; this one fixes a thin tool built ON TOP of an
already-reconciled section, which must not overwrite that reconciled truth with
a default.

### Review Questions

- Does a wrapper/projection over an upstream section synthesize its own
  `truncated`/`empty_reason`/counts, or inherit the upstream values? A synthesized
  default (`truncated: false`, generic empty reason) hides a real upstream
  truncation or content-free empty.
- If the projection itself drops items (narrows to a subset), does it re-stamp
  `truncated: true` on top of the inherited state rather than replacing it?
- Is there a regression proving a projected envelope reports the SAME
  `empty_reason` the upstream section produced (e.g. `content_unavailable`,
  `all_suppressed`, `whole_pack_budget`), and that an upstream-truncated section
  stays truncated in the projection — failing on the pre-fix fabricated-empty
  code?
