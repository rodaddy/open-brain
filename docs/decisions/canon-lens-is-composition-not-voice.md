# A lens is composition, not voice

**Scope key:** `canon.lens_is_composition_not_voice`
**Source:** https://github.com/rodaddy/open-brain/issues/452
**Recorded:** 2026-08-03 (harvest #522, operator-routed)
**Status:** settled. Recorded from the source issue/PR; verify against current code before relying on an implementation detail.

---

## The decision

A lens is a system-prompt composition unit that changes how an agent acts; a voice only overrides tone. On Claude/Codex the frontal-lobe layer (canon + lens + voice) is additive because the harness owns the base prompt; on Pi composition can be total (system prompt = soul + lens + voice). Soul is canon: always injected, and no lens may override it. Composition is dynamic at spawn -- packs are ingredients and the head agent writes each worker's complete prompt.

## Verbatim, from the source

> A **lens is a system-prompt composition unit**, not a voice variant. ... **Voice** (Bob / Skippy / Bilby / Nagatha) overrides tone only. ... Soul is canon: it is always injected and no lens may override it.

## Provenance

Harvested in #522 from the issue/PR text cited above, reviewed by the operator on
2026-08-03, and routed here rather than into a guidance lane: a decision with
rationale worth not re-litigating lives in a file, not only in a closed issue.
The quote is byte-identical to the harvest record; the decision paragraph is the
harvest's distilled rule text, unedited.
