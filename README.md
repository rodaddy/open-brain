# Open Brain

[![Buy Me A Coffee](https://img.shields.io/badge/Buy%20Me%20A%20Coffee-ffdd00?style=for-the-badge&logo=buy-me-a-coffee&logoColor=black)](https://buymeacoffee.com/rodaddy)

A semantic knowledge base and memory system built as an [MCP](https://modelcontextprotocol.io/) server. Store thoughts, decisions, contacts, sessions, and projects in PostgreSQL with pgvector — then search across all of them with hybrid vector + keyword retrieval.

Built for AI agents that need persistent, searchable memory across conversations.

## Features

- **Contract-first MCP tools** for reading, writing, and managing knowledge
- **Hybrid search** — reciprocal rank fusion (RRF) over HNSW vector similarity + PostgreSQL full-text search
- **Cognitive tiering** — hot/warm/cold memory lifecycle with usage-based scoring
- **Per-consumer auth** — role-based access control with scoped tokens (admin, agent, readonly, etc.)
- **Auto-embedding** — content is embedded on write via `EMBEDDING_BASE_URL`
- **Session management** — stateful MCP sessions with upsert, deduplication, and TTL expiry
- **Curation pipeline** — automated duplicate detection, staleness decay, and LLM-as-judge quality scoring

## Tools and Contract

`get_contract` is the source of truth for the Open Brain tool surface and input
contract. Downstream clients should not hard-code the tool list from this
README; they should fetch the live contract and, when they need model tool
schemas, convert it through the `openbrain-memory` Python package.

Major tool groups include search and synthesis (`search_brain`, `search_all`,
`brain_answer`), memory writes (`log_thought`, `log_decision`,
`append_session_event`, `session_wrap`), session lifecycle (`session_start`,
`session_context`, `session_load`, `session_save`), repo facts
(`upsert_repo_fact`, `list_repo_facts`), lane state (`lane_upsert`,
`lane_load`), contacts, entries, tiers, and curation.

## Prerequisites

- [Bun](https://bun.sh/) runtime
- PostgreSQL 13+ with [pgvector](https://github.com/pgvector/pgvector) extension
- An OpenAI-compatible embedding endpoint

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

# Server
PORT=3100

# Auth tokens (generate with: openssl rand -hex 32)
AUTH_TOKEN_ADMIN=
AUTH_TOKEN_AGENT=
AUTH_TOKEN_DISCORD=
AUTH_TOKEN_OB_ADMIN=
AUTH_TOKEN_PROMOTER=
AUTH_TOKEN_READONLY=
```

A helper script is also available for the standard admin, agent, discord,
ob-admin, and readonly token set. Manage `AUTH_TOKEN_PROMOTER` explicitly until the
helper supports promoter rotation:

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

### MCP Session Limits

Open Brain keeps stateful Streamable HTTP sessions in memory and expires idle
sessions after 30 minutes. Initialize requests over the active-session cap return
HTTP 429 with `Retry-After` and a machine-readable
`session_cap_exceeded` response.

Defaults:

- `OPEN_BRAIN_MAX_SESSIONS=100`
- `OPEN_BRAIN_SESSION_RETRY_AFTER_SECONDS=2`

`OPEN_BRAIN_MAX_SESSIONS` is a safety cap, not the primary fleet-throttling
mechanism. Prefer client retry/backoff behavior and explicit session cleanup
before raising it.

### Mini two-worker mode

For the Mini deployment, run two local Open Brain workers behind one stable
entrypoint:

```bash
bun run start:two-worker
```

Defaults:

- Public entrypoint: `http://localhost:3100`
- Worker ports: `3101,3102`
- Worker count: `2`
- DB pool per worker: `5`
- Migrations: only worker 1 runs migrations; worker 2 starts with
  `OPEN_BRAIN_RUN_MIGRATIONS=0`

Useful overrides:

```bash
OPEN_BRAIN_PUBLIC_PORT=3100 \
OPEN_BRAIN_WORKERS=2 \
OPEN_BRAIN_WORKER_PORTS=3101,3102 \
OPEN_BRAIN_WORKER_DB_POOL_MAX=5 \
bun run start:two-worker
```

The public `/health` endpoint aggregates both workers. MCP and REST traffic are
round-robin proxied to the workers.

### core01 Deploy And qmd Runtime

The active production service runs on core01 (`10.71.1.21`) through launchd.
Keep the boundaries explicit:

- source checkout: `/Volumes/ThunderBolt/Development/open-brain`
- running app: `/Volumes/ThunderBolt/open-brain/app`
- database data/backups: `/Volumes/ThunderBolt/open-brain/pgdata18` and
  `/Volumes/ThunderBolt/open-brain/backups`
- qmd runtime/index/models: `/Volumes/ThunderBolt/qmd`

Deploys should be owned by this repository, not by hand-copying files. Merging
reviewed changes to `main` validates the repo, but production deploy is a
separate release gate. Before installing a new Open Brain version on core01,
follow [`docs/local-release-deploy-sop.md`](docs/local-release-deploy-sop.md):
run the full local release-candidate test from a clean `main`, create a version
tag whose commit is already reachable from `origin/main` or run a manual
workflow dispatch from the current `origin/main` tip, and watch the deploy.

The same repo-owned deploy command can be run on core01 only from the clean
release-candidate worktree named in the SOP, after the same recorded release
gate has passed:

```bash
bun run deploy:core01
```

That command installs the checked-out repo version into
`/Volumes/ThunderBolt/open-brain/app`. Do not install Open Brain into
`/Volumes/ThunderBolt/Development`; that is the source/mirror area, not the
runtime. Do not install qmd or Postgres data under the source checkout either.

On GitHub, the `deploy` job targets a core01 macOS self-hosted runner with
labels `[self-hosted, macOS, core01]`. It runs only for a `v*` tag push whose
commit is reachable from `origin/main`, or a manual workflow dispatch from
the current `origin/main` tip with `deploy_core01=true`. The deploy script is
the authoritative deploy-ref guard: tag deploys must be reachable from
`origin/main`, and manual dispatches must match the current `origin/main` tip
before staging files or restarting core01. The job stages the checked-out repo
with `tar`, installs runtime dependencies there, bootstraps the pinned qmd
runtime, runs migrations, swaps the staged directory into place, restarts
`com.rico.open-brain`, and checks `/health`.

macOS shell rule: never call `/bin/bash` or rely on the old Apple bash. Use the
Homebrew bash path explicitly in automation:

```bash
/opt/homebrew/bin/bash scripts/core01-deploy-local.sh
```

qmd is pinned and bootstrapped by:

```bash
bun run qmd:core01:bootstrap
```

The Open Brain runtime reads qmd through `QMD_PATH`, normally:

```bash
QMD_PATH=/Volumes/ThunderBolt/qmd/open-brain-qmd.ts
```

Do not put qmd indexes, qmd models, Postgres data, or required production
`node_modules` under `/Volumes/ThunderBolt/Development`.

NATS transport rollout is separate from the HTTP deploy. The broker label is
`com.rico.open-brain-nats`; the Open Brain NATS request/reply worker label is
`com.rico.open-brain-nats-worker`. Keep HTTP workers in HTTP mode and follow
[`docs/core01-nats-worker-runbook.md`](docs/core01-nats-worker-runbook.md)
before installing or restarting the dedicated NATS worker service.

qmd is a repo-knowledge compiler and optional deep lookup source. It is not a
required distributed memory layer for Hermes or other agents. Required qmd-
derived facts must be promoted into Open Brain; remote qmd access remains a
future best-effort escape hatch unless a separate approved wrapper ships.
See [`docs/roadmap/optional-qmd-deep-lookup.md`](docs/roadmap/optional-qmd-deep-lookup.md).

Smoke after startup:

```bash
curl -fsS http://127.0.0.1:3100/health
mcp2cli cache warm open-brain
mcp2cli cache diff open-brain
OPEN_BRAIN_CODEX_SMOKE_WRITE=1 bun run codex-memory-smoke
```

## Python Client Package

The reusable Python package lives in `python/openbrain-memory/`. Install it on
agent hosts, automation hosts, or any Python runtime that talks to Open Brain.
Installing the package does not run the Open Brain service locally; the service
remains remote.

Preferred install sources:

```bash
# Published/internal package, once available
uv pip install --python /path/to/venv/bin/python openbrain-memory==<version>

# Reviewed wheel artifact
uv pip install --python /path/to/venv/bin/python /path/to/openbrain_memory-<version>-py3-none-any.whl

# Transitional git-subdirectory install, pinned to a reviewed commit
uv pip install --python /path/to/venv/bin/python \
  "git+https://github.com/rodaddy/open-brain.git@<40-char-commit>#subdirectory=python/openbrain-memory"
```

Do not use a moving branch or unpinned package for host installs. Use a
reviewed wheel, exact package version, or a full 40-character commit pin.

Runtime configuration for package consumers:

```bash
export OPENBRAIN_BASE_URL="https://open-brain.rodaddy.live"
export OPENBRAIN_TOKEN="..."              # bearer token; never commit this
export OPENBRAIN_NAMESPACE="nagatha"      # normal agent token namespace
export OPENBRAIN_AGENT_ID="nagatha"
```

For normal agent-role tokens, namespace authority is enforced by the server from
the bearer token. `OPENBRAIN_NAMESPACE` must match the token-bound identity;
cross-namespace access requires an explicit delegated privileged role/path.

Trusted lab-only direct HTTP to the active Mac Mini endpoint requires an
explicit opt-in because bearer tokens travel over the request:

```bash
export OPENBRAIN_BASE_URL="http://10.71.1.21:3100"
export OPENBRAIN_ALLOW_INSECURE_HTTP=1
```

`10.71.20.49` is a retained pre-cutover snapshot, not the active production
Open Brain endpoint. Use `https://open-brain.rodaddy.live` or direct
`10.71.1.21:3100` for current host canaries.

For full package usage, schema helper, live canary, and Hermes integration
guidance, see [`python/openbrain-memory/README.md`](python/openbrain-memory/README.md).

## Auth & Permissions

Each consumer gets a scoped Bearer token. Roles control which tables are readable/writable:

| Role | Read | Write | Delete |
|------|------|-------|--------|
| `admin` | All tables | All tables | All tables |
| `agent` | All tables | thoughts, decisions, relationships, sessions | — |
| `discord` | — | thoughts | — |
| `ob-admin` | All tables | All tables | All tables |
| `promoter` | Shared promotion scope | Curated shared-kb promotions | — |
| `readonly` | All tables | — | — |

Set tokens via `AUTH_TOKEN_ADMIN`, `AUTH_TOKEN_AGENT`, `AUTH_TOKEN_DISCORD`,
`AUTH_TOKEN_OB_ADMIN`, `AUTH_TOKEN_PROMOTER`, and `AUTH_TOKEN_READONLY` in your
`.env`. You can also add custom per-user tokens with the `AUTH_TOKEN_USER_*`
pattern. `promoter` is for controlled shared-kb promotion flows, not normal
agent identity. `ob-admin` is a break-glass, full-RWD server-side admin identity
for human operators (manual promotions, deletions) -- it is not for n8n.io
automations (it was renamed from the misnamed, unused `n8n` role in #168).

## Database Schema

Five core tables, all with 768-dimensional halfvec embeddings and HNSW indexes:

- **thoughts** — ideas, observations, notes
- **decisions** — titled decisions with rationale and alternatives
- **relationships** — contacts with warmth scoring and structured fields
- **projects** — named projects with status and metadata
- **sessions** — session summaries with blockers, next steps, and key decisions

Supporting tables: `entry_access_log` (usage tracking), `discarded_entries` (archive staging), `mcp_tool_audit_log` (privacy-safe MCP tool audit — see [docs/operator-audit-log.md](docs/operator-audit-log.md)), `_migrations`.

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

## Identity and Shared Knowledge Boundary

Open Brain treats `shared-kb` as the canonical shared knowledge namespace, not
as a caller identity. Person identities such as `rico` and `kevin`, agent lane
identities such as `bilby` and `skippy`, and promoter service identities such as
`openbrain-promoter` or `hermes-promoter` are bearer-token identities.

Normal agents write their own lane and read their lane plus shared knowledge
through server read policy. Direct `shared-kb` writes require an explicit
promoter service identity and provenance; `X-Namespace` alone is not shared
truth authority. See [docs/identity-boundary.md](docs/identity-boundary.md).

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

Hermes and Python package consumers normally use direct HTTP through
`openbrain-memory`, not a local mcp2cli daemon. Configure them with
`OPENBRAIN_BASE_URL`, `OPENBRAIN_TOKEN`, `OPENBRAIN_NAMESPACE`, and
`OPENBRAIN_AGENT_ID`; use `OPENBRAIN_ALLOW_INSECURE_HTTP=1` only for trusted
lab HTTP endpoints such as `http://10.71.1.21:3100`.

## Documentation

- [CONTRIBUTING.md](CONTRIBUTING.md) — coding standards, development workflow, and infrastructure rules
- [GLOSSARY.md](GLOSSARY.md) — domain terminology (tiers, warmth, dream cycles, etc.)
- [docs/operator-audit-log.md](docs/operator-audit-log.md) — MCP tool audit log schema, env controls, privacy guarantees, fail-open behavior

## License

MIT
