# Roadmap: Open Brain

## Overview

Open Brain delivers a unified semantic brain for PAI -- a single MCP server backed by PostgreSQL + pgvector that replaces fragmented context scattered across MEMORY.md, qmd sessions, Discord, and .planning/ directories. The roadmap moves from infrastructure verification and server foundation, through core tools (the primary read/write/search loop), to secondary tools, operational hardening, and finally consumer integration. Each phase delivers a coherent, independently verifiable capability.

## Phases

**Phase Numbering:**
- Integer phases (1, 2, 3): Planned milestone work
- Decimal phases (2.1, 2.2): Urgent insertions (marked with INSERTED)

Decimal phases appear between their surrounding integers in numeric order.

- [x] **Phase 1: Foundation** - Database schema, MCP server skeleton, auth middleware, embedding service
- [ ] **Phase 2: Core Tools** - log_thought, log_decision, search_brain -- the primary read/write/search loop
- [ ] **Phase 3: Secondary Tools** - find_person, session_save, session_load -- complete the tool suite
- [ ] **Phase 4: Operational Hardening** - Embedding backfill, monitoring, structured logging, CI pipeline, deployment
- [ ] **Phase 5: Consumer Integration** - mcp2cli registration, Discord thought capture, per-consumer token setup

## Phase Details

### Phase 1: Foundation
**Goal**: A running MCP server with authenticated HTTP transport, all 5 database tables with vector columns, and a working embedding pipeline -- verified end-to-end with a health check
**Depends on**: Nothing (first phase)
**Requirements**: DB-01, DB-02, SRV-01, AUTH-01, DATA-02
**Success Criteria** (what must be TRUE):
  1. PostgreSQL `open_brain` database exists on 10.71.20.49 with pgvector extension enabled (>= 0.8.0 verified) and all 5 tables created with embedding columns and HNSW indexes
  2. MCP server starts on port 3100, responds to `GET /health` with database and LiteLLM connectivity status, and accepts authenticated `POST /mcp` requests
  3. Bearer token auth rejects unauthenticated requests (401) and enforces role-based permissions per tool -- admin, agent, discord, n8n, and readonly roles behave correctly
  4. Embedding service generates 768-dim vectors via LiteLLM proxy (gemini-embedding-001), with graceful degradation (stores NULL on failure) and content hash deduplication
  5. Projects table exists as a secondary store with fields matching .planning/ metadata (name, status, tags, description)
**Plans**: 3 plans

Plans:
- [ ] 01-01-PLAN.md -- Project scaffold, shared types, database schema, pool, and migration runner
- [ ] 01-02-PLAN.md -- Auth middleware, permission system, and embedding service with tests
- [ ] 01-03-PLAN.md -- MCP server, transport dispatch, Express app, and health endpoint with tests

### Phase 2: Core Tools
**Goal**: Users can log thoughts and decisions with automatic embedding, and semantically search across all brain tables to find relevant context
**Depends on**: Phase 1
**Requirements**: TOOL-01, TOOL-02, TOOL-03
**Success Criteria** (what must be TRUE):
  1. `log_thought` accepts content and optional tags, generates an embedding inline, inserts to the thoughts table, and returns the created record ID -- with graceful degradation if embedding fails
  2. `log_decision` accepts title, rationale, optional alternatives and tags, generates an embedding, inserts to the decisions table, and returns the created record -- enforcing permission checks per role
  3. `search_brain` accepts a natural language query and optional table filter, generates a query embedding, runs CTE UNION ALL cross-table search with cosine distance, and returns ranked results with source type, content, distance, and metadata
  4. All three tools have unit tests (mocked deps) and protocol tests (InMemoryTransport) covering happy path, validation errors, and `isError` failure cases
**Plans**: TBD

Plans:
- [ ] 02-01: TBD
- [ ] 02-02: TBD

### Phase 3: Secondary Tools
**Goal**: Users can look up people with warmth scores, save full session summaries with structured fields, and load the latest session context for any project
**Depends on**: Phase 2
**Requirements**: TOOL-04, TOOL-05, TOOL-06, DATA-01, DATA-03
**Success Criteria** (what must be TRUE):
  1. `find_person` searches the relationships table by name (partial match), returns person details including warmth score, last contact date, relationship context, and notes -- and supports semantic search for queries like "who do I know at Google"
  2. `session_save` writes a session summary to the sessions table with structured fields (project, tags, blockers, next_steps, key_decisions) plus an embedding of the summary content, and enforces that only admin/agent/n8n roles can write
  3. `session_load` retrieves the most recent session for a given project (or globally if no project specified), returning the full summary and structured fields
  4. Relationships table enforces the data model: person name, context, warmth score (1-5), last contact date, notes, tags -- with upsert on person name for concurrent safety
  5. All secondary tools have unit and protocol tests matching the patterns established in Phase 2
**Plans**: TBD

Plans:
- [ ] 03-01: TBD
- [ ] 03-02: TBD

### Phase 4: Operational Hardening
**Goal**: The server runs reliably in production with monitoring that catches silent failures, automated embedding backfill, structured logging, and a CI pipeline that validates every change
**Depends on**: Phase 3
**Requirements**: (no direct v1 requirements -- operational quality derived from risk mitigations)
**Success Criteria** (what must be TRUE):
  1. Embedding backfill script finds all rows with `embedding IS NULL` across all tables and retries embedding generation -- runnable manually via `bun run backfill` or triggered by n8n workflow
  2. CI pipeline (GitHub Actions) runs typecheck, unit tests, and integration tests against a pgvector service container on every push to wip/feat/fix branches and PRs to main
  3. Structured JSON logging captures request method, consumer ID, response status, latency, and embedding success/failure for every MCP tool call -- never logging request bodies or tokens
  4. Server runs as a deployed service (systemd unit or LXC) with automatic restart, environment variable configuration, and a .env.example documenting all required variables
**Plans**: TBD

Plans:
- [ ] 04-01: TBD
- [ ] 04-02: TBD

### Phase 5: Consumer Integration
**Goal**: All PAI consumers can access Open Brain through their native interfaces -- mcp2cli from the terminal, Claude Code via MCP config, Discord via n8n webhook pipeline
**Depends on**: Phase 4
**Requirements**: INT-01, INT-02
**Success Criteria** (what must be TRUE):
  1. mcp2cli is configured for Open Brain with skill file generated -- `mcp2cli open-brain search_brain --params '{"query":"test"}'` returns results from the command line
  2. Discord thought capture works end-to-end: a message in a designated Discord channel triggers an n8n workflow that calls the Open Brain MCP server's `log_thought` tool with the message content, and the thought is searchable via `search_brain`
  3. Per-consumer Bearer tokens are generated and stored in vaultwarden, with each consumer (Claude Code, mcp2cli, Discord/n8n) using its own scoped token
**Plans**: TBD

Plans:
- [ ] 05-01: TBD
- [ ] 05-02: TBD

## Progress

**Execution Order:**
Phases execute in numeric order: 1 -> 2 -> 3 -> 4 -> 5

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| 1. Foundation | 3/3 | Complete | 2026-03-13 |
| 2. Core Tools | 0/2 | Ready to plan | - |
| 3. Secondary Tools | 0/2 | Not started | - |
| 4. Operational Hardening | 0/2 | Not started | - |
| 5. Consumer Integration | 0/2 | Not started | - |
