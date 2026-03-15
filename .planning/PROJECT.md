# Open Brain

## What This Is

Unified PostgreSQL + pgvector brain for PAI. A single MCP server (HTTP transport) backed by semantic-searchable tables that replace fragmented context scattered across MEMORY.md, qmd session files, Discord, and .planning/ directories. Any PAI consumer -- Claude Code, OpenClaw agents, Discord bot, n8n workflows -- reads and writes the same brain.

## Core Value

Cross-domain semantic search across all context types -- a single query surfaces relevant thoughts, decisions, people, projects, and session history regardless of where or when they were captured.

## Requirements

### Validated

(None yet -- ship to validate)

### Active

- [ ] PostgreSQL + pgvector database with 5 tables (thoughts, decisions, relationships, projects, sessions)
- [ ] 768-dim vector embeddings via Google gemini-embedding-001 through LiteLLM (outputDimensionality: 768)
- [ ] MCP server with HTTP transport (StreamableHTTPServerTransport) + Bearer token auth
- [ ] `search_brain` tool -- semantic search across all tables
- [ ] `log_thought` tool -- capture free-form notes, ideas, observations
- [ ] `log_decision` tool -- record choices with rationale and context
- [ ] `find_person` tool -- relationship lookup with warmth score
- [ ] `session_save` tool -- write full session summary with structured fields (project, tags, blockers, next steps)
- [ ] `session_load` tool -- read latest session context for a project or globally
- [ ] Role-based auth -- different tokens grant different write permissions per table
- [ ] mcp2cli registration for CLI access
- [ ] Discord thought capture -- Discord bot sends messages to n8n workflow which INSERTs to thoughts table
- [ ] Relationships table tracks everyone (professional + personal) with last contact date and warmth score
- [ ] Projects table as secondary store alongside .planning/ (gradual migration path)
- [ ] Sessions table stores full summaries + structured fields for semantic search across session history

### Out of Scope

- Frontend/UI -- CLI and MCP access are sufficient for v1
- Replacing qmd for code/file vectors -- qmd stays for codebase indexing, open-brain handles everything else
- Full .planning/ replacement -- v1 is gradual migration (DB as secondary store, GSD still writes files)
- Real-time sync between .planning/ files and DB -- manual or n8n-triggered for now

## Context

Context is currently fragmented across:
- Claude Code session memory (MEMORY.md, .planning/)
- qmd (code/file vectors only -- 14,857 files, 64,210 vectors)
- Discord conversations (ephemeral, unsearchable by AI)
- Second Brain / session markdown files indexed by qmd

This means session start/stop depends on writing/reading .md files through qmd, autonomous agents can't share context with interactive sessions, and cross-domain reasoning (linking a decision to a person to a project) is impossible.

Inspiration: nate.b.jones "Open Brain" concept -- same idea, zero dependency on Supabase/Vercel/Substack. Built entirely on PAI infrastructure.

## Constraints

- **Database**: PostgreSQL on 10.71.20.49 (shared with n8n) -- new `open_brain` database, must not interfere with n8n's DB
- **Embedding model**: Google gemini-embedding-001 via LiteLLM, 768 dimensions (outputDimensionality: 768)
- **Runtime**: Bun (PAI standard) + Express.js for HTTP server
- **Transport**: HTTP with StreamableHTTPServerTransport (matches n8n-mcp pattern for mcp2cli compatibility)
- **Auth**: Bearer token, role-based (different tokens for different consumers)
- **File size**: 750 lines max per file (LAW 9)
- **No secrets in git**: All credentials via .env (gitignored) or vaultwarden

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| PostgreSQL on 10.71.20.49 (n8n host) | Already has pgvector, avoids new container | -- Pending |
| Google gemini-embedding-001 (768 dims) | Latest Gemini embedder, Matryoshka-trained, longest support runway. Verified working on Vertex AI. | -- Pending |
| HTTP transport (not stdio) | Enables mcp2cli, multi-consumer access, matches n8n-mcp pattern | -- Pending |
| Role-based auth | Discord bot shouldn't write decisions, agents shouldn't modify relationships without confirmation | -- Pending |
| Gradual .planning/ migration | De-risks rollout -- DB as secondary store first, prove value before cutting over | -- Pending |
| Express.js + StreamableHTTPServerTransport | Battle-tested pattern from n8n-mcp (handles thousands of sessions) | -- Pending |
| Bun runtime | PAI standard, fast startup, native TypeScript | -- Pending |
| LiteLLM inline embeddings (primary) | Simplest path -- MCP server calls embedding endpoint directly on insert. n8n webhook as secondary for async/batch | -- Pending |

---
*Last updated: 2026-03-13 after initialization*
