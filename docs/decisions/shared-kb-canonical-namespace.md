# Canonical `shared-kb` with hidden legacy `collab` fallback

**What this is:** the Fallback Policy v1 algorithm and the count-vs-score
decision behind [`src/shared-namespace.ts`](../../src/shared-namespace.ts).
The current *state* of the fallback (retired, off by default) is documented in
[`../identity-boundary.md`](../identity-boundary.md); this file carries the
*algorithm and the reasoning*, which is what a future cross-namespace merge
will need.

**Source issues:** #144 and #154 (same title, same design; #144 states the
final design, #154 is the Phase 1 implementation scope)
**Decided / closed:** #144 closed 2026-06-18, #154 closed 2026-06-19
**Status:** implemented, then retired. `shared-kb` is canonical; there is **no
default legacy read fallback** — an operator can re-enable it transiently via
`SHARED_NAMESPACE_LEGACY` + `OPENBRAIN_LEGACY_SHARED_FALLBACK=1`. See
[`../collab-retirement-preflight.md`](../collab-retirement-preflight.md).

---

## The decision

> Make `shared-kb` the canonical client-facing Open Brain shared-memory
> namespace while keeping legacy `collab` hidden server-side during the
> transition.

Final design, verbatim from #144:

> - Physical `shared-kb` exists now.
> - Clients, users, agents, skills, and generated docs only speak `shared-kb`.
> - New shared writes go only to physical `shared-kb`.
> - Legacy `collab` is server-internal backing only.
> - Server may read legacy `collab` when a `shared-kb` read has weak or
>   insufficient results.
> - Returned results display canonical namespace `shared-kb`; raw/internal/debug
>   views may expose physical namespace.
> - Normal external writes to `collab` are rejected, not silently mapped.
> - Fallback is temporary and has an explicit removal gate.

## Fallback Policy v1 — the algorithm

> Use count-based fallback first; do not rely on fuzzy score thresholds until
> scores are consistent across search modes.
>
> 1. Query physical `shared-kb`.
> 2. If result count is at least requested `limit` or
>    `OPENBRAIN_SHARED_FALLBACK_MIN_RESULTS`, return `shared-kb` only.
> 3. Otherwise query legacy `collab` for remaining result capacity.
> 4. Merge and dedupe by id/content hash/provenance where available.
> 5. Prefer physical `shared-kb` rows over legacy `collab` on ties.
> 6. Return canonical namespace as `shared-kb`.

### Why count, not score — the reusable insight

The first sentence of the policy is the whole reason: **scores are not
comparable across search modes.** A vector-similarity score, an FTS rank, and
an RRF-fused score do not share a scale, so a "weak results" threshold
expressed as a score means something different depending on which search mode
ran. Result *count* against the requested `limit` is mode-independent.

Any future cross-namespace or cross-source merge faces the same choice. Reach
for a count/capacity trigger before a score threshold unless the scores have
been made comparable first.

## Configuration

From #144:

> - `OPENBRAIN_SHARED_NAMESPACE=shared-kb`
> - `OPENBRAIN_LEGACY_SHARED_NAMESPACE=collab`
> - `OPENBRAIN_LEGACY_SHARED_FALLBACK=true`
> - `OPENBRAIN_SHARED_FALLBACK_MIN_RESULTS=5`
> - `OPENBRAIN_ALLOW_LEGACY_SHARED_WRITES=false`

From #154 (Phase 1 naming):

> - `SHARED_NAMESPACE_CANONICAL=shared-kb`
> - `SHARED_NAMESPACE_PHYSICAL=shared-kb`
> - `SHARED_NAMESPACE_LEGACY=collab`

**Ambiguity, recorded:** the two issues name the config keys differently and
neither reconciles them. The shipped code uses `OPENBRAIN_LEGACY_SHARED_FALLBACK`
and `OPENBRAIN_SHARED_FALLBACK_MIN_RESULTS` (with a default min of 5), and
`SHARED_NAMESPACE_LEGACY` for the legacy namespace name.

**Superseded:** `OPENBRAIN_LEGACY_SHARED_FALLBACK=true` was the transition
default. It is now off by default — the removal gate the design called for was
exercised.

## Reject legacy writes, never silently map them

> Normal external writes to `collab` are rejected, not silently mapped.

The reason is in the traps list: a silent write remap creates split-brain
shared truth. A rejection is loud and fixable; a remap is invisible and
produces two divergent copies of the same "shared" fact.

## Traps to avoid (verbatim)

> - Do not let clients or agents know to query both `shared-kb` and `collab`.
> - Do not silently map writes to `collab`; reject normal legacy writes.
> - Do not create split-brain shared truth with independent client routing.
> - Do not call `/mnt/collab` just `collab` in docs; use `fs collab` for
>   filesystem references.

### The `fs collab` vocabulary split

`collab` (bare) means the legacy Open Brain *namespace*. `fs collab` means the
`/mnt/collab` (or `/Volumes/collab`) *filesystem share*. They are unrelated and
the collision has caused confusion. Use `fs collab` whenever the filesystem is
meant. Renaming the mount was an explicit non-goal.

## Non-goals (verbatim, #144)

> - No blind physical migration.
> - No client-side dual reads.
> - No permanent fallback.
> - No `/mnt/collab` filesystem rename.
> - No promoter implementation in this issue.

#154 adds:

> - Do not let every agent write shared truth directly.
> - Do not use dream output as unreviewed truth promotion.
> - Do not claim lane/project/channel routing is complete just because columns
>   exist.

## Phase 2 promoter requirements (from #154)

The follow-up promoter was specified with these properties:

> dry-run first; resumable/idempotent; low-load/back-burner execution; kill
> switch; batch transforms old `collab` thoughts into correct `shared-kb`
> formats; dedupes before writing; preserves provenance and audit receipts; has
> explicit fallback retirement gate after coverage/smoke tests pass.

The promoter identity itself is documented in
[`admin-and-promoter-identities.md`](./admin-and-promoter-identities.md).

## Related

- [`../identity-boundary.md`](../identity-boundary.md) — current namespace and
  write-authority rules.
- [`../collab-retirement-preflight.md`](../collab-retirement-preflight.md) —
  the retirement execution.
