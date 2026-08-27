---
lane: correctness
order: 87
---
## [2026-08-08] Stub the boundary; do not extract a helper for observability

**Severity:** HIGH
**Source:** #666 transport-delegation lane, Tightenings round 22
**Scope:** `scripts/done-means/*.sh` where the defect is "what does X pass across a boundary"; `src/transport.ts`, provider spawn paths
**Status:** active

### Pattern

When the defect is "what does X pass to the boundary," extracting a helper (`buildProviderEnv()`) to make the value observable invents a SEAM, and the check then proves the seam instead of the real call site. That is the same gap class that let #655's stubbed green miss #666 entirely.

Monkeypatch the BOUNDARY instead. The existing repo convention is `Bun.spawn` monkeypatching (`src/tools/__tests__/search-all.test.ts:85`): the SHIPPED method runs unmodified while the check reads what the real spawn actually received.

### What to do

- Stub at the boundary the code already crosses; do not create a new one for the check's convenience.
- **A single-key presence assertion most needs a mutant, and an ENV-level mutant beats a source-level one.** Stripping the key from the OBSERVED env keeps RED regenerable forever with the fix in place — round 16's SKIP-flag idea in its env spelling.
- Report what the mutant proves honestly: the clause reads that key and fails on its absence. Not more.

### Corollary: an empty search result is neither permission nor a defect

The design-lookup gate's window EXPIRES mid-lane by plain time decay — distinct from round 20's sibling-contention shape. Long lanes get gated twice on unrelated writes.

When a legitimate lookup returns nothing, declare UNVERIFIED and source the convention elsewhere (`git log` is the standing fallback). And distinguish the two empties: fast-and-explicit "No results found" is a genuine miss, while empty output after a 120s+ hang is DID-NOT-RUN. Treating the second as the first is how a lane records a lookup it never performed.
