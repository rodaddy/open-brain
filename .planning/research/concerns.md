# Open Brain: Risks & Concerns

**Project:** Open Brain (Unified PostgreSQL + pgvector brain for PAI)
**Researched:** 2026-03-13
**Overall Risk Level:** MEDIUM-HIGH (one critical issue requiring immediate action)

---

## CRITICAL: Embedding Model Deprecated

**Google `text-embedding-004` was deprecated on January 14, 2026.** API requests to this model now return 404 errors. The project spec lists this as the embedding model, routed through LiteLLM. This must be resolved before any code is written.

**Replacement:** `gemini-embedding-001` (GA, supports 768/1536/3072 output dimensions via MRL truncation). Setting `output_dimensionality: 768` preserves compatibility with the planned 768-dim column schema.

**LiteLLM-specific gotchas (HIGH confidence -- from documented postmortem):**
- Passing `model="text-embedding-004"` without a provider prefix causes LiteLLM to call Google's API directly, silently ignoring `api_base`. Fix: prefix with `openai/` to force proxy routing.
- Gemini does not support `encoding_format: base64`. If LiteLLM passes this, you get HTTP 400. Fix: `litellm_settings: drop_params: true` in proxy config.
- Ensure LiteLLM proxy config maps the `embeddings` alias to `gemini/gemini-embedding-001` (or `vertex_ai/gemini-embedding-001` depending on provider).

**Action required:** Update PROJECT.md constraint from `text-embedding-004` to `gemini-embedding-001` with `output_dimensionality: 768`. Verify LiteLLM proxy config on 10.71.20.53 supports the new model before development begins.

---

## 1. Shared PostgreSQL Instance Risks

**Severity:** HIGH
**Likelihood:** MEDIUM
**Impact:** n8n workflows stop executing if open_brain queries exhaust connections or starve CPU/IO

### What Goes Wrong

The PostgreSQL instance on 10.71.20.49 serves n8n's operational database. open_brain introduces vector similarity searches (CPU-intensive), embedding storage (IO-intensive), and concurrent writes from multiple consumers. A poorly-tuned similarity search or a bulk re-embedding job could degrade n8n's performance or exhaust the connection pool.

PostgreSQL's process-per-connection architecture means every open_brain connection consumes memory even when idle. The default `max_connections` is 100 -- if open_brain claims 30+ connections and n8n uses 30+, headroom disappears fast.

### Specific Risks

| Risk | Likelihood | Impact |
|------|-----------|--------|
| Connection pool exhaustion (no connections left for n8n) | MEDIUM | HIGH -- n8n workflows fail |
| CPU contention from vector similarity queries | MEDIUM | MEDIUM -- n8n slows down |
| IO contention from bulk inserts/re-embedding | LOW | MEDIUM -- both apps slow |
| Memory pressure from HNSW index + n8n queries | LOW | HIGH -- OOM kills PostgreSQL |
| Vacuum/maintenance blocking both databases | LOW | LOW -- temporary slowdown |

### Recommended Mitigations

1. **Per-database connection limits:** `ALTER DATABASE open_brain CONNECTION LIMIT 20;` -- caps open_brain's connections so it cannot starve n8n. Start conservative, increase based on monitoring.

2. **Per-role connection limits:** Create a dedicated `open_brain` PostgreSQL role with `CONNECTION LIMIT 15`. n8n's role gets its own limit. Neither can monopolize the pool.

3. **Application-level connection pooling:** Use a connection pool in the MCP server (e.g., `pg` pool with `max: 10`). Do not open a new connection per request.

4. **Statement timeout for safety:** `ALTER DATABASE open_brain SET statement_timeout = '30s';` -- prevents runaway similarity queries from holding connections indefinitely. n8n's database is unaffected.

5. **Monitor `pg_stat_activity`:** Set up a simple health check that alerts when total connections exceed 80% of `max_connections` or when open_brain connections exceed their limit.

6. **Escape hatch -- separate instance:** If contention becomes real (not theoretical), migrating open_brain to its own LXC container is straightforward since it's a separate database. Design the connection string as a config value from day one.

---

## 2. Embedding API Reliability

**Severity:** HIGH
**Likelihood:** MEDIUM
**Impact:** Inserts succeed but without embeddings, breaking semantic search silently

### What Goes Wrong

The MCP server generates embeddings inline on insert (call LiteLLM, get vector, store row). If LiteLLM or the upstream Google API is down, slow, or rate-limited, one of two things happens:
- Insert fails entirely (user sees error, but data is lost)
- Insert blocks for 30+ seconds waiting for embedding response (connection held, pool pressure)

Community reports show `text-embedding-004` (and likely its successor) experiencing daily performance degradation windows where response times spike from 12ms to 45 seconds.

### Specific Risks

| Risk | Likelihood | Impact |
|------|-----------|--------|
| LiteLLM proxy down (10.71.20.53 unreachable) | LOW | HIGH -- all inserts fail |
| Google API rate limiting (429 errors) | MEDIUM | MEDIUM -- inserts queue/fail |
| Embedding latency spikes (45s response) | MEDIUM | MEDIUM -- connections held, pool pressure |
| Model deprecation (already happened once) | HIGH | HIGH -- all embeddings stop |
| Embedding dimension mismatch after model change | MEDIUM | HIGH -- search returns garbage |

### Recommended Mitigations

1. **Store first, embed async:** Insert the row with `embedding = NULL`, then generate the embedding in a background process or trigger. This decouples write availability from embedding availability. A simple approach: a PostgreSQL `AFTER INSERT` trigger that queues a `NOTIFY`, and a background worker that listens and backfills embeddings.

2. **Retry with exponential backoff:** If embedding inline, implement retry (3 attempts, exponential backoff starting at 500ms) before falling back to NULL embedding.

3. **Embedding timeout:** Set a hard 5-second timeout on the LiteLLM call. If it doesn't respond in 5s, store NULL and queue for backfill.

4. **Backfill query:** Maintain a standing query: `SELECT id FROM thoughts WHERE embedding IS NULL` -- run periodically (every 5 minutes via n8n workflow or cron) to catch and fill any gaps.

5. **Model version column:** Store `embedding_model` alongside every vector. When the model changes, you know exactly which rows need re-embedding. This is cheap insurance against the next deprecation.

6. **Health check on LiteLLM:** The MCP server's `/health` endpoint should verify LiteLLM connectivity, not just its own HTTP listener.

---

## 3. Concurrent Write Safety

**Severity:** MEDIUM
**Likelihood:** MEDIUM
**Impact:** Duplicate entries, lost updates, inconsistent data

### What Goes Wrong

Multiple consumers write simultaneously:
- Claude Code sessions log thoughts and decisions
- Discord bot inserts thoughts via n8n
- n8n workflows write session summaries
- Other agents read/write concurrently

PostgreSQL's default `READ COMMITTED` isolation is fine for independent inserts (each thought is a new row, no read-modify-write cycle). But problems emerge with:
- Duplicate detection (two sources log the same thought within seconds)
- Relationship updates (two agents update the same person's warmth score)
- Session save conflicts (two sessions for the same project write summaries simultaneously)

**pgvector-specific concern (HIGH confidence):** pgvector's HNSW index breaks MVCC's immutability assumption by performing in-place modifications to graph nodes during insertions. A `REPEATABLE READ` transaction may not see consistent results across repeated similarity searches within the same transaction. This is documented behavior, not a bug -- but it means you cannot rely on REPEATABLE READ for vector search consistency.

### Specific Risks

| Risk | Likelihood | Impact |
|------|-----------|--------|
| Duplicate thoughts from Discord + Claude Code | MEDIUM | LOW -- annoying but not harmful |
| Concurrent warmth score updates (last write wins) | LOW | LOW -- latest value is probably fine |
| Session save race (two summaries for same project) | LOW | MEDIUM -- one summary lost |
| HNSW index inconsistency during concurrent writes | MEDIUM | LOW -- approximate search is already approximate |

### Recommended Mitigations

1. **Append-only design for thoughts/decisions:** These tables should be insert-only. No updates, no deletes in normal operation. This eliminates most concurrency concerns -- parallel inserts to the same table are safe in PostgreSQL.

2. **Content hash for deduplication:** Add a `content_hash` column (SHA-256 of normalized content) with a unique constraint. Duplicate inserts fail cleanly with a constraint violation that the MCP server catches and returns "already exists."

3. **Upsert for relationships:** Use `INSERT ... ON CONFLICT (person_name) DO UPDATE SET warmth = EXCLUDED.warmth, last_contact = EXCLUDED.last_contact` -- last write wins, which is the correct behavior for relationship updates.

4. **Session versioning:** For the sessions table, use `(project, created_at)` as the natural key. Multiple session saves for the same project create separate rows (append-only), and `session_load` returns the most recent. No conflict possible.

5. **Don't use REPEATABLE READ with vector search:** Stick with `READ COMMITTED` (the default). The HNSW inconsistency under REPEATABLE READ is a known limitation. Since similarity search is inherently approximate, the practical impact is negligible at this scale.

---

## 4. Vector Index Performance at Scale

**Severity:** MEDIUM
**Likelihood:** LOW (at projected scale)
**Impact:** Search latency degrades, memory requirements exceed host capacity

### Scale Projections for Open Brain

| Timeframe | Estimated Rows | Notes |
|-----------|---------------|-------|
| 3 months | ~1K-5K | Thoughts, decisions, sessions |
| 1 year | ~10K-30K | Active daily use |
| 3 years | ~50K-100K | Unlikely to exceed this for personal use |

This is a personal knowledge system, not a SaaS product. The scale ceiling is bounded by one person's output.

### Performance at Projected Scale (768 dimensions)

| Row Count | Base Storage | HNSW Index Overhead | Total Memory | Query Latency |
|-----------|-------------|--------------------:|--------------|---------------|
| 1K | ~3MB | ~6-9MB | ~12MB | <1ms |
| 10K | ~30MB | ~60-90MB | ~120MB | <2ms |
| 100K | ~300MB | ~600-900MB | ~1.2GB | <5ms |
| 1M | ~3GB | ~6-9GB | ~12GB | <10ms |

At 768 dimensions (vs the 1536 used in most benchmarks), storage and index overhead are halved. Even at 100K rows, total memory for the HNSW index is ~1GB -- well within a typical LXC container's allocation.

### Recommendations

1. **Start without an index.** At <1K rows, sequential scan is fast enough and avoids HNSW build overhead. Add the HNSW index when query latency becomes noticeable (probably around 5K-10K rows).

2. **When you do index, use HNSW over IVFFlat.** HNSW handles dynamic data (frequent inserts) without requiring periodic reindexing. IVFFlat requires retraining when data distribution shifts significantly. For a personal brain with continuous inserts, HNSW is the clear choice.

3. **Build indexes concurrently:** `CREATE INDEX CONCURRENTLY` avoids blocking writes during index creation. This is critical if building the index on a populated table.

4. **HNSW tuning defaults are fine for this scale:** `m = 16`, `ef_construction = 64` are pgvector defaults. Don't over-tune until you have evidence of recall issues.

5. **Consider `halfvec` if memory becomes a concern:** Half-precision vectors reduce index size by 50% with minimal recall impact. Not needed at projected scale, but available as an escape valve.

---

## 5. Security Concerns

**Severity:** MEDIUM
**Likelihood:** LOW
**Impact:** Unauthorized access to personal data (relationships, decisions, warmth scores)

### Data Sensitivity Assessment

| Table | Sensitivity | Rationale |
|-------|------------|-----------|
| thoughts | LOW-MEDIUM | Free-form notes -- could contain anything |
| decisions | MEDIUM | Personal/professional choices with rationale |
| relationships | HIGH | Names, warmth scores, contact dates -- personally identifiable |
| projects | LOW | Project metadata, mostly technical |
| sessions | LOW-MEDIUM | Session summaries, could contain sensitive discussion context |

### Specific Risks

| Risk | Likelihood | Impact |
|------|-----------|--------|
| Bearer token leaked in logs/shell history | MEDIUM | HIGH -- full read/write access |
| Token shared across too many consumers (blast radius) | MEDIUM | MEDIUM -- compromised consumer = full access |
| No audit trail of who wrote what | HIGH | MEDIUM -- can't trace data provenance |
| Network exposure (MCP server on LAN without TLS) | LOW | MEDIUM -- LAN sniffing captures tokens |

### Recommended Mitigations

1. **Per-consumer tokens:** Issue a separate bearer token for each consumer (Claude Code, Discord bot, n8n, agents). When a token is compromised, revoke one without disrupting others.

2. **Role-based write restrictions (already planned):** The PROJECT.md already specifies role-based auth. Implement it from day one -- don't defer. Discord bot gets `thoughts:write` only. Agents get scoped permissions.

3. **Audit column on every table:** Add `created_by TEXT NOT NULL` to every table, populated from the token's identity. You always know which consumer wrote a row.

4. **Token storage via vaultwarden:** Store bearer tokens in vaultwarden, not in .env files scattered across consumers. Use the vaultwarden-secrets MCP for retrieval. This centralizes rotation.

5. **Token rotation plan:** Rotate tokens every 90 days. With per-consumer tokens stored in vaultwarden, rotation is: generate new token, update vaultwarden entry, restart consumer. No code changes.

6. **TLS between consumers and MCP server:** Even on a private LAN, use TLS. Self-signed certs are fine -- the point is encrypting bearer tokens in transit. Caddy or nginx reverse proxy with auto-cert is the simplest path.

7. **Don't log request bodies:** Thoughts and decisions contain personal content. Log request metadata (method, path, consumer ID, status code, latency) but never the body.

---

## 6. Data Integrity

**Severity:** HIGH
**Likelihood:** MEDIUM
**Impact:** Data loss, corrupted embeddings, broken search after model migration

### Backup Strategy

The open_brain database shares an instance with n8n. If the instance is already backed up (likely via Proxmox snapshots or pg_dumpall cron), open_brain is included. But verify this -- don't assume.

**Recommended backup approach:**

1. **Database-specific dump:** `pg_dump -Fc open_brain > open_brain_$(date +%Y%m%d).dump` -- run daily via cron. Custom format (`-Fc`) supports parallel restore and selective table restore.

2. **Separate from n8n backups:** Don't rely on instance-level backups alone. A database-specific dump lets you restore open_brain independently without touching n8n.

3. **Test restores periodically:** A backup you've never restored is not a backup. Restore to a scratch database quarterly.

4. **Retention:** Keep 7 daily, 4 weekly, 3 monthly. At projected scale, dumps are tiny (<100MB for years of data).

### Embedding Drift & Model Migration

This is the single highest data integrity risk. When the embedding model changes (and it will -- it already has once with text-embedding-004's deprecation), all existing embeddings become incompatible with new ones. Searching with a new model's query vector against old model's stored vectors returns garbage.

**Mitigations:**

1. **`embedding_model` column:** Store the model identifier (e.g., `gemini-embedding-001`) with every row. This is non-negotiable.

2. **`embedding_version` integer column:** Simpler to query than string comparison. Increment when model changes. `WHERE embedding_version = CURRENT_VERSION` in all search queries.

3. **Dual-column migration strategy:** When migrating models:
   - Add `embedding_v2 vector(new_dim)` column
   - Backfill in batches (100 rows per batch, with rate limiting)
   - Once complete, swap search queries to use v2
   - Drop old column after validation
   - Build new HNSW index with `CONCURRENTLY`

4. **Dimension flexibility:** Use `gemini-embedding-001` with `output_dimensionality: 768` to maintain the planned 768-dim schema. If a future model doesn't support 768, the dual-column approach handles the transition.

### Schema Evolution

1. **Use a migration tool:** Drizzle ORM or a simple numbered-SQL-file approach (e.g., `migrations/001_initial.sql`, `002_add_content_hash.sql`). Don't apply schema changes ad-hoc.

2. **Never modify vector column types in place:** Always add new columns and migrate. `ALTER COLUMN ... TYPE vector(new_dim)` invalidates the HNSW index and requires a full rebuild.

---

## 7. Operational Concerns

**Severity:** MEDIUM
**Likelihood:** HIGH (silent failures are the default without monitoring)
**Impact:** Embeddings silently stop generating, search quality degrades without anyone noticing

### Silent Failure Modes

| Failure | Detection Difficulty | Consequence |
|---------|---------------------|-------------|
| LiteLLM proxy goes down | MEDIUM -- inserts still succeed if embedding is optional | Search returns no results for recent content |
| Embedding dimension changes silently | HIGH -- no error, just bad search results | Similarity scores become meaningless |
| HNSW index becomes stale/fragmented | HIGH -- gradual latency increase | Search slows down over weeks |
| Disk fills on PostgreSQL host | LOW -- obvious errors | Both n8n and open_brain stop |
| Token expires/rotates but consumer not updated | LOW -- immediate 401 errors | Specific consumer stops working |

### Recommended Monitoring

1. **MCP server health endpoint (`/health`):**
   - PostgreSQL connectivity: `SELECT 1`
   - LiteLLM connectivity: test embedding call with a fixed string
   - Response time for each check
   - Count of rows with `embedding IS NULL` (backfill queue depth)

2. **Embedding completeness check (run every 15 minutes):**
   ```sql
   SELECT COUNT(*) AS missing_embeddings
   FROM (
     SELECT id FROM thoughts WHERE embedding IS NULL
     UNION ALL
     SELECT id FROM decisions WHERE embedding IS NULL
   ) AS unembedded;
   ```
   Alert if count > 0 for more than 30 minutes.

3. **Connection monitoring:**
   ```sql
   SELECT datname, count(*) AS connections
   FROM pg_stat_activity
   WHERE datname = 'open_brain'
   GROUP BY datname;
   ```
   Alert if connections exceed 80% of the database limit.

4. **Query performance baseline:**
   Enable `pg_stat_statements` and track p95 latency for similarity search queries. Alert if p95 exceeds 100ms (generous threshold at projected scale).

5. **n8n workflow for monitoring:** Build an n8n workflow that runs the above checks every 15 minutes and sends Discord alerts on failure. This uses existing infrastructure -- no new monitoring stack needed.

6. **Log aggregation:** The MCP server should log to stdout in structured JSON format. If running in an LXC, use `journalctl` for log access. Log: request method, path, consumer ID, response status, latency, embedding generation success/failure.

---

## Risk Matrix Summary

| # | Concern | Severity | Likelihood | Priority | Key Mitigation |
|---|---------|----------|-----------|----------|----------------|
| 0 | **Embedding model deprecated** | CRITICAL | ALREADY HAPPENED | IMMEDIATE | Switch to gemini-embedding-001, verify LiteLLM config |
| 1 | Shared PostgreSQL contention | HIGH | MEDIUM | Phase 1 | Per-database connection limits, application pooling |
| 2 | Embedding API reliability | HIGH | MEDIUM | Phase 1 | Store-first-embed-async, backfill queue |
| 3 | Concurrent write safety | MEDIUM | MEDIUM | Phase 1 | Append-only design, content hash dedup |
| 4 | Vector index at scale | MEDIUM | LOW | Phase 2+ | Start without index, add HNSW when needed |
| 5 | Security / token management | MEDIUM | LOW | Phase 1 | Per-consumer tokens, audit columns, TLS |
| 6 | Data integrity / model drift | HIGH | MEDIUM | Phase 1 | embedding_model column, dual-column migration strategy |
| 7 | Operational monitoring | MEDIUM | HIGH | Phase 1 | Health endpoint, embedding completeness check, n8n alerts |

---

## Implications for Roadmap

1. **Before any code:** Verify LiteLLM proxy supports `gemini-embedding-001`. Update PROJECT.md constraints. This is a blocker.

2. **Phase 1 must include:** Connection pooling, per-database limits, embedding_model column, content_hash dedup, audit columns, health endpoint. These are not "nice to haves" -- they prevent the most likely failures.

3. **Async embedding is strongly recommended over inline:** The store-first-embed-async pattern eliminates the coupling between write availability and embedding availability. It adds complexity (background worker, backfill query) but prevents the most impactful failure mode (inserts failing because LiteLLM is slow).

4. **Monitoring in Phase 1, not Phase 2:** Silent failures are the default. An MCP server that inserts rows without embeddings and nobody notices for a week is worse than one that fails loudly. Build the health check and embedding completeness monitor alongside the core tables.

5. **Escape hatch design:** Connection strings, embedding model names, and dimensions should all be config values (environment variables). When (not if) the infrastructure changes -- new PostgreSQL host, new embedding model, different dimensions -- the change should be a config update, not a code change.

---

## Sources

- [PostgreSQL Connection Pool Management](https://docs.digitalocean.com/products/databases/postgresql/how-to/manage-connection-pools/) - HIGH confidence
- [PostgreSQL Connection Limits](https://oneuptime.com/blog/post/2026-01-25-manage-connection-limits-postgresql/view) - HIGH confidence
- [pgvector HNSW vs IVFFlat (AWS)](https://aws.amazon.com/blogs/database/optimize-generative-ai-applications-with-pgvector-indexing-a-deep-dive-into-ivfflat-and-hnsw-techniques/) - HIGH confidence
- [pgvector Performance at Scale](https://medium.com/@dikhyantkrishnadalai/optimizing-vector-search-at-scale-lessons-from-pgvector-supabase-performance-tuning-ce4ada4ba2ed) - MEDIUM confidence
- [pgvector Repeatable Read Isolation Issue](https://kernelmaker.github.io/pgvector_rr) - HIGH confidence
- [Google text-embedding-004 Deprecation (mem0)](https://github.com/mem0ai/mem0/issues/3942) - HIGH confidence
- [Google text-embedding-004 Deprecation (Genkit)](https://github.com/firebase/genkit/issues/4551) - HIGH confidence
- [gemini-embedding-001 GA Announcement](https://developers.googleblog.com/gemini-embedding-available-gemini-api/) - HIGH confidence
- [LiteLLM pgvector Deployment Postmortem](https://github.com/BerriAI/litellm/issues/22807) - HIGH confidence
- [n8n text-embedding-004 Deprecation Discussion](https://community.n8n.io/t/google-deprecating-text-embedding-004-but-gemini-embedding-001-doesnt-work/262008) - HIGH confidence
- [Zero-Downtime Embedding Migration](https://dev.to/humzakt/zero-downtime-embedding-migration-switching-from-text-embedding-004-to-text-embedding-3-large-in-1292) - MEDIUM confidence
- [Embedding Versioning with pgvector (DBI Services)](https://www.dbi-services.com/blog/rag-series-embedding-versioning-with-pgvector-why-event-driven-architecture-is-a-precondition-to-ai-data-workflows/) - MEDIUM confidence
- [MCP Security Best Practices (Official)](https://modelcontextprotocol.io/specification/2025-06-18/basic/security_best_practices) - HIGH confidence
- [MCP Credential Security (Doppler)](https://www.doppler.com/blog/mcp-server-credential-security-best-practices) - MEDIUM confidence
- [PostgreSQL Health Monitoring Guide](https://pghealth.io/blog/postgresql-health-check) - MEDIUM confidence
- [PostgreSQL Concurrency & Race Conditions](https://nemanjatanaskovic.com/postgresql-concurrency-control-isolation-levels-locks-and-real-world-race-conditions/) - HIGH confidence
