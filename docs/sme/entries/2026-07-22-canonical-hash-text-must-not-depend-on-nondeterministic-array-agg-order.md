---
lane: correctness
order: 34
---
## [2026-07-22] Canonical hash text must not depend on nondeterministic array_agg order

**Severity:** P2
**Source:** PR #356 / issue #345 terminal audit, 2026-07-22
**Scope:** `src/embedding-canonical.ts` `decisionCanonicalText`; the decision
writers `src/tools/log-decision.ts`, `src/rest-api.ts` (`POST /decisions`),
`src/tools/update-entry.ts`; the repair registry `src/embedding-targets.ts`
(decisions `sourceHash`)
**Status:** fixed

### Pattern

Decisions embed and hash the SAME canonical string, built by
`decisionCanonicalText`. `content_hash` is baked at INSERT from that string. Both
INSERT writers dedupe on `ON CONFLICT (content_hash, namespace)` and, on
conflict, MERGE tags via
`array_agg(DISTINCT tag) FROM unnest(decisions.tags || EXCLUDED.tags)` —
**without recomputing `content_hash`**. Postgres does not guarantee
`array_agg`'s order. The canonical text folded tags in raw array order, so a
post-conflict row (with its arbitrarily reordered merged tag set) recomputed a
DIFFERENT source hash than the stored one. The embedding-repair registry then
flagged the row as false `source_drift`, regenerated a different vector, and
rewrote the `content_hash` dedup key on **every** repair pass — perpetual churn
on rows nobody edited. `update_entry`, which recomputes the hash from the merged
row, had the same exposure from any tag reordering.

### Rule

Any text fed to a stored content hash must be a deterministic function of the
row's semantic content, invariant under representations the storage layer may
reorder (`array_agg`, `jsonb_agg`, set-returning joins, unordered `text[]`). Fix
it at the ONE shared canonicalizer both the writer and the repair/recompute path
call — normalize (dedupe + sort) there, without mutating the caller's input, so
the INSERT hash, the post-conflict merged-row recompute, and every other writer
converge on one string. The fix sorts only `tags` (the merged column);
`alternatives` keeps caller order because its merge does not reorder it. A merge
can only fire when the canonical text (and thus the normalized tag set) is
already identical, so the `array_agg` union only re-adds duplicates of an
existing set — it never introduces a genuinely new tag that should change the
hash.

### Review Questions

- Does any column that feeds a stored hash get merged/aggregated by SQL
  (`array_agg`, `jsonb_agg`, `||` on arrays) in a way the hash is NOT recomputed
  from? If so, is the hash input order-invariant for that column?
- Is the normalization at the single shared builder both the writer and the
  repair registry call, so the two can never diverge?
- Does normalization dedupe AND sort, and does it avoid mutating the caller's
  input array (a fresh array, not an in-place `.sort()`)?
- Are there regression tests for reversed and duplicated tag inputs, AND a live
  `ON CONFLICT` merge test proving the merged row is not flagged `source_drift`
  and its `content_hash` is preserved? Both must fail on the pre-fix code.
- Were parallel expectations updated (e.g. `embedding-targets.test.ts`) — a
  reference asserting the old raw-order fold is itself a latent regression.
