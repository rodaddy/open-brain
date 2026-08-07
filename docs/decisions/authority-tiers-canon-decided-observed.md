# Authority tiers: canon, decided, observed

**Scope key:** `repo.open_brain.authority_tiers_canon_decided_observed`
**Source:** issue #404 (SHAPE-4: authority)
**Recorded:** 2026-08-03 (harvest #522, operator-routed)
**Status:** settled. Recorded from the source issue/PR; verify against current code before relying on an implementation detail.

---

## The decision

Open Brain's R3 authority tiers are canon (epic/issue/ratified decision doc) > decided (an explicit Rico decision) > observed (what a session did or concluded). Authority flows down epic → issue → PR/commit → session while evidence flows up. Without precedence, drift is working as designed: a plausible session inference gets captured, recalled, reinforced, and beats the plan on every axis recency and repetition can measure. A session finding can never outrank canon; it can only be flagged as contradicting it. When designing who may mint `decided`, bias toward the version an agent cannot get wrong — the watcher has no stake, the writer does.

## Verbatim, from the source

> A session finding can never outrank canon, no matter how recent or how repeated. It can only be **flagged as contradicting** canon — a question for the operator, never an automatic override. [...] Bias should be toward the version an agent **cannot** get wrong, per §3: the watcher has no stake, the writer does.

## Provenance

Harvested in #522 from the issue/PR text cited above, reviewed by the operator on
2026-08-03, and routed here rather than into a guidance lane: a decision with
rationale worth not re-litigating lives in a file, not only in a closed issue.
The quote is byte-identical to the harvest record; the decision paragraph is the
harvest's distilled rule text, unedited.
