# Architecture Patterns

**Domain:** Unified semantic brain -- MCP server over PostgreSQL + pgvector
**Researched:** 2026-03-13

---

## 1. MCP HTTP Server Architecture

### Recommended: Singleton Server + Per-Session Transport (Stateful)

The MCP TypeScript SDK provides a clear pattern: one `McpServer` instance manages all business logic (tool definitions, resources, prompts), while lightweight per-session `StreamableHTTPServerTransport` instances handle individual client connections.

**Why stateful over stateless:** Open Brain consumers (Claude Code, n8n workflows, Discord bot) benefit from session continuity. A Discord bot conversation or a Claude Code session may issue multiple tool calls -- session affinity means the transport can track request context without per-request overhead. On a single-node deployment (which this is), stateful costs nearly nothing.

**Architecture:**

```
Express App (port 3100)
  |
  +-- POST /mcp  --> session dispatcher
  |     |-- has mcp-session-id? --> lookup transport map --> reuse
  |     |-- isInitializeRequest? --> create new transport --> connect to singleton server --> store
  |     |-- else --> 400 Bad Request
  |
  +-- GET /mcp   --> SSE streaming (server-to-client notifications)
  +-- DELETE /mcp --> session teardown
  |
  +-- Auth middleware (runs before all /mcp routes)
  +-- JSON body parser
  +-- Health check: GET /health
```

**Session management:**

```typescript
// Map of session ID -> transport instance
const transports: Record<string, StreamableHTTPServerTransport> = {};

// On POST /mcp: dispatch to existing session or create new
app.post('/mcp', authMiddleware, async (req, res) => {
  const sessionId = req.headers['mcp-session-id'] as string | undefined;

  if (sessionId && transports[sessionId]) {
    await transports[sessionId].handleRequest(req, res, req.body);
    return;
  }

  if (!sessionId && isInitializeRequest(req.body)) {
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => crypto.randomUUID(),
      onsessioninitialized: (id) => { transports[id] = transport; },
    });
    transport.onclose = () => { delete transports[transport.sessionId!]; };
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
    return;
  }

  res.status(400).json({ error: 'Bad request: missing session or not initialize' });
});
```

**Confidence:** HIGH -- this pattern is directly from the [official MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk) and the [express-mcp-handler](https://github.com/jhgaylor/express-mcp-handler) community package.

### Express Middleware Chain

Order matters. The recommended chain:

1. `express.json()` -- parse JSON bodies
2. Health check route (`GET /health`) -- no auth required
3. `authMiddleware` -- validates Bearer token, attaches role to `req`
4. MCP route handler (`POST/GET/DELETE /mcp`)
5. Error handler middleware (catch-all)

**Use `@modelcontextprotocol/express`** for the official Express middleware adapter. Install: `bun add @modelcontextprotocol/sdk @modelcontextprotocol/express express`. This thin adapter handles Host header validation (DNS rebinding protection) and app defaults.

---

## 2. Database Schema Design for Semantic Search

### Recommended: Per-Table Vectors with a Search Abstraction Layer

After evaluating unified embeddings table vs per-table vectors, **per-table vectors is the right choice for Open Brain**.

**Why per-table, not unified:**

| Factor | Per-Table | Unified Table |
|--------|-----------|---------------|
| Cross-entity search | UNION ALL (handled in app layer) | Single query |
| Index efficiency | Each table gets scoped HNSW index -- better recall | Needs partitioning to avoid post-filter recall loss |
| Schema clarity | Natural relational design, self-documenting | Polymorphic JOINs, `entity_type` discriminator |
| Query patterns | Most queries are type-specific ("find decisions about X") | Global search is the minority case |
| Complexity | Simpler -- standard SQL + pgvector | Partition management, conditional JOINs |
| Table count | 5 tables -- manageable | Premature optimization |

With only 5 tables and moderate data volumes (likely under 100K vectors total in year one), a unified table's advantages (single-query cross-entity search) don't outweigh the schema clarity and index efficiency of per-table vectors.

**Cross-table search** is handled by a `search_brain` tool that issues parallel CTE queries per table and merges results:

```sql
WITH thought_matches AS (
  SELECT id, 'thought' AS source_type, content, tags, created_at,
         embedding <=> $1::vector AS distance
  FROM thoughts
  ORDER BY distance ASC
  LIMIT $2
),
decision_matches AS (
  SELECT id, 'decision' AS source_type, title || ' ' || rationale AS content,
         tags, created_at,
         embedding <=> $1::vector AS distance
  FROM decisions
  ORDER BY distance ASC
  LIMIT $2
),
-- ... similar CTEs for relationships, projects, sessions
all_matches AS (
  SELECT * FROM thought_matches
  UNION ALL
  SELECT * FROM decision_matches
  UNION ALL
  -- ...
)
SELECT * FROM all_matches
ORDER BY distance ASC
LIMIT $3;
```

Each CTE uses its own table's HNSW index independently (PostgreSQL can only use one vector index per ORDER BY), then results merge via UNION ALL with a final sort. The inner LIMIT ($2) should be 2-3x the outer LIMIT ($3) to ensure enough candidates from each table.

**Confidence:** HIGH -- CTE + UNION ALL is the [documented workaround](https://learn.microsoft.com/en-us/answers/questions/2118689/how-to-search-across-multiple-vector-indexes-in-po) for PostgreSQL's single-index-per-ORDER-BY limitation, and per-table vectors is the [most commonly recommended pattern](https://www.postgresql.fastware.com/blog/how-to-store-and-query-embeddings-in-postgresql-without-losing-your-mind) for moderate-scale pgvector deployments.

### Table Schema Pattern

Every table with semantic search gets these standard columns:

```sql
-- Standard embedding columns (on each searchable table)
embedding      vector(768) NOT NULL,     -- Google text-embedding-004
content_hash   TEXT,                      -- SHA-256 of embedded content (dedup/cache)
embedded_at    TIMESTAMPTZ DEFAULT NOW(), -- when embedding was generated
```

Plus table-specific columns. Example for `thoughts`:

```sql
CREATE TABLE thoughts (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  content       TEXT NOT NULL,
  tags          TEXT[] DEFAULT '{}',
  source        TEXT DEFAULT 'manual',    -- 'claude-code', 'discord', 'n8n', etc.
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW(),
  embedding     vector(768) NOT NULL,
  content_hash  TEXT,
  embedded_at   TIMESTAMPTZ DEFAULT NOW()
);
```

### Index Strategy

Use HNSW with cosine distance for all tables. Configuration for 768-dim vectors:

```sql
CREATE INDEX idx_thoughts_embedding ON thoughts
  USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 200);
```

- **m = 16**: Default, sweet spot for 768-dim. Don't touch unless benchmarking.
- **ef_construction = 200**: Higher than default (100) for better graph quality. Build time is negligible at this scale.
- **vector_cosine_ops**: Matches cosine similarity, which is standard for text embeddings.
- **ef_search = 40** (runtime default): Fine for <100K vectors. Bump to 100 if recall drops.

HNSW indexes can be created on empty tables (unlike IVFFlat) -- safe to create at migration time. New inserts automatically maintain the index.

**Confidence:** HIGH -- HNSW configuration is well-documented by [Crunchy Data](https://www.crunchydata.com/blog/hnsw-indexes-with-postgres-and-pgvector) and [Supabase](https://supabase.com/docs/guides/ai/vector-indexes/hnsw-indexes).

---

## 3. Embedding Pipeline

### Recommended: Synchronous Inline with Graceful Degradation

For Open Brain's use case -- low-volume writes (tens to hundreds per day, not thousands per second) -- inline embedding is the right choice.

**Pattern:**

```
Client -> MCP tool call (log_thought) -> Generate embedding via LiteLLM -> INSERT with vector -> Return success
```

**Why inline, not async/queue:**

- **Volume is low.** Open Brain captures thoughts, decisions, and session summaries -- at most a few hundred per day. No need for a queue.
- **Immediate searchability matters.** A thought logged should be searchable within the same session. Async introduces eventual consistency.
- **Simpler architecture.** No queue (pgmq, SQS), no cron workers, no visibility timeout management. The embedding API call adds ~100-200ms latency -- acceptable for tool calls.
- **LiteLLM is local.** The embedding endpoint is on the LAN (LiteLLM proxy), not a remote API with rate limits. Latency is predictable.

**Graceful degradation on embedding failure:**

```typescript
async function embedAndInsert(table: string, content: string, row: Record<string, unknown>) {
  try {
    const embedding = await generateEmbedding(content);
    await db.query(
      `INSERT INTO ${table} (..., embedding, content_hash) VALUES (...)`,
      [...values, embedding, sha256(content)]
    );
  } catch (embeddingError) {
    // Insert WITHOUT embedding -- data is not lost
    // Mark for retry with a null embedding
    await db.query(
      `INSERT INTO ${table} (..., embedding, content_hash) VALUES (...)`,
      [...values, null, null]
    );
    logger.warn(`Embedding failed for ${table}, inserted without vector`, embeddingError);
  }
}
```

**Backfill mechanism:** A simple script (or n8n workflow) periodically queries for `WHERE embedding IS NULL` rows and retries embedding generation. This handles transient LiteLLM failures without blocking the write path.

```sql
-- Find un-embedded rows across all tables
SELECT 'thoughts' AS source, id, content FROM thoughts WHERE embedding IS NULL
UNION ALL
SELECT 'decisions', id, title || ' ' || rationale FROM decisions WHERE embedding IS NULL
-- ...
```

**Content hashing for dedup:** Before calling the embedding API, check if `content_hash` already exists (same content was embedded before). Skip the API call and reuse the existing vector. Saves API calls on duplicate inserts.

**Confidence:** HIGH for the inline pattern at this scale. The async/queue pattern is better for high-volume ingest (1000+ writes/minute) but adds unnecessary complexity here.

---

## 4. Role-Based Auth via Bearer Tokens

### Recommended: Static Token Map with Middleware Validation

For a single-user PAI system with a handful of known consumers, full OAuth 2.1 is overkill. Use pre-shared Bearer tokens with a role mapping.

**Token-to-role mapping (stored in .env, loaded at startup):**

```
AUTH_TOKEN_ADMIN=<token1>          # Full access (Claude Code, manual)
AUTH_TOKEN_AGENT=<token2>          # Read all, write thoughts/decisions/sessions
AUTH_TOKEN_DISCORD=<token3>        # Write thoughts only, read nothing
AUTH_TOKEN_N8N=<token4>            # Full access (workflow automation)
AUTH_TOKEN_READONLY=<token5>       # Read-only (dashboards, monitoring)
```

**Role permission matrix:**

| Role | thoughts | decisions | relationships | projects | sessions | search_brain |
|------|----------|-----------|---------------|----------|----------|-------------|
| admin | RW | RW | RW | RW | RW | R |
| agent | RW | RW | R | R | RW | R |
| discord | W | - | - | - | - | - |
| n8n | RW | RW | RW | RW | RW | R |
| readonly | R | R | R | R | R | R |

**Middleware implementation:**

```typescript
interface AuthContext {
  role: 'admin' | 'agent' | 'discord' | 'n8n' | 'readonly';
  tokenId: string;
}

const TOKEN_ROLES: Record<string, AuthContext> = {
  [process.env.AUTH_TOKEN_ADMIN!]: { role: 'admin', tokenId: 'admin' },
  [process.env.AUTH_TOKEN_AGENT!]: { role: 'agent', tokenId: 'agent' },
  // ...
};

function authMiddleware(req: Request, res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing Bearer token' });
  }
  const token = header.slice(7);
  const auth = TOKEN_ROLES[token];
  if (!auth) {
    return res.status(403).json({ error: 'Invalid token' });
  }
  (req as any).auth = auth;
  next();
}
```

**Per-tool permission check:** Each MCP tool handler checks the role before executing:

```typescript
server.tool('log_decision', schema, async (params, extra) => {
  const auth = getAuthFromRequest(extra);
  if (!canWrite(auth.role, 'decisions')) {
    return { content: [{ type: 'text', text: 'Permission denied: cannot write decisions' }] };
  }
  // ... proceed
});
```

**Why not JWT/OAuth:** This is a single-user system with known consumers. Pre-shared tokens are simpler, debuggable, and sufficient. If Open Brain ever opens to multi-user, migrate to JWT with scopes. For now, YAGNI.

**Security notes:**
- Tokens stored in `.env` (gitignored), loaded via `process.env`
- Never log Authorization headers or token values
- Use constant-time comparison for token validation (prevent timing attacks)
- Return 401 for missing token, 403 for invalid/insufficient permissions

**Confidence:** HIGH -- this is a standard pattern for internal services with known consumers. The [MCP auth docs](https://modelcontextprotocol.io/docs/tutorials/security/authorization) recommend OAuth 2.1 for public-facing servers, but explicitly note simpler approaches work for controlled environments.

---

## 5. Connection Pooling

### Recommended: Conservative Pool with Shared-Instance Awareness

Open Brain shares the PostgreSQL instance at 10.71.20.49 with n8n. The pool must be conservative to avoid starving n8n of connections.

**Configuration:**

```typescript
import { Pool } from 'pg';

const pool = new Pool({
  host: process.env.DB_HOST,           // 10.71.20.49
  port: parseInt(process.env.DB_PORT || '5432'),
  database: 'open_brain',             // Separate database from n8n
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  max: 10,                            // Conservative -- shared instance
  idleTimeoutMillis: 30000,           // 30s idle timeout
  connectionTimeoutMillis: 5000,      // 5s connect timeout
  maxUses: 7500,                      // Recycle connections periodically
});
```

**Why max = 10:**

- Default PostgreSQL `max_connections` = 100
- n8n likely uses 10-20 connections under load
- System/maintenance connections reserve ~5
- That leaves ~65-75 for other consumers
- Open Brain's workload is low-throughput (tool calls, not high-concurrency API)
- 10 connections provides plenty of headroom with a safety margin

**Pool health monitoring:**

```typescript
// Expose in /health endpoint
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    pool: {
      total: pool.totalCount,
      idle: pool.idleCount,
      waiting: pool.waitingCount,
    },
  });
});
```

**Error handling:**

```typescript
pool.on('error', (err) => {
  // Don't crash -- log and let the pool reconnect
  logger.error('Unexpected pool error', err);
});
```

**Pattern for queries:** Always use `pool.query()` for simple queries (auto-acquires and releases). Use `pool.connect()` + manual release only for transactions:

```typescript
// Simple query -- pool manages connection
const result = await pool.query('SELECT * FROM thoughts WHERE id = $1', [id]);

// Transaction -- manual connection management
const client = await pool.connect();
try {
  await client.query('BEGIN');
  await client.query('INSERT INTO thoughts ...', [...]);
  await client.query('COMMIT');
} catch (err) {
  await client.query('ROLLBACK');
  throw err;
} finally {
  client.release(); // CRITICAL: always release
}
```

**Confidence:** HIGH -- [node-postgres pool docs](https://node-postgres.com/apis/pool) are authoritative. The sizing calculation follows the standard formula: `(max_connections - reserved) / num_apps`.

---

## 6. Project File Structure

### Recommended Layout

```
open-brain/
  +-- src/
  |   +-- index.ts              # Entry point: Express app setup, server start
  |   +-- server.ts             # McpServer creation, tool/resource registration
  |   +-- transport.ts          # Session management, transport map, dispatch
  |   +-- auth.ts               # Bearer token middleware, role definitions
  |   +-- db/
  |   |   +-- pool.ts           # pg Pool setup, health check
  |   |   +-- migrations/       # SQL migration files (001_init.sql, etc.)
  |   |   +-- queries.ts        # Parameterized query builders
  |   +-- tools/
  |   |   +-- search-brain.ts   # search_brain: cross-table semantic search
  |   |   +-- log-thought.ts    # log_thought: insert thought + embedding
  |   |   +-- log-decision.ts   # log_decision: insert decision + embedding
  |   |   +-- find-person.ts    # find_person: relationship lookup
  |   |   +-- session-save.ts   # session_save: write session summary
  |   |   +-- session-load.ts   # session_load: read latest session
  |   +-- embedding.ts          # LiteLLM embedding client, content hashing
  |   +-- permissions.ts        # Role-to-permission mapping, canRead/canWrite
  |   +-- types.ts              # Shared TypeScript types
  |   +-- logger.ts             # Structured logging setup
  +-- scripts/
  |   +-- backfill-embeddings.ts  # Retry failed embeddings
  |   +-- migrate.ts              # Run SQL migrations
  +-- .env.example              # Template for required env vars
  +-- .env                      # Actual secrets (gitignored)
  +-- .gitignore
  +-- package.json
  +-- tsconfig.json
  +-- bunfig.toml               # Bun configuration (if needed)
```

**Design principles:**

- **One tool per file** in `tools/`. Each file exports a function that registers the tool on the McpServer. This keeps files well under the 750-line limit and makes each tool independently reviewable.
- **`db/` is a boundary.** All database access goes through `db/pool.ts` (connection) and `db/queries.ts` (parameterized queries). Tools never import `pg` directly.
- **`embedding.ts` is a service.** Isolates the LiteLLM API call, content hashing, and failure handling. Tools call `generateEmbedding(text)` without knowing the API details.
- **`auth.ts` + `permissions.ts` are separate.** Auth handles token validation (middleware). Permissions handles role-to-table access checks (used inside tools).
- **Migrations are plain SQL.** No ORM, no migration framework. Numbered files (`001_init.sql`, `002_add_warmth_score.sql`) executed in order by `scripts/migrate.ts`. PostgreSQL + pgvector doesn't need Prisma's abstraction layer.

**Entry point flow:**

```
index.ts
  -> creates Express app
  -> applies middleware (json, auth)
  -> creates McpServer (server.ts)
  -> registers all tools (tools/*.ts)
  -> sets up transport dispatch (transport.ts)
  -> starts listening on port 3100
```

**Confidence:** HIGH -- this follows Bun + Express conventions and keeps files focused. The one-tool-per-file pattern is standard for MCP servers with multiple tools.

---

## Anti-Patterns to Avoid

### 1. God Tool File
**What:** Putting all tool handlers in a single file.
**Why bad:** Exceeds 750-line limit fast, impossible to review, merge conflicts.
**Instead:** One file per tool in `tools/`.

### 2. Direct Pool Access in Tools
**What:** Importing `pg` Pool directly in tool handlers.
**Why bad:** No query reuse, no consistent error handling, hard to mock for tests.
**Instead:** Centralize queries in `db/queries.ts`.

### 3. OAuth for Internal Services
**What:** Implementing full OAuth 2.1 for a single-user system with known consumers.
**Why bad:** Weeks of work for zero security benefit over pre-shared tokens in this context.
**Instead:** Static Bearer tokens with role mapping. Migrate to OAuth only if multi-user.

### 4. Unified Embeddings Table at This Scale
**What:** Premature abstraction into a single polymorphic embeddings table.
**Why bad:** Adds partitioning complexity, polymorphic JOINs, and doesn't help at <100K vectors.
**Instead:** Per-table vectors with UNION ALL in the search layer.

### 5. Async Embedding Queue at This Volume
**What:** Building a pgmq/SQS queue for embedding generation.
**Why bad:** Over-engineering for tens of writes per day. Introduces eventual consistency without benefit.
**Instead:** Inline embedding with graceful degradation (insert without vector on failure, backfill later).

### 6. Stateless Transport
**What:** Using `sessionIdGenerator: undefined` for every request.
**Why bad:** Creates and tears down a transport + server connection per request. Wasteful on a single-node deployment.
**Instead:** Stateful sessions with transport map. Reuse transports across tool calls from the same consumer.

---

## Data Flow Diagram

```
                         +------------------+
                         |   Consumers      |
                         |  Claude Code     |
                         |  OpenClaw Agent  |
                         |  Discord Bot     |
                         |  n8n Workflows   |
                         |  mcp2cli         |
                         +--------+---------+
                                  |
                         Bearer Token + JSON-RPC
                                  |
                         +--------v---------+
                         |  Express Server   |
                         |  (port 3100)      |
                         |                   |
                         |  Auth Middleware   |
                         |  Session Dispatch  |
                         +--------+---------+
                                  |
                         +--------v---------+
                         |  McpServer        |
                         |  (singleton)      |
                         |                   |
                         |  Tools:           |
                         |  - search_brain   |
                         |  - log_thought    |
                         |  - log_decision   |
                         |  - find_person    |
                         |  - session_save   |
                         |  - session_load   |
                         +--------+---------+
                                  |
                    +-------------+-------------+
                    |                             |
           +--------v---------+         +--------v---------+
           |  pg Pool (max=10) |         |  LiteLLM Proxy   |
           |  -> open_brain DB |         |  (embeddings)     |
           |  PostgreSQL       |         |  text-embedding-  |
           |  + pgvector       |         |  004 (768-dim)    |
           |  (10.71.20.49)    |         |                   |
           +-------------------+         +-------------------+
```

---

## Scalability Considerations

| Concern | Current (< 1K vectors) | At 100K vectors | At 1M vectors |
|---------|----------------------|-----------------|---------------|
| Search latency | <10ms (sequential scan fine) | <50ms with HNSW | <100ms, may need ef_search tuning |
| Embedding latency | ~150ms inline (LiteLLM local) | Same per-insert | Consider batch for bulk imports |
| Connection pool | max=10 is plenty | Still fine | Evaluate PgBouncer |
| Index size | Negligible | ~200MB per table | ~2GB per table, monitor disk |
| Cross-table search | 5 CTEs, fast | 5 CTEs, still fast | Consider materialized view for hot queries |
| Schema approach | Per-table vectors | Per-table vectors still correct | Evaluate unified + partitioning |

---

## Sources

- [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk) -- official SDK, Express middleware, transport patterns
- [express-mcp-handler](https://github.com/jhgaylor/express-mcp-handler) -- community Express middleware with stateful/stateless/SSE handlers
- [Streamable HTTP Complete Intro](https://mcp.holt.courses/lessons/sses-and-streaming-html/streamable-http) -- transport explanation and migration from SSE
- [Why MCP Deprecated SSE](https://blog.fka.dev/blog/2025-06-06-why-mcp-deprecated-sse-and-go-with-streamable-http/) -- rationale for Streamable HTTP
- [pgvector GitHub](https://github.com/pgvector/pgvector) -- official pgvector extension
- [Cross-table vector search (Microsoft Q&A)](https://learn.microsoft.com/en-us/answers/questions/2118689/how-to-search-across-multiple-vector-indexes-in-po) -- CTE + UNION ALL pattern
- [Storing embeddings without losing your mind](https://www.postgresql.fastware.com/blog/how-to-store-and-query-embeddings-in-postgresql-without-losing-your-mind) -- schema design, chunking, versioning
- [HNSW Indexes (Crunchy Data)](https://www.crunchydata.com/blog/hnsw-indexes-with-postgres-and-pgvector) -- HNSW configuration best practices
- [HNSW Indexes (Supabase)](https://supabase.com/docs/guides/ai/vector-indexes/hnsw-indexes) -- ef_search tuning, partial indexes
- [node-postgres Pool](https://node-postgres.com/apis/pool) -- pool configuration, lifecycle, error handling
- [MCP Authorization Tutorial](https://modelcontextprotocol.io/docs/tutorials/security/authorization) -- official auth patterns (OAuth 2.1 for public, simpler for internal)
- [MCP Auth Discussion](https://github.com/modelcontextprotocol/modelcontextprotocol/discussions/1247) -- community patterns for Bearer token auth
- [Supabase Automatic Embeddings](https://supabase.com/docs/guides/ai/automatic-embeddings) -- pgmq-based async embedding pipeline (reference for backfill pattern)
- [pgvector 2026 Guide (Instaclustr)](https://www.instaclustr.com/education/vector-database/pgvector-key-features-tutorial-and-pros-and-cons-2026-guide/) -- current feature set and limitations
