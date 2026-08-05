# Context pack owns prompt-ready bundles

**Scope key:** `architecture.context_pack_owns_prompt_ready_bundles`
**Source:** https://github.com/rodaddy/open-brain/issues/271
**Recorded:** 2026-08-03 (harvest #522, operator-routed)
**Status:** settled. Recorded from the source issue/PR; verify against current code before relying on an implementation detail.

---

## The decision

`agent_context_pack` is the single owning boundary for prompt-ready memory bundles and hot memory, delivered as a client-pulled exact-scope working_set/recovery path — do not add a competing injection path. gbrain-style MCP `_meta.brain_hot_memory` response injection is permanently rejected (unbounded privacy blast radius, bypasses the single-point exact-scope check, inverts fail-open, undiscoverable through `get_contract`). Context injection must fail open: an ordinary tool call never fails because context assembly failed. Prove retrieval quality with an eval before adding prompt-placement behavior. Contract tests in `src/tools/__tests__/get-contract.test.ts` tripwire any re-introduction.

## Verbatim, from the source

> Open Brain has a planned `agent_context_pack` contract ... should remain the owning boundary for prompt-ready memory bundles. ... Fail-open behavior is defined; ordinary tool calls should not fail because context injection failed. ... Runs after the graph retrieval/eval pair, because retrieval quality should be proven before adding prompt-placement behavior. ... gbrain-style MCP `_meta.brain_hot_memory` response injection is **rejected permanently** (privacy blast radius, breaks single-point exact-scope enforcement, inverts fail-open, undiscoverable via get_contract).

## Provenance

Harvested in #522 from the issue/PR text cited above, reviewed by the operator on
2026-08-03, and routed here rather than into a guidance lane: a decision with
rationale worth not re-litigating lives in a file, not only in a closed issue.
The quote is byte-identical to the harvest record; the decision paragraph is the
harvest's distilled rule text, unedited.
