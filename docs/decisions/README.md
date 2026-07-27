# Design decisions

## Why this directory exists

**Design content must not live only in GitHub issues.** The working tree cannot
see an issue body. Neither can `.qmd`, `rg`, or any agent doing a repo search
before it starts work. When a decision lives only in a closed issue, the next
agent does not find it, concludes it was never decided, and re-derives it —
usually differently.

Open Brain has already named this the single most repeated agent failure across
sessions: *"DIDNT WE ALREADY DESIGN THAT"* — roughly 15 occurrences. It is an
**agent retrieval failure, not a memory-system failure.** The trigger for this
directory was the R3 promotion authority model being re-derived from scratch
because it lived only in a doc that had been merged then reverted, plus in
issue bodies.

Two rules follow:

1. If a decision has rationale worth not re-litigating, it goes in a file here.
   An issue may still be where it was *made*; it is not where it *lives*.
2. Absence from the working tree is not proof of absence. Content can live on
   another branch or in a reverted commit — check
   `git log --all --oneline -- <path>` before concluding a design was never
   written.

Each file records the **decision** and its **rationale**, quotes load-bearing
wording verbatim, and names anything that later superseded it rather than
silently dropping it.

## Index

| File | Source issues | Summary |
|------|---------------|---------|
| [privilege-isolation-closed-brain.md](./privilege-isolation-closed-brain.md) | #118 | The law-client "Privilege Isolation" product model behind `src/source-refs.ts` — structured source refs, client/matter/ethical-wall isolation metadata, and matter-scoped retrieval that must **fail closed** when scope is missing. |
| [cognitive-tiering-dream-cycle.md](./cognitive-tiering-dream-cycle.md) | #12 | Tier-column-not-tables and access-log-not-counter rationale, plus the designed-but-unbuilt phases (consolidation, prune, 90-day discard expiry) that explain the orphan columns in migration 006. |
| [contract-is-the-agent-surface.md](./contract-is-the-agent-surface.md) | #172, #176 | `get_contract` is a contract-driven agent's *entire* knowledge, so help not in the contract is unreachable — and the non-leaking `share_candidate` rejection contract (label never value, bounded resubmission) that depends on it. |
| [shared-kb-canonical-namespace.md](./shared-kb-canonical-namespace.md) | #144, #154 | Fallback Policy v1 as an ordered merge/dedupe/tie-break algorithm, and why fallback triggers on **result count** rather than score thresholds (scores are not comparable across search modes). |
| [channel-scoped-recall.md](./channel-scoped-recall.md) | #130 | Default auto-injected recall is scoped to the active session/thread/parent channel; crossing channels requires explicit intent and the result must be source-labeled with its lane. |
| [qmd-derived-facts.md](./qmd-derived-facts.md) | #132 | qmd is GPU-only, so OB is the required distribution layer for repo knowledge — carrying curated facts with source pointers, explicitly **not** mirroring raw code chunks. Includes the `fact_type` metadata convention. |
| [admin-and-promoter-identities.md](./admin-and-promoter-identities.md) | #168 (rel. #159, #147) | Why `promoter` (least-privilege, lane→shared-kb) and `ob-admin` (human break-glass) are separate, and exactly which privileges `promoter` is denied. |
| [transcript-refs-and-citation-recall.md](./transcript-refs-and-citation-recall.md) | #288 | Transcript refs must be host-neutral (`collab/...`, never `/Volumes/` or `/mnt/`), and citation recall must report `source_not_stored` rather than invent a source. |
| [fleet-bus-c6-envelope-vs-body.md](./fleet-bus-c6-envelope-vs-body.md) | #291 | Coordination rides the typed envelope (`typed_signal`); `payload` is opaque and control-looking body text is inert. Never scrape payload or reply text for completion/stance/routing. |

## Also recoverable from git, not rewritten here

Two design docs were merged and then reverted. They are intact in history and
should be restored from git rather than reconstructed:

| Doc | Lines | Restore with | Notes |
|-----|-------|--------------|-------|
| `docs/code-brain-design.md` | 437 | `git show a659c4a:docs/code-brain-design.md` | merged as `75a85a5`, reverted by `39e591e` / `19f9b86` |
| `docs/full-send-derivation-spec.md` | 280 | `git show 3f72bee:docs/full-send-derivation-spec.md` | merged as `3f72bee`, reverted by `2e185d1` / `19f9b86`; referenced by closed issue #380 |

## Where other settled design already lives

Not everything belongs here — much of the design corpus is already in the tree.
Notably: [`../dream-ethereal-runs.md`](../dream-ethereal-runs.md) (the R3
promotion authority model),
[`../agent-context-pack-contract.md`](../agent-context-pack-contract.md),
[`../memory-contract.md`](../memory-contract.md),
[`../identity-boundary.md`](../identity-boundary.md),
[`../agent-memory-adapter-contract.md`](../agent-memory-adapter-contract.md),
and [`../sme/`](../sme/) for review-lane knowledge.
