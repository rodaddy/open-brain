# Project Research Summary

**Project:** Open Brain
**Domain:** Unified semantic brain -- MCP server over PostgreSQL + pgvector
**Researched:** 2026-03-13
**Confidence:** HIGH

## Executive Summary

Open Brain is a personal semantic knowledge store exposing a Model Context Protocol (MCP) server over HTTP. It stores thoughts, decisions, relationships, projects, and session summaries in PostgreSQL with pgvector embeddings, enabling semantic search across all entity types. The consumer set is fixed and known: Claude Code, agents, Discord bot, n8n workflows, and mcp2cli. The established pattern for this type of system is straightforward -- Express.js HTTP server wrapping the MCP TypeScript SDK (v1.x), per-table vector columns with HNSW indexes, inline embedding generation via LiteLLM proxy, and static Bearer token auth with role-based permissions. All researchers independently confirmed HIGH confidence in this stack.

One critical blocker was identified: **Google `text-embedding-004` was shut down on January 14, 2026.** The project spec references this model but it is already dead. The replacement is `gemini-embedding-001` with `output_dimensionality: 768`, which preserves the planned 768-dim schema, provides better embedding quality (Matryoshka training), and works through LiteLLM with the `gemini/` prefix. This must be resolved before any code is written. Additionally, the LiteLLM proxy config on 10.71.20.53 needs updating, and pgvector >= 0.8.0 must be verified on the shared PostgreSQL instance at 10.71.20.49.

The primary operational risk is the shared PostgreSQL instance. Open Brain introduces CPU-intensive vector similarity searches alongside n8n's operational database. This is mitigated by conservative connection pooling (max=10), per-database connection limits, and statement timeouts. The architecture is intentionally simple -- no ORM, no async queue, no OAuth -- appropriate for a single-user system with low write volume (tens to hundreds of inserts per day). The escape hatch for every major dependency (DB host, embedding model, dimensions) is a config change, not a code change.

---

## Critical Blockers

### 1. Embedding Model Migration (BLOCKER)

`text-embedding-004` returned 404s since January 14, 2026. Must switch to `gemini-embedding-001`.

**Required actions before any code:**
- Update LiteLLM proxy config: change model from `text-embedding-004` to `gemini/gemini-embedding-001`
- Add `litellm_settings: drop_params: true` (Gemini rejects `encoding_format: base64`)
- Verify `dimensions=768` works through the proxy endpoint
- Known issue: `task_type` parameter (RETRIEVAL_QUERY vs RETRIEVAL_DOCUMENT) is silently ignored through LiteLLM proxy -- embeddings are identical regardless. Monitor for fix; direct API fallback if search quality suffers.

### 2. pgvector Version Verification (BLOCKER)

Run on 10.71.20.49:
```sql
SELECT extversion FROM pg_available_extensions WHERE name = 'vector';
```
Must be >= 0.8.0 for iterative index scans (critical for filtered multi-table search). Current release is 0.8.2 (includes CVE-2026-3172 fix). Upgrade if needed.

---

## Technology Decisions

| Technology | Version | Purpose | Rationale |
|-----------|---------|---------|-----------|
| Bun | 1.2.x | Runtime | 3x faster Express, native TypeScript, built-in test runner |
| Express.js | ^4.x | HTTP framework | MCP SDK examples use it, middleware ecosystem, path of least resistance |
| @modelcontextprotocol/sdk | ^1.27.0 (v1.x) | MCP server | Stable, v2 is pre-alpha. Do NOT install v2 packages |
| PostgreSQL + pgvector | >= 0.8.0 (target 0.8.2) | Storage + vector search | Iterative scans, HNSW, halfvec support |
| pg (node-postgres) | ^8.x | DB client | Battle-tested, full pgvector support via pgvector npm |
| pgvector (npm) | ^0.2.1 | Type support | registerTypes, toSql, halfvec auto-parsing |
| Zod | ^3.25+ | Schema validation | MCP SDK peer dependency, tool parameter schemas |
| gemini-embedding-001 | GA | Embeddings (768-dim) | Replaces deprecated text-embedding-004, Matryoshka training |
| LiteLLM proxy | existing | Embedding routing | Already deployed at 10.71.20.53, needs config update |

**Explicitly not using:**
- MCP SDK v2 packages (`@modelcontextprotocol/server`, `/node`, `/express`) -- pre-alpha
- Drizzle/Prisma -- overkill for 5 tables with simple queries
- postgres.js (Bun SQL) -- less mature pgvector integration
- Testcontainers -- Bun compatibility issues with Docker socket

---

## Architecture Recommendations

### Server Pattern: Singleton McpServer + Per-Session Transports (Stateful)

One `McpServer` instance owns all tool definitions. Lightweight `StreamableHTTPServerTransport` instances manage individual client sessions via a transport map keyed by session ID. Express middleware chain: JSON parser -> health check (no auth) -> Bearer token auth -> MCP route handler -> error handler.

### Schema: Per-Table Vectors with Search Abstraction

Each of the 5 tables (thoughts, decisions, relationships, projects, sessions) has its own `embedding` column and HNSW index. Cross-table search uses CTE + UNION ALL with inner over-fetch (2-3x outer limit) and final sort. This beats a unified embeddings table at <100K vectors -- simpler schema, better index recall, most queries are type-specific anyway.

**Standard columns on every searchable table:**
- `embedding vector(768) NOT NULL` (consider `halfvec(768)` after testing)
- `content_hash TEXT` (SHA-256 for dedup/cache)
- `embedded_at TIMESTAMPTZ`
- `embedding_model TEXT` (non-negotiable -- tracks model provenance)
- `created_by TEXT NOT NULL` (audit trail from token identity)

### Embedding Pipeline: Synchronous Inline with Graceful Degradation

Insert flow: generate embedding via LiteLLM -> INSERT with vector -> return success. On embedding failure: INSERT with `embedding = NULL`, log warning, queue for backfill. A periodic backfill process (n8n workflow or cron) retries `WHERE embedding IS NULL` rows. Content hash prevents duplicate API calls.

**5-second timeout on LiteLLM calls.** Exceeding this stores NULL and moves on.

### Auth: Static Bearer Tokens with Role Map

Per-consumer tokens stored in vaultwarden. Role-based permission matrix (admin/agent/discord/n8n/readonly) enforced per-tool. Constant-time token comparison. No OAuth -- YAGNI for single-user with known consumers.

### Project Structure

One tool per file in `src/tools/`. Database access centralized in `src/db/` (pool.ts + queries.ts). Embedding logic isolated in `src/embedding.ts`. Auth middleware separate from permission checks. Plain SQL migrations in `src/db/migrations/`. No ORM.

---

## Risk Mitigations

| # | Risk | Severity | Mitigation |
|---|------|----------|------------|
| 1 | **Embedding model deprecated (ALREADY HAPPENED)** | CRITICAL | Switch to gemini-embedding-001, verify LiteLLM config before coding |
| 2 | **Shared PostgreSQL contention** | HIGH | Per-database connection limit (20), app pool max=10, statement_timeout=30s, configurable connection string for future separation |
| 3 | **Embedding API reliability** | HIGH | Graceful degradation (store NULL on failure), 5s timeout, backfill process, embedding_model column for migration tracking |
| 4 | **Silent embedding failures** | MEDIUM-HIGH | Health endpoint checks LiteLLM connectivity, embedding completeness monitor (alert if NULL count > 0 for 30min), structured JSON logging |
| 5 | **Concurrent write conflicts** | MEDIUM | Append-only design for thoughts/decisions, content_hash unique constraint for dedup, upsert for relationships, READ COMMITTED isolation (not REPEATABLE READ -- HNSW breaks MVCC) |
| 6 | **Token/security exposure** | MEDIUM | Per-consumer tokens, vaultwarden storage, audit columns, never log request bodies, TLS via reverse proxy |
| 7 | **Embedding model drift** | MEDIUM | `embedding_model` + `embedding_version` columns, dual-column migration strategy for future model changes |

---

## Testing Strategy

### Framework
Bun built-in test runner (`bun:test`). Jest-compatible API. No additional test libraries needed.

### Test Layers

| Layer | Approach | What to Test |
|-------|----------|-------------|
| Unit | Direct function calls, mocked deps | Tool handler logic, validation, transforms, permission checks |
| Protocol | `InMemoryTransport` + MCP `Client` | Parameter schemas, response format, `isError` behavior |
| HTTP | `fetch()` against server on random port | Auth middleware, CORS, route handling, health check |
| Database | Real PostgreSQL (shared test DB locally, GH Actions service container in CI) | SQL correctness, vector search recall, insert/retrieve roundtrip |

### Key Patterns
- **Pre-computed test embeddings** (768-dim vectors captured once) -- eliminates API dependency in tests
- **`toBeCloseTo` for distances** -- floating-point imprecision is expected
- **Separate server factory from transport** -- `createBrainServer(deps)` enables mock injection
- **Co-located test files** -- `search-brain.test.ts` next to `search-brain.ts`

### CI Pipeline
- GitHub Actions with `pgvector/pgvector:pg17-bookworm` service container
- Steps: install -> typecheck -> create pgvector extension -> migrate -> unit tests (with coverage) -> integration tests
- Coverage thresholds: 80% lines/functions/statements

---

## Open Questions

| Question | Impact | When to Resolve |
|----------|--------|----------------|
| Is pgvector >= 0.8.0 on 10.71.20.49? | BLOCKER if not | Before Phase 1 |
| Does `halfvec(768)` maintain acceptable recall with gemini-embedding-001? | 50% storage savings | During Phase 1 (test and decide) |
| Does LiteLLM proxy pass `task_type` correctly for gemini-embedding-001? | Search quality (asymmetric embeddings) | During Phase 1 (test; fall back to direct API if needed) |
| What is `max_connections` on the shared PostgreSQL? | Connection limit sizing | Before Phase 1 |
| Is there an existing backup strategy for the PostgreSQL instance? | Data integrity | Before Phase 1 |
| Should MCP SDK v2 migration be planned? | Future maintenance | No action now; v1.x supported 6+ months after v2 ships |

---

## Roadmap Implications

### Suggested Phase Structure

#### Phase 0: Pre-Flight Verification
**Rationale:** Two blockers must be cleared before any code is written.
**Delivers:** Verified infrastructure readiness.
**Tasks:**
- Verify pgvector version on 10.71.20.49 (upgrade to 0.8.2 if needed)
- Update LiteLLM proxy config for gemini-embedding-001
- Test embedding generation through proxy (768-dim, verify cosine distance makes semantic sense)
- Check `max_connections` and existing backup strategy on PostgreSQL
- Test halfvec recall quality vs vector (decide column type)
**Avoids:** Building on deprecated model, discovering pgvector version issues mid-implementation

#### Phase 1: Foundation (DB + Server Skeleton)
**Rationale:** Schema and server infrastructure must exist before tools can be implemented.
**Delivers:** Running MCP server with health check, database schema, connection pooling, auth middleware, embedding service.
**Components:**
- PostgreSQL schema (all 5 tables with embedding columns, indexes, audit columns)
- Migration system (numbered SQL files + runner script)
- Express server with MCP SDK session dispatch
- Bearer token auth middleware + permission matrix
- Embedding service (LiteLLM client with timeout, graceful degradation, content hashing)
- Connection pool (max=10, health monitoring)
- `/health` endpoint (DB + LiteLLM connectivity)
**Avoids:** Shared instance contention (connection limits), silent embedding failures (health check)

#### Phase 2: Core Tools
**Rationale:** Tools depend on Phase 1 infrastructure. Start with the two most-used tools.
**Delivers:** `log_thought`, `log_decision`, `search_brain` -- the primary read/write loop.
**Components:**
- `log_thought` tool (insert + inline embedding + graceful degradation)
- `log_decision` tool (insert with alternatives/tags + embedding)
- `search_brain` tool (cross-table CTE + UNION ALL, cosine distance, table filtering)
- Zod schemas for all tool parameters
- Error handling (toolError/toolSuccess helpers, never throw from handlers)
- Unit + protocol tests for all three tools
**Avoids:** God tool file (one file per tool), direct pool access in tools (use db/queries.ts)

#### Phase 3: Remaining Tools + Integration Tests
**Rationale:** Secondary tools and full integration testing once the core loop works.
**Delivers:** `find_person`, `session_save`, `session_load`, full integration test suite, CI pipeline.
**Components:**
- `find_person` tool (relationship lookup, warmth score)
- `session_save` tool (write session summary with structured fields)
- `session_load` tool (retrieve latest session by project)
- Integration tests against real PostgreSQL
- CI pipeline (GitHub Actions with pgvector service container)
- Pre-computed test embedding fixtures
**Avoids:** Skipping integration tests (vector search accuracy needs real DB validation)

#### Phase 4: Operational Hardening
**Rationale:** Monitoring and resilience features that prevent silent failures in production.
**Delivers:** Embedding backfill, monitoring, deployment configuration.
**Components:**
- Embedding backfill script/workflow (retry NULL embeddings)
- Embedding completeness monitoring (n8n workflow, Discord alerts)
- Connection pool monitoring (pg_stat_activity checks)
- Structured JSON logging (method, consumer ID, status, latency -- never bodies)
- Deployment config (systemd unit or LXC service, environment variable template)
- Database backup script (pg_dump cron, separate from n8n backups)

#### Phase 5: Consumer Integration
**Rationale:** Consumers connect after the server is stable and monitored.
**Delivers:** Working end-to-end flows for each consumer.
**Components:**
- mcp2cli configuration for Open Brain
- Claude Code MCP config (mcp.json or settings)
- n8n workflow integration (HTTP Request nodes with Bearer token)
- Discord bot integration path (via n8n or direct)
- Per-consumer token generation and vaultwarden storage

### Phase Ordering Rationale

- Phase 0 before everything: infrastructure blockers are binary (works or doesn't)
- Phase 1 before tools: tools depend on schema, pool, auth, and embedding service
- Phase 2 groups the primary read/write tools together: they share the embedding pipeline and search infrastructure
- Phase 3 adds secondary tools + validation: by this point the patterns are established, secondary tools follow the template
- Phase 4 after functional completion: monitoring validates what's already working
- Phase 5 last: consumers need a stable, monitored server

### Research Flags

**Phases likely needing deeper research during planning:**
- **Phase 0:** Requires hands-on verification (pgvector version, LiteLLM config, halfvec testing) -- cannot be fully planned from docs alone
- **Phase 5:** Consumer-specific MCP configuration (mcp2cli setup, Claude Code config format) may need investigation

**Phases with well-documented standard patterns (skip phase research):**
- **Phase 1:** Express + MCP SDK + pg.Pool -- all patterns documented in research files with code examples
- **Phase 2:** Tool registration, Zod schemas, CTE search -- patterns are fully specified in architecture.md
- **Phase 3:** Same tool pattern, Bun test runner, GitHub Actions -- standard, well-documented
- **Phase 4:** Monitoring queries, structured logging, pg_dump -- commodity ops work

---

## Confidence Assessment

| Area | Confidence | Notes |
|------|------------|-------|
| Stack | HIGH | All technologies verified against official docs, npm registry, GitHub releases |
| Architecture | HIGH | Patterns sourced from MCP SDK docs, pgvector maintainers, production deployment guides |
| Quality/Testing | HIGH | Bun test runner, InMemoryTransport, CI pipeline all verified with official docs |
| Risks/Concerns | HIGH | Critical blocker (embedding model) confirmed across 4+ independent sources |

**Overall confidence: HIGH**

### Gaps to Address

- **halfvec precision:** Theoretical 50% savings, but needs empirical validation with gemini-embedding-001 embeddings before committing to schema. Resolve during Phase 0.
- **LiteLLM task_type passthrough:** Known bug where asymmetric embedding types are ignored. If search quality is poor, may need direct Google API calls bypassing LiteLLM for embeddings. Test during Phase 0/1.
- **PostgreSQL max_connections:** Assumed default 100 on shared instance. Verify actual value to confirm connection limit sizing is safe.
- **Existing backup strategy:** Unknown whether Proxmox snapshots or pg_dumpall cron already covers this instance. Verify before relying on it.

---

## Sources

### Primary (HIGH confidence)
- [pgvector GitHub](https://github.com/pgvector/pgvector) -- extension API, HNSW config, halfvec, iterative scans
- [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk) -- server API, InMemoryTransport, StreamableHTTPServerTransport
- [Google Gemini Embedding Docs](https://ai.google.dev/gemini-api/docs/embeddings) -- gemini-embedding-001 specs, output_dimensionality
- [node-postgres Pool Docs](https://node-postgres.com/apis/pool) -- pool configuration, lifecycle
- [Bun Test Runner Docs](https://bun.com/docs/test) -- test API, coverage, mocking
- [GitHub Actions Service Containers](https://docs.github.com/en/actions/tutorials/use-containerized-services/create-postgresql-service-containers) -- CI pipeline

### Secondary (MEDIUM confidence)
- [AWS HNSW vs IVFFlat Deep Dive](https://aws.amazon.com/blogs/database/optimize-generative-ai-applications-with-pgvector-indexing-a-deep-dive-into-ivfflat-and-hnsw-techniques/) -- indexing strategy comparison
- [Neon halfvec Guide](https://neon.com/blog/dont-use-vector-use-halvec-instead-and-save-50-of-your-storage-cost) -- halfvec storage savings
- [LiteLLM Gemini Bug #17759](https://github.com/BerriAI/litellm/issues/17759) -- task_type passthrough issue
- [Zero-Downtime Embedding Migration](https://dev.to/humzakt/zero-downtime-embedding-migration-switching-from-text-embedding-004-to-text-embedding-3-large-in-1292) -- dual-column strategy
- [pgvector REPEATABLE READ Issue](https://kernelmaker.github.io/pgvector_rr) -- HNSW MVCC limitation

### Tertiary (LOW confidence)
- [pgvector Performance at Scale](https://medium.com/@dikhyantkrishnadalai/optimizing-vector-search-at-scale-lessons-from-pgvector-supabase-performance-tuning-ce4ada4ba2ed) -- scale projections (single author, medium post)

---
*Research completed: 2026-03-13*
*Ready for roadmap: yes*
