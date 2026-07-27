# Cognitive tiering ("OB Dreaming") — schema rationale and the unbuilt phases

**What this is:** the design behind the tier model, and specifically the parts
that were designed but never implemented — consolidation, prune/expiry, and
per-namespace decay thresholds. Migration
[`006_cognitive_tiering.sql`](../../src/db/migrations/006_cognitive_tiering.sql)
created `consolidated_into`, `consolidated_from`, and `discarded_entries`, and
**nothing in `src/` reads them.** This file is why those columns exist.

**Source issue:** #12 — "feat: Cognitive Tiering (OB Dreaming) — automated
memory lifecycle management"
**Decided / closed:** 2026-04-06
**Status:** partially implemented. Tiers, access logging, and tier boost ship
(`src/tiering.ts`, `src/tools/set-tier.ts`, `src/tools/bulk-set-tier.ts`,
`src/tools/tier-recommendations.ts`, `src/tools/access-report.ts`). Phases 4-6
and per-namespace thresholds do not.

Operating usage of the shipped half lives in
[`skill/references/cognitive-tiering.md`](../../skill/references/cognitive-tiering.md).
This file carries the *rationale* and the *undone* parts. See also
[`../dream-ethereal-runs.md`](../dream-ethereal-runs.md), which covers dream
run mechanics and the separate R3 promotion authority model.

---

## Problem being solved

> OB accumulates entries over time with no lifecycle management:
> - Duplicate entries about the same decision from different sessions
> - Stale context that's been superseded but still clutters search results
> - No way to distinguish "critical active knowledge" from "one-off thought
>   from 3 weeks ago"
> - Search quality degrades as noise increases

## Tier model

| Tier | Label | Search Behavior | Criteria |
|------|-------|----------------|----------|
| `hot` | Front of Mind | RRF score boost (+0.3) | 3+ accesses in 7 days |
| `warm` | Working Memory | Normal ranking | Default for all new entries |
| `cold` | Fading | RRF score penalty (-0.2) | 0 accesses in 30+ days |

> Target: ~50-100 hot entries max. No limit on warm. Cold entries are
> consolidation/prune candidates.

## Two schema decisions and their reasons

These are the reusable insights. Both are the kind of thing a later change
would silently reverse without them written down.

### Tier column, not separate tables

> A `tier` column on the existing `entries` table avoids row migration overhead
> and keeps all entries in a single searchable index. The ONLY separate table
> is `discarded_entries` -- that's a genuine lifecycle boundary.

### Access LOG table, not a counter

> A flat `access_count` is lossy -- can't distinguish "50 accesses in March,
> zero since" from "2 accesses this week." An `entry_access_log` table with
> timestamps provides:
> - **Recency**: when was it last accessed?
> - **Frequency**: how many times in the last N days?
> - **Query diversity**: how many different search queries surfaced it?

## Schema as designed

```sql
-- Tier column on entries table
ALTER TABLE entries ADD COLUMN tier TEXT DEFAULT 'warm' CHECK (tier IN ('hot','warm','cold'));
ALTER TABLE entries ADD COLUMN consolidated_into UUID REFERENCES entries(id);
ALTER TABLE entries ADD COLUMN consolidated_from UUID[];

-- Index for tier-based queries
CREATE INDEX idx_entries_tier ON entries(tier);

-- Access tracking log
CREATE TABLE entry_access_log (
    id SERIAL PRIMARY KEY,
    entry_id UUID REFERENCES entries(id) ON DELETE CASCADE,
    accessed_at TIMESTAMPTZ DEFAULT now(),
    query_text TEXT,           -- the search query that surfaced this entry
    context TEXT DEFAULT 'search'  -- 'search', 'session_load', 'direct'
);
CREATE INDEX idx_access_log_entry ON entry_access_log(entry_id, accessed_at DESC);
CREATE INDEX idx_access_log_time ON entry_access_log(accessed_at);

-- Discard staging table
CREATE TABLE discarded_entries (
    id UUID PRIMARY KEY,
    source_table TEXT NOT NULL,
    original_content TEXT NOT NULL,
    tags TEXT[],
    namespace TEXT,
    tier_at_discard TEXT,
    access_history JSONB,        -- summary of access pattern before discard
    discarded_at TIMESTAMPTZ DEFAULT now(),
    reason TEXT,                  -- 'decay', 'consolidated', 'manual'
    expires_at TIMESTAMPTZ,      -- when permanent delete happens (90 days after discard)
    consolidated_into UUID       -- if discarded due to consolidation, link to replacement
);
CREATE INDEX idx_discarded_expires ON discarded_entries(expires_at);
```

## Access tracking injection points

| Tool | When | Context |
|------|------|---------|
| `search_brain` | Every result returned | `'search'` + query text |
| `search_all` | Every result returned | `'search'` + query text |
| `session_load` | All entries referenced in loaded session | `'session_load'` |

> NOT on writes -- creating an entry isn't "accessing" it.

> Implementation: After search results are returned, fire an async INSERT into
> `entry_access_log` for each result. Non-blocking -- don't slow down search.

## The dream cycle phases

Phases 1-3 (score, promote, demote) ship. The rest is the undone design.

### Phase 4: Consolidate (Skippy-guided) — NOT IMPLEMENTED

> 1. Find clusters of 3+ entries with cosine similarity > 0.85 within same
>    namespace
> 2. Skippy reviews each cluster and decides:
>    - **Merge**: Write one clean consolidated entry, archive originals
>      (`consolidated_into` FK)
>    - **Keep**: Entries are similar but distinct enough to keep separate
>    - **Flag**: Entries are contradictory -- flag for Rico's review
> 3. Consolidation model: Sonnet (cost-efficient for summarization)
> 4. Archived originals keep `consolidated_into` pointing to the replacement
> 5. Replacement entry gets `consolidated_from` array listing source IDs
>
> **Rollback**: To un-merge, restore originals (clear `consolidated_into`),
> delete the consolidated entry.

This is the design that explains the orphan columns. The rollback path is why
the relationship is stored on both sides rather than as a single pointer.

### Phase 5: Prune — NOT IMPLEMENTED

> Cold entries older than 60 days with no accesses → move to
> `discarded_entries`

with `expires_at = now() + interval '90 days'` and `reason = 'decay'`.

### Phase 6: Cleanup — NOT IMPLEMENTED

> Permanently delete discarded entries past their expiry:
> ```sql
> DELETE FROM discarded_entries WHERE expires_at < now();
> ```

The 90-day discard window is the whole point of the staging table: discard is
reversible for 90 days, deletion is not.

### Phase 7: Report

> Log what changed to `memory/dreaming/YYYY-MM-DD.md`: entries promoted (count
> + examples), demoted (count), consolidated (clusters merged, originals
> archived), pruned (moved to discard), permanently deleted (expired from
> discard), current tier distribution (hot/warm/cold/discarded counts).

## Namespace scoping and per-namespace thresholds — NOT IMPLEMENTED

> Dream cycle runs **per-namespace**. Entries in `skippy` namespace never
> consolidate with `collab` namespace entries.

Configurable decay thresholds per namespace, as designed:

```yaml
namespaces:
  skippy:
    hot_threshold_days: 7
    cold_threshold_days: 30
    discard_threshold_days: 60
  collab:
    hot_threshold_days: 14
    cold_threshold_days: 45
    discard_threshold_days: 90
  rico:
    hot_threshold_days: 7
    cold_threshold_days: 30
    discard_threshold_days: 60
```

Note the namespace names are pre-`shared-kb`: `collab` is the legacy shared
namespace, now retired as a client-facing name (see
[`shared-kb-canonical-namespace.md`](./shared-kb-canonical-namespace.md) and
[`../collab-retirement-preflight.md`](../collab-retirement-preflight.md)). The
*thresholds* are the design content; the namespace labels are dated.

## Future tools named in the design

| Tool | Purpose |
|------|---------|
| `dream_status` | Show tier distribution, pending consolidations, discard queue |
| `dream_cycle` | Trigger manual dream cycle |
| `rescue_entry` | Move cold/discarded entry back to warm |
| `tier_override` | Manually pin an entry to hot (permanent until unpinned) |

Shipped equivalents differ in name and shape (`set_tier`, `bulk_set_tier`,
`tier_recommendations`, `access_report`). `rescue_entry` and `tier_override`
have no shipped equivalent.

## Boundary: OB dreaming vs OpenClaw dreaming

> These are complementary systems:
> - **OpenClaw dreaming**: File-based (MEMORY.md, daily notes). Promotes
>   short-term file recalls to durable memory files.
> - **OB dreaming**: Database-based (entries table). Promotes/demotes/
>   consolidates semantic knowledge entries.
>
> They don't overlap. OpenClaw dreaming handles Skippy's local workspace files.
> OB dreaming handles the shared knowledge graph.

## Evolution path as designed

> 1. **Now**: Skippy runs full cycle guided at 3am, learns patterns
> 2. **Later**: Schema + tracking automated, Skippy reviews consolidations only
> 3. **Eventually**: Fully automated with Skippy as exception handler
