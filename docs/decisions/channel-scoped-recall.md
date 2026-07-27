# Channel-scoped default recall, explicit cross-channel lookup

**What this is:** the retrieval-*policy* default for agent recall. Not a schema
— [`../agent-memory-adapter-contract.md`](../agent-memory-adapter-contract.md)
already carries `channel_id`/`thread_id` as scope *fields*. This file states
what the default scope **is**, and what crossing it requires.

**Source issue:** #130 — "Implement channel-scoped default recall with explicit
cross-channel lookup"
**Decided / closed:** 2026-06-18
**Status:** implemented. Open Brain PR #136 shipped contract v2 with
`lane_upsert` / `lane_load`; rtech-hermes PR #70 made default recall use
`lane_load` with no default broad `search_all`, and exposed explicit
cross-channel lookup through `openbrain_lookup`.

---

## Why this needs writing down

This is exactly the kind of default an agent re-derives *wrongly*, because the
wrong answer sounds better: "recall everything, more context is better." The
policy is the opposite, and it had zero footprint in the tree — neither
`cross-channel` nor the `known.` / `work.` lane naming appears anywhere.

## The problem

> Hermes agents need OpenBrain recall based on the active channel/thread by
> default, but they should still be able to search memories from other channels
> when the user asks or the task clearly requires it.

## The policy

> - default prefetch is scoped to active session/thread/channel
> - explicit lookup can cross channels and must be source-labeled
> - writes remain governed by lane/channel policy

## Requirements (verbatim)

> - Define channel lane conventions such as active session, thread lane,
>   `known.<channel>`, and `work.<channel>`.
> - Default auto-injected recall should include only active/thread/parent-channel
>   memory.
> - Cross-channel recall must require explicit user request or deliberate
>   bounded agent lookup.
> - Cross-channel results should cite/source the channel/lane they came from.
> - Tests must prove channel A default recall does not leak channel B.
> - Tests must prove explicit cross-channel lookup can retrieve requested
>   out-of-channel memories.

## The three rules that matter

1. **Default is scoped, not global.** Auto-injected recall sees the active
   session, its thread, and the parent channel — nothing else. There is no
   default broad `search_all`.
2. **Crossing requires intent.** Either an explicit user request, or a
   deliberate bounded agent lookup. "The task might benefit" is not a trigger.
3. **Cross-channel results are labeled.** A result from outside the current
   channel must cite the channel/lane it came from. Unlabeled cross-channel
   content is indistinguishable from in-channel context, which is how a leak
   becomes invisible.

The enforceable test is the leak direction: **channel A default recall must not
surface channel B.**

## Lane naming conventions

The issue names `known.<channel>` and `work.<channel>` alongside "active
session" and "thread lane".

**Ambiguity, recorded:** #130 introduces these as examples ("such as") and does
not define what distinguishes a `known.` lane from a `work.` lane, nor the full
lane grammar. Written here because the names exist nowhere else in the tree,
not because the taxonomy is settled.

## Acceptance criteria (verbatim)

> - OB/Hermes docs describe default-scoped vs explicit lookup behavior.
> - Hermes provider prefetch follows the default scoped policy.
> - Explicit cross-channel lookup path is available and source-labeled.

## Related

- [`../agent-memory-adapter-contract.md`](../agent-memory-adapter-contract.md) —
  the scope fields this policy applies to.
- [`../identity-boundary.md`](../identity-boundary.md) — namespace boundary,
  the coarser sibling of the channel boundary.
