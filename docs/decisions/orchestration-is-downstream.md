# Orchestration is downstream of Open Brain

**Scope key:** `openbrain.scope.orchestration_is_downstream`
**Source:** https://github.com/rodaddy/open-brain/issues/452
**Recorded:** 2026-08-03 (harvest #522, operator-routed)
**Status:** settled. Recorded from the source issue/PR; verify against current code before relying on an implementation detail.

---

## The decision

Open Brain's scope boundary is pack storage, pack authoring, vacuum lifecycle, and vectorized serving. MAE and the Pi multi-agent orchestration engine are downstream CONSUMERS, explicitly outside Open Brain; do not build orchestration into this repo. Multi-agent orchestration returns as its own effort in the ai-agents repo.

## Verbatim, from the source

> **MAE / the Pi orchestration engine is not part of Open Brain.** Open Brain’s side of the boundary is: pack storage, pack authoring, vacuum lifecycle, vectorized serving. Orchestration engines are downstream consumers.

## Provenance

Harvested in #522 from the issue/PR text cited above, reviewed by the operator on
2026-08-03, and routed here rather than into a guidance lane: a decision with
rationale worth not re-litigating lives in a file, not only in a closed issue.
The quote is byte-identical to the harvest record; the decision paragraph is the
harvest's distilled rule text, unedited.
