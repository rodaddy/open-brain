# Canon stays small and canon-only

**Scope key:** `repo.open_brain.canon_small_and_canon_only`
**Source:** issue #438 (CANON-1) and #439 (CANON-2)
**Recorded:** 2026-08-03 (harvest #522, operator-routed)
**Status:** settled. Recorded from the source issue/PR; verify against current code before relying on an implementation detail.

---

## The decision

Canon (profile_guidance, process_guidance, repo_facts) is the always-loaded layer and must stay small and absolute — the rule, not the procedure, with full procedures served on demand by the index. It requires operator approval because these are Rico's rules, not derived facts. The SessionStart loader reads from Open Brain with no hardcoded host, using `$OPENBRAIN_BASE_URL`. NOTE: the canon-only rule was later amended by #519 — repo-scoped lane resume now auto-loads; cross-lane history stays explicit-on-request.

## Verbatim, from the source

> Canon must stay small. Front-of-mind works because it is bounded, not because retrieval is fast. Content requires operator approval — these are Rico's rules, not derived facts. [...] Load canon **only**. Episodic lane context is explicit-on-request by design — auto-loading it contaminates unrelated work and forecloses a deliberate fresh start.

## Provenance

Harvested in #522 from the issue/PR text cited above, reviewed by the operator on
2026-08-03, and routed here rather than into a guidance lane: a decision with
rationale worth not re-litigating lives in a file, not only in a closed issue.
The quote is byte-identical to the harvest record; the decision paragraph is the
harvest's distilled rule text, unedited.
