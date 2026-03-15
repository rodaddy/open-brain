# Requirements: Open Brain

## v1 Requirements

### Database (DB)

- **DB-01**: PostgreSQL + pgvector database with 5 tables (thoughts, decisions, relationships, projects, sessions)
- **DB-02**: 768-dim vector embeddings via Google gemini-embedding-001 through LiteLLM (outputDimensionality: 768)

### Server (SRV)

- **SRV-01**: MCP server with HTTP transport (StreamableHTTPServerTransport) + Bearer token auth

### Auth (AUTH)

- **AUTH-01**: Role-based auth -- different tokens grant different write permissions per table

### Tools (TOOL)

- **TOOL-01**: `search_brain` tool -- semantic search across all tables
- **TOOL-02**: `log_thought` tool -- capture free-form notes, ideas, observations
- **TOOL-03**: `log_decision` tool -- record choices with rationale and context
- **TOOL-04**: `find_person` tool -- relationship lookup with warmth score
- **TOOL-05**: `session_save` tool -- write full session summary with structured fields (project, tags, blockers, next steps)
- **TOOL-06**: `session_load` tool -- read latest session context for a project or globally

### Data (DATA)

- **DATA-01**: Relationships table tracks everyone (professional + personal) with last contact date and warmth score
- **DATA-02**: Projects table as secondary store alongside .planning/ (gradual migration path)
- **DATA-03**: Sessions table stores full summaries + structured fields for semantic search across session history

### Integration (INT)

- **INT-01**: mcp2cli registration for CLI access
- **INT-02**: Discord thought capture -- Discord bot sends messages to n8n workflow which INSERTs to thoughts table

## v1.1 Requirements

### Curation (CUR)

- **CUR-01**: Schema migration adds `archived_at`, `access_count`, `usefulness_score`, `last_accessed_at` to all 5 tables with partial indexes on `archived_at IS NULL`
- **CUR-02**: `archive_entry` tool soft-deletes entries by setting `archived_at = NOW()`, enforces delete permission (admin + n8n only)
- **CUR-03**: `list_recent` tool provides chronological review with configurable date range and optional table filtering
- **CUR-04**: `update_entry` tool modifies mutable fields per table with automatic re-embedding when content fields change
- **CUR-05**: `rate_entry` tool sets `usefulness_score` (0.0-1.0) with write permission enforcement
- **CUR-06**: `search_brain` tracks usage (`access_count`, `last_accessed_at`) on returned results and weights result ordering by `usefulness_score`
- **CUR-07**: Curation script detects duplicates (vector distance), stale entries (old + unused), and vague content via LLM-as-judge

## Out of Scope (v1)

- Frontend/UI -- CLI and MCP access are sufficient
- Replacing qmd for code/file vectors -- qmd stays for codebase indexing
- Full .planning/ replacement -- v1 is gradual migration (DB as secondary store)
- Real-time sync between .planning/ files and DB

## Out of Scope (v1.1)

- `brain_stats` tool -- not in v1.1 requirements, can be added in a future version

## Traceability

| Requirement | Phase | Status |
|-------------|-------|--------|
| DB-01 | Phase 1 | Pending |
| DB-02 | Phase 1 | Pending |
| SRV-01 | Phase 1 | Complete |
| AUTH-01 | Phase 1 | Pending |
| TOOL-01 | Phase 2 | Complete |
| TOOL-02 | Phase 2 | Complete |
| TOOL-03 | Phase 2 | Complete |
| TOOL-04 | Phase 3 | Complete |
| TOOL-05 | Phase 3 | Complete |
| TOOL-06 | Phase 3 | Complete |
| DATA-01 | Phase 3 | Complete |
| DATA-02 | Phase 1 | Pending |
| DATA-03 | Phase 3 | Complete |
| INT-01 | Phase 5 | Complete |
| INT-02 | Phase 5 | Complete |
| CUR-01 | Phase 7 | Complete |
| CUR-02 | Phase 7 | Complete |
| CUR-03 | Phase 7 | Pending |
| CUR-04 | Phase 7 | Complete |
| CUR-05 | Phase 7 | Complete |
| CUR-06 | Phase 7 | Pending |
| CUR-07 | Phase 7 | Pending |

---
*22 requirements (15 v1 + 7 v1.1), 22/22 mapped*
