q# Glossary

Project-specific terminology for Open Brain. All agents and contributors use these definitions.

## Domain Terms

| Term | Definition | NOT This |
|------|-----------|----------|
| **Brain** | The collective knowledge store -- all five domain tables (thoughts, decisions, relationships, projects, sessions) accessed as a unified system. | A single table or the database host. |
| **Curation** | The automated process of detecting and handling duplicates, stale entries, and vague content via LLM-as-judge; runs via `scripts/curate.ts`. | Manual review or deletion of records. |
| **Decision** | A recorded choice with a required `title` and `rationale`, plus optional `alternatives` and `context`; stored in the `decisions` table. | Any loosely noted choice; decisions must capture why and what alternatives were considered. |
| **Entry** | Any single row in any of the five brain tables; the generic term used in tools like `archive_entry`, `update_entry`, and `rate_entry`. | A specific table record; use the table name when precision matters. |
| **Person** | A contact record in the `relationships` table, keyed on `person_name` (case-insensitive unique). | A system user or auth role. |
| **Project** | A named entity in the `projects` table that groups related work; a secondary store alongside `.planning/`. | A filesystem directory or GitHub repository. |
| **Relationship** | A row in the `relationships` table representing a person, their `warmth`, and how the owner knows them. | A database foreign key or join. |
| **Session** | A saved AI session summary in the `sessions` table, capturing `summary`, `blockers`, `next_steps`, and `key_decisions` for continuity across context compactions. | An HTTP/MCP transport session or a user login session. |
| **Soft-delete / Archive** | Setting `archived_at = NOW()` on a row rather than deleting it; archived rows are excluded from all searches and listings by default. | Hard deletion from the database. |
| **Stale entry** | A row untouched (`access_count = 0`) for more than 90 days; a candidate for LLM-judge review during curation. | Any old row; staleness requires zero accesses, not just age. |
| **Thought** | A freeform idea, observation, or note stored in the `thoughts` table; the most general entry type. | A structured record with required fields; thoughts have only `content` and optional `tags`. |
| **Cognitive Tiering** | The system of classifying brain entries as hot, warm, or cold based on relevance; affects search ranking via RRF score boosts and enables filtering. | A caching layer or performance optimization; tiering is about knowledge relevance, not system performance. |
| **Dream Cycle** | A periodic process that evaluates entry access patterns and adjusts tiers (promote warm→hot for frequently accessed, demote warm→cold for stale entries, consolidate related cold entries). Currently manual, not scripted. | A cron job or sleep/wake scheduler; the dream cycle is specifically about tier lifecycle management. |
| **Front of Mind** | Entries in the hot tier -- actively relevant knowledge that gets boosted in search results (+0.3 RRF). | A UI concept or notification system; "front of mind" means higher search ranking. |
| **Tier** | One of three cognitive priority levels (`hot`/`warm`/`cold`) assigned to every brain entry; stored as a TEXT column with CHECK constraint; defaults to `warm`. | A pricing tier or access level; tiers are about knowledge priority, not user permissions. |
| **Tier Boost** | The RRF score adjustment applied during search based on an entry's tier: hot=+0.3, warm=0, cold=-0.2; defined in `TIER_BOOST` constant in search-brain.ts. | A generic ranking signal; tier boost is the specific numeric adjustment in Reciprocal Rank Fusion. |
| **Usefulness score** | A 0.0-1.0 float on every entry reflecting perceived value; affects vector search ranking and curation decisions (default 0.5 when null). | A search relevance score or distance metric. |
| **Warmth** | An integer 1-5 on a `relationships` row indicating closeness (1 = distant, 5 = very close); used for sorting in `find_person`. | A temperature, sentiment score, or generic rating. |

## Technical Terms

| Term | Definition | NOT This |
|------|-----------|----------|
| **Access tracking** | Fire-and-forget `UPDATE` that increments `access_count` and sets `last_accessed_at`, plus `INSERT` into `entry_access_log`, whenever search results are returned; drives stale detection and tier promotion. | Real-time analytics or audit logging. |
| **Backfill** | The `scripts/backfill.ts` process that generates embeddings for rows where `embedding IS NULL`; run after bulk imports. | Any migration or data fix; backfill is specifically for embedding generation. |
| **content_hash** | SHA-256 of normalized (lowercase, trimmed, whitespace-collapsed) embeddable text; used as a partial unique index to prevent exact duplicate inserts. | A row ID or version fingerprint. |
| **CTE** | Common Table Expression in PostgreSQL; used extensively in `search-brain.ts` to build per-table vector and FTS queries before unioning results. | A cached query result or materialized view. |
| **Distance** | Cosine distance (`<=>`) between two `halfvec(768)` vectors; lower = more similar; 0.0 is identical, 2.0 is maximally dissimilar. | Euclidean distance or similarity score (which is inverted). |
| **Duplicate threshold** | The cosine distance cutoff (`0.08`) below which two entries are considered semantically identical and the older is archived by curation. | A fuzzy-match string threshold. |
| **Extracted metadata** | Legacy structured JSON (`topics`, `people`, `action_items`, `dates`) stored in `extracted_metadata` when imported or backfilled. Runtime write-time extraction is disabled. | The raw content or user-supplied tags. |
| **Fire-and-forget** | An async operation (access tracking) launched without awaiting the result so it does not block the MCP response. | A queued job or background worker. |
| **FTS / Full-text search** | PostgreSQL `tsvector`-based keyword search using `plainto_tsquery`; the keyword path in hybrid search, scored with `ts_rank_cd`. | Vector/semantic search. |
| **GIN index** | Generalized Inverted Index on `search_vector` columns; enables fast full-text search in the hybrid mode. | The HNSW index used for vector search. |
| **halfvec(768)** | PostgreSQL `pgvector` type storing a 768-dimension embedding as 16-bit half-precision floats; all five tables use this type. | `vector(768)` (full 32-bit); this project specifically uses halfvec for storage efficiency. |
| **HNSW** | Hierarchical Navigable Small World index (`m=16, ef_construction=200`) on every embedding column; enables approximate nearest-neighbor search. | A brute-force scan; HNSW trades recall for speed. |
| **Hybrid search** | The default `search_mode`: runs vector and FTS in parallel, then merges with RRF; falls back to FTS-only if embedding generation fails. | A multi-table scan; hybrid refers to the two retrieval methods, not multiple tables. |
| **LLM-as-judge** | Using a fast LLM (`CURATE_MODEL`, default `gpt-4o-mini`) to classify stale entries as KEEP / ARCHIVE / DOWNGRADE or to score vague content quality. | Human review or rule-based classification. |
| **person: tag prefix** | The naming convention `person:<Name>` applied when `extractMetadata` finds a person mention; enables tag-based filtering on person references. | A relationship table entry; a `person:` tag is a tag on another entry, not the person record itself. |
| **RRF / Reciprocal Rank Fusion** | Merge algorithm that combines ranked result lists using `1 / (k + rank)` scores (k=60); items appearing in both lists get boosted; used in both within-brain hybrid search and `search_all` across brain + qmd. | A weighted average or score normalization. |
| **Role** | One of five auth identities (`admin`, `agent`, `discord`, `n8n`, `readonly`) mapped to Bearer tokens; determines per-table read/write/delete permissions. | A user account or database role. |
| **search_vector** | A `tsvector GENERATED ALWAYS AS ... STORED` column on each table; auto-maintained by PostgreSQL on every row update; used for FTS. | The embedding column; `search_vector` is for keyword search, `embedding` is for semantic search. |
| **Semantic fields** | The subset of a table's columns that feed into embedding generation (e.g., `content` for thoughts, `title + rationale` for decisions); changing these triggers re-embedding. | All columns; non-semantic fields like `tags` do not affect the embedding. |
| **Stateless mode** | MCP request handling without a persistent session; the server creates an ephemeral transport, injects a synthetic initialize handshake, processes the request, then tears down. Used by mcp2cli, curl, and n8n. | Stateful session mode where the client sends `mcp-session-id`. |

## Abbreviations

| Abbrev | Expansion |
|--------|-----------|
| **CTE** | Common Table Expression (PostgreSQL) |
| **FTS** | Full-Text Search |
| **GIN** | Generalized Inverted Index (PostgreSQL index type for tsvector) |
| **HNSW** | Hierarchical Navigable Small World (approximate nearest-neighbor index algorithm) |
| **KB** | Knowledge Base (legacy term; the pre-Open Brain JSON files in `pai-private/knowledge/`) |
| **MCP** | Model Context Protocol (the transport/tool protocol this server implements) |
| **OB** | Open Brain (this project; used in code comments and `searchOB` function) |
| **RRF** | Reciprocal Rank Fusion |
| **TTL** | Time To Live (30-minute MCP session expiry in `transport.ts`) |
