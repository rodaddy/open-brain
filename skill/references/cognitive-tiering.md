# Cognitive Tiering

Every brain entry has a **tier** that affects search ranking and can be used to filter results.

## Tiers

| Tier | Meaning | Search Boost | Promotion Trigger | Demotion Trigger |
|------|---------|-------------|-------------------|------------------|
| **hot** | Front-of-mind -- actively relevant | +0.3 RRF boost | 3+ accesses in 7 days | 0 accesses in 7 days -> warm |
| **warm** | Default for all new entries | No boost | New entries start here | 0 accesses in 30 days -> cold |
| **cold** | Deprioritized -- still searchable | -0.2 RRF penalty | Rescued from cold by access | 60+ days cold with no rescue -> discard |

## Setting Tier

```bash
# Promote an entry to hot
mcp2cli open-brain set_tier --params '{"table": "thoughts", "id": "<uuid>", "tier": "hot"}'

# Demote an entry to cold
mcp2cli open-brain set_tier --params '{"table": "decisions", "id": "<uuid>", "tier": "cold"}'

# Reset to warm (default)
mcp2cli open-brain set_tier --params '{"table": "thoughts", "id": "<uuid>", "tier": "warm"}'
```

Requires write permission on the target table.

## Searching by Tier

```bash
# Filter search results to hot-tier only
mcp2cli open-brain search_brain --params '{"query": "<query>", "tier": "hot"}'

# Federated search, brain results filtered to hot
mcp2cli open-brain search_all --params '{"query": "<query>", "tier": "hot"}'

# List recent cold entries (candidates for review)
mcp2cli open-brain list_recent --params '{"tier": "cold"}'

# List recent hot entries (front-of-mind)
mcp2cli open-brain list_recent --params '{"tier": "hot", "days": 30}'
```

When no tier filter is provided, all tiers are returned but hot entries are boosted and cold entries are deprioritized via RRF score adjustments.

## How Tier Boost Works

During hybrid search (vector + FTS merged via RRF), the final score is adjusted:

```
final_score = rrf_score + TIER_BOOST[tier]
```

Where `TIER_BOOST = { hot: 0.3, warm: 0, cold: -0.2 }`.

This means a hot entry ranked 5th by pure relevance might surface to 2nd, while a cold entry ranked 3rd might drop to 5th. The content still needs to be relevant -- tier boost is a nudge, not an override.

## Access Tracking

Every search result and session load automatically records access:
- `access_count` and `last_accessed_at` updated on the entry's source table
- Detailed log entry in `entry_access_log` with query text and context

This data drives the dream cycle's promotion/demotion decisions.

## Dream Cycle

The dream cycle is a periodic process that adjusts tiers based on access patterns. Currently run manually (guided by Skippy at 3am), not yet automated.

### What It Does

1. **Score** -- query `entry_access_log` for frequency/recency per entry
2. **Promote** -- warm entries with 3+ accesses in 7 days -> hot
3. **Demote** -- hot entries with 0 accesses in 7 days -> warm; warm with 0 in 30 days -> cold
4. **Consolidate** -- cluster cold entries by embedding similarity, LLM-merge groups of 3+, archive originals
5. **Prune** -- cold entries older than 60 days with no rescues -> `discarded_entries` table
6. **Report** -- log what changed for review

### Schema Support

The database already has the schema for full dream cycle support:
- `tier` column on all 5 tables (CHECK constraint: hot/warm/cold)
- `entry_access_log` table with entry_id, source_table, accessed_at, query_text, context
- `discarded_entries` table with reason, expires_at, access_summary
- `consolidated_into` / `consolidated_from` columns for merge tracking
