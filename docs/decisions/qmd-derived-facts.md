# qmd-derived context facts: why OB curates instead of mirroring

**What this is:** the hardware constraint that decided the qmd/OB architecture,
the explicit rejection of raw-chunk mirroring, and the fact metadata
convention. [`../qmd-ob-layered-recall.md`](../qmd-ob-layered-recall.md) covers
layered recall; it does not carry the `fact_type` taxonomy or the anti-mirroring
rationale.

**Source issue:** #132 — "Define qmd-derived context fact ingestion for Open
Brain"
**Decided / closed:** 2026-06-18 (PR #135, merge `2c8fea3`)
**Status:** implemented as the promotion slice —
[`scripts/promote-qmd-repo-facts.ts`](../../scripts/promote-qmd-repo-facts.ts),
[`src/tools/repo-facts.ts`](../../src/tools/repo-facts.ts). GPU-less Bilby
canary retrieved a `king-core` repo fact and followed the pinned GitHub source
pointer.

---

## The constraint that decides the architecture

> qmd is a GPU-machine tool. The GPU-less LXCs that run Bilby and the cc-*
> agents cannot run qmd embeddings, so they cannot rely on qmd for code/context
> retrieval. Open Brain is the shared memory layer those agents can reach.

Stated as the design's own summary:

> - qmd remains the local/GPU code-context power tool.
> - OB becomes the shared curated fact/context layer for agents that cannot run
>   qmd.
> - Source code remains in GitHub/repos; OB points to it and carries the
>   durable context needed to know what to read and why.

## The rejection: do not mirror raw chunks

This is the rule someone will violate the moment they want better code recall.

> That does **not** mean Open Brain should mirror raw qmd/code chunks. Raw code
> mirrors are high volume, drift immediately, and are worse than reading the
> repo with `gh` or a synced checkout. Open Brain should carry the curated
> qmd-derived context layer: facts, gotchas, ownership notes, and source
> pointers that tell an agent where to verify the live code.

Three reasons, each independently sufficient: **volume**, **immediate drift**,
and **worse than the alternative** (a stale mirror is strictly worse than
reading the actual repo).

### Non-goals (verbatim)

> - Do not bulk-import raw qmd chunks or full code excerpts into OB.
> - Do not make OB a replacement for qmd semantic code search.
> - Do not assume OB embeddings are available for retrieval.
> - Do not store volatile signatures as timeless facts when a pointer to source
>   is safer.

The third is easy to miss: facts must be **keyword retrievable and
graph-walkable without assuming embeddings are available**.

## Facts are a pointer to source, not a replacement for source

Each fact should be:

> - attached to the right OB entity or namespace
> - keyword retrievable and graph-walkable without assuming embeddings are
>   available
> - stamped with source provenance and drift metadata
> - explicit about whether it is stable guidance or a volatile implementation
>   detail
> - usable by GPU-less LXC agents as a pointer to the real source, not as a
>   replacement for source

## Metadata convention

> - `source_system`: `qmd`
> - `repo`
> - `collection`
> - `path`
> - `symbol` or `subject`
> - `fact_type`: e.g. `ownership`, `gotcha`, `api_contract`, `workflow`,
>   `dependency`, `migration`
> - `source_commit`
> - `source_url`
> - `verified_at`
> - `confidence`
> - `staleness_policy`
> - `refresh_hint`

**Ambiguity, recorded:** the issue writes "Suggested metadata fields" and marks
`fact_type` with `e.g.`, so the taxonomy is a starting set rather than a closed
enum in the design. Check the shipped schema in `src/tools/repo-facts.ts` for
what is actually enforced.

`source_commit` + `verified_at` are the drift-detection pair: they let a reader
tell whether the fact was verified against the code it currently points at.

## Promotion is required, not optional (refinement, 2026-06-18)

The follow-up discussion sharpened the rule:

> for anything not running on the GPU/local qmd machine, qmd is not an
> available runtime dependency. If distributed agents need a repo fact, that
> fact has to be present in Open Brain or it is effectively unavailable to
> them.
>
> This does not change the no-raw-code-mirror rule. It changes the promotion
> rule:
>
> - qmd remains the code/source-of-knowledge system where it can run.
> - OB is the required distribution layer for any qmd-derived repo knowledge
>   agents need outside that machine.
> - The unit promoted to OB should be curated, durable operating knowledge with
>   source pointers and staleness metadata.
> - Raw code stays in repos/qmd/GitHub unless a specific agent cannot reach
>   source at all.
>
> So the workflow is not optional export. It is: derive/verify from qmd/source,
> then promote required facts to OB so GPU-less/non-local agents can use them.

## Architecture decision: option 3 is the default path

> Default path is option 3: qmd on the local GPU Mac acts as the repo-knowledge
> compiler, and required facts are promoted into Open Brain as the shared
> runtime/distribution layer. Agents should not need qmd online to operate from
> required repo facts.
>
> Option 1 is still useful as a controlled wrapper/escape hatch: expose this
> machine qmd through mcp2cli or a small remote wrapper for operator/debug/deep
> lookup flows. That wrapper should not replace OB promotion for facts agents
> are expected to rely on. It should be treated as best-effort remote source
> lookup, with clear failure behavior and no assumption that every agent can or
> should call it during normal memory flow.
>
> Implementation implication:
>
> - Build OB promotion as the durable path.
> - Optionally add a qmd-remote wrapper/tool later for live deep lookup against
>   the local qmd index.
> - Do not make remote qmd availability a prerequisite for Hermes/Bilby/cc
>   memory correctness.

The escape hatch became
[`../roadmap/optional-qmd-deep-lookup.md`](../roadmap/optional-qmd-deep-lookup.md)
(#137). The word **optional** in that title is this decision.

**Ambiguity, recorded:** "option 1" and "option 3" refer to alternatives
enumerated in a discussion that is not reproduced in the issue body. Only
options 1 and 3 are described here; whatever option 2 was is not recoverable
from the issue.

## Related

- [`../qmd-ob-layered-recall.md`](../qmd-ob-layered-recall.md) — the layered
  recall design.
- [`../roadmap/optional-qmd-deep-lookup.md`](../roadmap/optional-qmd-deep-lookup.md)
- [`../repo-facts/`](../repo-facts/)
