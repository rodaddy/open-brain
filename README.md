# Open Brain

[![Buy Me A Coffee](https://img.shields.io/badge/Buy%20Me%20A%20Coffee-ffdd00?style=for-the-badge&logo=buy-me-a-coffee&logoColor=black)](https://buymeacoffee.com/rodaddy)

A semantic knowledge base and memory system built as an [MCP](https://modelcontextprotocol.io/) server. Store thoughts, decisions, contacts, sessions, and projects in PostgreSQL with pgvector — then search across all of them with hybrid vector + keyword retrieval.

Built for AI agents that need persistent, searchable memory across conversations.

## Features

- **15 MCP tools** for reading, writing, and managing knowledge
- **Hybrid search** — reciprocal rank fusion (RRF) over HNSW vector similarity + PostgreSQL full-text search
- **Cognitive tiering** — hot/warm/cold memory lifecycle with usage-based scoring
- **Per-consumer auth** — role-based access control with scoped tokens (admin, agent, readonly, etc.)
- **Auto-embedding** — content is embedded on write via any OpenAI-compatible endpoint
- **Metadata extraction** — automatic topic, entity, and action-item extraction via LLM
- **Session management** — stateful MCP sessions with upsert, deduplication, and TTL expiry
- **Curation pipeline** — automated duplicate detection, staleness decay, and LLM-as-judge quality scoring

## Tools

| Tool | Description |
|------|-------------|
| `search_brain` | Hybrid semantic + keyword search across any table. Supports vector, keyword, or fused mode with tier boosting and recency weighting. |
| `search_all` | Unified search across Open Brain tables and external knowledge bases. |
| `log_thought` | Store a thought, idea, or observation. Auto-embeds and extracts metadata. |
| `log_decision` | Record a decision with rationale and considered alternatives. |
| `find_person` | Search contacts by name (partial match) or semantic similarity. |
| `upsert_person` | Create or update a contact record (name, relationship, warmth, notes). |
| `session_save` | Save a session summary with structured fields. Supports upsert via session ID. |
| `session_load` | Load the most recent session, optionally filtered by project. |
| `list_recent` | List recent entries across all tables with offset pagination and tier filtering. |
| `get_entry` | Fetch a single entry by table and ID. |
| `update_entry` | Update content, tags, or metadata on an existing entry. |
| `archive_entry` | Soft-delete an entry with an optional reason. |
| `rate_entry` | Score an entry's usefulness (0–1) for quality feedback. |
| `list_stale` | Find entries not accessed recently — candidates for tier demotion (hot→warm→cold). Filterable by table, current tier, and staleness threshold. |
| `set_tier` | Move an entry between cognitive tiers (hot/warm/cold). |

## Prerequisites

- [Bun](https://bun.sh/) runtime
- PostgreSQL 13+ with [pgvector](https://github.com/pgvector/pgvector) extension
- An OpenAI-compatible embedding endpoint (e.g., [LiteLLM](https://github.com/BerriAI/litellm), OpenAI, Ollama)

## Setup

### 1. Clone and install

```bash
git clone https://github.com/rodaddy/open-brain.git
cd open-brain
bun install
```

### 2. Configure environment

```bash
cp .env.example .env
```

Edit `.env` with your values:

```env
# Database
DB_HOST=localhost
DB_PORT=5432
DB_NAME=open_brain
DB_USER=postgres
DB_PASSWORD=your-password

# Embedding service (any OpenAI-compatible /v1/embeddings endpoint)
EMBEDDING_BASE_URL=http://localhost:8791/v1
EMBEDDING_API_KEY=your-key
EMBEDDING_MODEL=embeddinggemma-300m-8bit
EMBEDDING_DIMENSIONS=768

# Optional LiteLLM fallback / extraction endpoint
LITELLM_URL=http://localhost:4000
LITELLM_API_KEY=your-litellm-key

# Metadata extraction model (optional — enables auto-tagging on writes)
EXTRACTION_MODEL=gpt-4o-mini

# Server
PORT=3100

# Auth tokens (generate with: openssl rand -hex 32)
AUTH_TOKEN_ADMIN=
AUTH_TOKEN_AGENT=
AUTH_TOKEN_READONLY=
```

A helper script is also available for token management:

```bash
./scripts/generate-tokens.sh           # show all tokens
./scripts/generate-tokens.sh --verify  # verify tokens are set
./scripts/generate-tokens.sh --rotate  # generate new tokens
```

### 3. Set up the database

Enable pgvector and run migrations:

```sql
CREATE EXTENSION IF NOT EXISTS vector;
```

```bash
bun run migrate
```

### 4. Start the server

```bash
bun run start
```

The MCP server listens on `http://localhost:3100` with Streamable HTTP transport.

## Auth & Permissions

Each consumer gets a scoped Bearer token. Roles control which tables are readable/writable:

| Role | Read | Write | Delete |
|------|------|-------|--------|
| `admin` | All tables | All tables | All tables |
| `agent` | All tables | thoughts, decisions, relationships, sessions | — |
| `discord` | — | thoughts | — |
| `n8n` | All tables | All tables | All tables |
| `readonly` | All tables | — | — |

Set tokens via `AUTH_TOKEN_ADMIN`, `AUTH_TOKEN_AGENT`, etc. in your `.env`. You can also add custom per-user tokens with the `AUTH_TOKEN_USER_*` pattern.

## Database Schema

Five core tables, all with 768-dimensional halfvec embeddings and HNSW indexes:

- **thoughts** — ideas, observations, notes
- **decisions** — titled decisions with rationale and alternatives
- **relationships** — contacts with warmth scoring and structured fields
- **projects** — named projects with status and metadata
- **sessions** — session summaries with blockers, next steps, and key decisions

Supporting tables: `entry_access_log` (usage tracking), `discarded_entries` (archive staging), `_migrations`.

## Search

`search_brain` fuses results from two retrieval paths:

1. **Vector search** — HNSW nearest-neighbor over halfvec(768) embeddings (cosine distance)
2. **Full-text search** — PostgreSQL `tsvector` with English stemming

Results are merged via Reciprocal Rank Fusion (RRF) with adjustments for:
- **Cognitive tier** — hot entries boosted (+0.3), cold entries penalized (−0.2)
- **Recency** — newer entries score slightly higher
- **Table weights** — configurable per-table importance

Search modes: `hybrid` (default), `vector`, `keyword`.

## Scripts

| Script | Description |
|--------|-------------|
| `bun run start` | Start the MCP server |
| `bun run migrate` | Run pending database migrations |
| `bun run test` | Run test suite |
| `bun run typecheck` | Type-check without emit |
| `bun run backfill` | Backfill NULL embeddings across all tables (`-- --all` re-embeds every row for model migrations) |
| `bun run curate` | Automated curation: dedup, staleness, quality scoring (`--dry-run` supported) |

Additional utility scripts in `scripts/`:

| Script | Description |
|--------|-------------|
| `generate-tokens.sh` | Auth token generation, verification, and rotation via secret store |
| `bulk-import.ts` | Batch import entries from JSON/CSV with deduplication |
| `obsidian-sync.ts` | Sync entries with an Obsidian vault |
| `ob-backfill.ts` | Extract and backfill session data from Claude Code transcripts |

## Cognitive Tiering

Entries move between three tiers based on access patterns:

| Tier | Meaning | Search Impact |
|------|---------|---------------|
| **hot** | Recently created or frequently accessed | Boosted (+0.3) |
| **warm** | Default tier for all new entries | Neutral |
| **cold** | Stale, low-access, or decay candidates | Penalized (−0.2) |

Tier transitions can be manual (`set_tier` tool) or automated via the curation script, which uses access frequency, age, and LLM-as-judge quality scoring to archive or downgrade entries.

## Testing

```bash
bun run test        # run test suite
bun run typecheck   # type-check without emit
```

Tests live alongside source files and cover auth, embedding, search, migrations, and tool behavior. Coverage threshold: 80% for lines, functions, and statements (configured in `bunfig.toml`).

## CI/CD

Pull requests trigger automated checks via GitHub Actions:
- **CI** — tests, type-checking, linting
- **Claude Code Review** — AI-powered code review focused on bugs, security, performance, and embedding quality

## Project Structure

```
src/
├── index.ts              # Express server bootstrap
├── server.ts             # MCP server factory
├── transport.ts          # Streamable HTTP transport & session management
├── auth.ts               # Token parsing & role resolution
├── permissions.ts        # RBAC matrix
├── embedding.ts          # Embedding pipeline
├── extraction.ts         # LLM metadata extraction
├── tools/                # MCP tool implementations (14 tools)
│   ├── search-brain.ts   # Hybrid search engine
│   ├── log-thought.ts
│   ├── log-decision.ts
│   ├── find-person.ts
│   ├── session-save.ts
│   └── ...
├── db/
│   ├── pool.ts           # Connection pool
│   ├── migrate.ts        # Migration runner
│   └── migrations/       # SQL migrations (001–008)
└── middleware/
    └── request-logger.ts
```

## MCP Client Configuration

To connect from an MCP client (e.g., Claude Desktop, Claude Code):

```json
{
  "mcpServers": {
    "open-brain": {
      "url": "http://localhost:3100/mcp",
      "headers": {
        "Authorization": "Bearer YOUR_TOKEN"
      }
    }
  }
}
```

## Documentation

- [CONTRIBUTING.md](CONTRIBUTING.md) — coding standards, development workflow, and infrastructure rules
- [GLOSSARY.md](GLOSSARY.md) — domain terminology (tiers, warmth, dream cycles, etc.)

## License

MIT
