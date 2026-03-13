# Phase 1: Foundation - Research

**Researched:** 2026-03-13
**Domain:** MCP server infrastructure -- PostgreSQL/pgvector schema, HTTP transport, auth, embedding pipeline
**Confidence:** HIGH

## Summary

Phase 1 builds the entire infrastructure layer for Open Brain: a PostgreSQL database with pgvector-backed vector columns and HNSW indexes, an MCP server over HTTP with session-aware transport, Bearer token auth with role-based permissions, and an embedding pipeline via LiteLLM proxy. This is greenfield -- no existing source code, no package.json, no project skeleton.

The ecosystem research (`.planning/research/`) already covers the stack comprehensively at HIGH confidence. This phase-level research validates specific implementation patterns the planner needs: the exact auth context flow from Express middleware into MCP tool handlers (via `req.auth` -> `authInfo`), the correct operator class for halfvec HNSW indexes (`halfvec_cosine_ops`, NOT `vector_cosine_ops`), the constant-time token comparison pattern, and the test infrastructure setup for `bun:test` with PostgreSQL.

**Primary recommendation:** Follow the patterns from the ecosystem research exactly. The one significant correction is the halfvec operator class -- the architecture.md examples show `vector_cosine_ops` which is wrong for halfvec columns. Use `halfvec_cosine_ops`.

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|-----------------|
| DB-01 | PostgreSQL + pgvector database with 5 tables (thoughts, decisions, relationships, projects, sessions) | Schema design in architecture.md, halfvec operator class correction, HNSW config, migration pattern |
| DB-02 | 768-dim vector embeddings via gemini-embedding-001 through LiteLLM (outputDimensionality: 768) | Embedding pipeline pattern, LiteLLM integration, graceful degradation, content hash dedup |
| SRV-01 | MCP server with HTTP transport (StreamableHTTPServerTransport) + Bearer token auth | Singleton server + per-session transport map, Express middleware chain, v1.x SDK imports |
| AUTH-01 | Role-based auth -- different tokens grant different write permissions per table | req.auth -> authInfo flow, custom verification function, permission matrix, timingSafeEqual |
| DATA-02 | Projects table as secondary store alongside .planning/ (gradual migration path) | Table schema with standard embedding columns, fields matching .planning/ metadata |
</phase_requirements>

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| @modelcontextprotocol/sdk | ^1.27.0 (v1.x) | MCP server + transport | Official SDK, v2 is pre-alpha, v1 gets fixes 6+ months after v2 ships |
| express | ^4.x | HTTP framework | MCP SDK examples use it, middleware ecosystem, path of least resistance |
| pg | ^8.x | PostgreSQL client | Battle-tested, full pgvector type support, well-documented Pool API |
| pgvector | ^0.2.1 | pgvector type support for pg | registerTypes, toSql, halfvec auto-parsing -- official companion to pg |
| zod | ^3.25+ | Schema validation | MCP SDK peer dependency, used for tool parameter schemas |
| cors | ^2.x | CORS middleware | Multi-consumer access (Claude Code, mcp2cli, n8n) |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| @mcp-auth/mcp-auth | latest | Bearer auth middleware | Custom token verification -> req.auth -> authInfo in tool handlers |
| typescript | ^5.x | Type checking | Dev dependency, Bun runs TS natively but tsc for CI typecheck |
| @types/express | latest | Express type defs | Dev dependency |
| @types/pg | latest | pg type defs | Dev dependency |
| @types/cors | latest | cors type defs | Dev dependency |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| Express | Bun.serve() | Faster but no middleware ecosystem, diverges from MCP SDK examples |
| pg | postgres.js / Bun SQL | Newer but less mature pgvector integration, smaller community |
| @mcp-auth | Custom middleware | Simpler but misses req.auth -> authInfo auto-propagation to tool handlers |
| Drizzle/Prisma | raw SQL | ORM is overkill for 5 tables with simple parameterized queries |

**Installation:**
```bash
bun add express @modelcontextprotocol/sdk zod pg pgvector cors
bun add -d typescript @types/express @types/pg @types/cors
```

**Note on @mcp-auth:** Evaluate whether the `@mcp-auth/mcp-auth` package adds value over a manual `req.auth` assignment. If the SDK's transport layer reads `req.auth` and passes it as `authInfo` automatically, the simplest approach is to set `req.auth` directly in custom Express middleware without pulling in the mcp-auth package. Test this during implementation -- if `req.auth` propagation works without mcp-auth, skip the dependency.

## Architecture Patterns

### Recommended Project Structure
```
open-brain/
  src/
    index.ts              # Entry point: Express app, middleware, listen
    server.ts             # McpServer creation, tool registration orchestration
    transport.ts          # Session map, transport dispatch (POST/GET/DELETE /mcp)
    auth.ts               # Bearer token middleware, token-to-role map, timingSafeEqual
    permissions.ts        # Role-permission matrix, canRead/canWrite checks
    embedding.ts          # LiteLLM client, content hashing, timeout, graceful degradation
    logger.ts             # Structured JSON logging setup
    types.ts              # Shared TypeScript types (AuthContext, Role, etc.)
    db/
      pool.ts             # pg Pool setup, pgvector registerTypes, health check
      queries.ts          # Parameterized query builders (insert, search, etc.)
      migrate.ts          # SQL migration runner
      migrations/
        001_init.sql      # All 5 tables, extensions, indexes
    tools/                # One file per tool (Phase 2+, but structure created now)
  scripts/
    migrate.ts            # CLI entry point for running migrations
  .env.example            # Template for all required env vars
  .env                    # Actual secrets (gitignored)
  package.json
  tsconfig.json
  bunfig.toml             # Test config, coverage thresholds
```

### Pattern 1: Singleton McpServer + Per-Session Transport Map (Stateful)

**What:** One `McpServer` owns all tool definitions. Per-request `StreamableHTTPServerTransport` instances manage client sessions via a Map keyed by session ID.

**When to use:** Always for Open Brain. Consumers (Claude Code, n8n) issue multiple tool calls per session.

**Example:**
```typescript
// Source: MCP TypeScript SDK docs + Koyeb tutorial
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { randomUUID } from "node:crypto";

const server = new McpServer({ name: "open-brain", version: "1.0.0" });
const transports: Record<string, StreamableHTTPServerTransport> = {};

app.post("/mcp", authMiddleware, async (req, res) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;

  if (sessionId && transports[sessionId]) {
    await transports[sessionId].handleRequest(req, res, req.body);
    return;
  }

  if (!sessionId && isInitializeRequest(req.body)) {
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => { transports[id] = transport; },
    });
    transport.onclose = () => { delete transports[transport.sessionId!]; };
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
    return;
  }

  res.status(400).json({ error: "Bad request: missing session or not initialize" });
});

// GET /mcp for SSE streaming (server-to-client notifications)
app.get("/mcp", authMiddleware, async (req, res) => {
  const sessionId = req.headers["mcp-session-id"] as string;
  if (!sessionId || !transports[sessionId]) {
    return res.status(400).json({ error: "Invalid session" });
  }
  await transports[sessionId].handleRequest(req, res);
});

// DELETE /mcp for session teardown
app.delete("/mcp", async (req, res) => {
  const sessionId = req.headers["mcp-session-id"] as string;
  if (sessionId && transports[sessionId]) {
    await transports[sessionId].close();
    delete transports[sessionId];
  }
  res.status(200).end();
});
```

### Pattern 2: Auth Context Flow (req.auth -> authInfo in Tool Handlers)

**What:** Express middleware validates Bearer token, sets `req.auth` with role info. The MCP SDK's transport layer automatically propagates `req.auth` as `authInfo` into tool handler callbacks.

**When to use:** Every authenticated endpoint.

**Example:**
```typescript
// Source: mcp-auth.dev docs, MCP SDK server.md
import { timingSafeEqual } from "node:crypto";

interface AuthInfo {
  role: "admin" | "agent" | "discord" | "n8n" | "readonly";
  clientId: string;
}

// Token map loaded from environment
const TOKEN_MAP: Record<string, AuthInfo> = {};
// Populated at startup from process.env.AUTH_TOKEN_*

function verifyToken(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.byteLength !== b.byteLength) {
    timingSafeEqual(a, a); // constant time even on length mismatch
    return false;
  }
  return timingSafeEqual(a, b);
}

function authMiddleware(req: Request, res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Missing Bearer token" });
  }
  const token = header.slice(7);

  // Constant-time lookup: check all tokens
  let matched: AuthInfo | null = null;
  for (const [knownToken, info] of Object.entries(TOKEN_MAP)) {
    if (verifyToken(token, knownToken)) {
      matched = info;
      break;
    }
  }

  if (!matched) {
    return res.status(401).json({ error: "Invalid token" });
  }

  // Set req.auth -- SDK propagates this as authInfo to tool handlers
  (req as any).auth = matched;
  next();
}

// In tool handler -- authInfo is available via context
server.registerTool("log_thought", { ... }, ({ authInfo }) => {
  if (!canWrite(authInfo.role, "thoughts")) {
    return { content: [{ type: "text", text: "Permission denied" }] };
  }
  // ... proceed
});
```

**IMPORTANT caveat:** The `req.auth` -> `authInfo` propagation depends on the SDK transport reading it. If this does not work out of the box with v1.27.x (it may be a v2 or mcp-auth-specific feature), the fallback is a session-keyed context store: middleware writes auth context to a `Map<sessionId, AuthInfo>`, and tool handlers read from it using the session ID available in the tool context. Test this during implementation.

### Pattern 3: Embedding Pipeline with Graceful Degradation

**What:** Inline embedding via LiteLLM on insert. On failure, store NULL embedding and log for backfill.

**When to use:** Every insert to a table with an embedding column.

**Example:**
```typescript
// Source: architecture.md, concerns.md
import { createHash } from "node:crypto";

const EMBEDDING_TIMEOUT_MS = 5000;
const LITELLM_URL = process.env.LITELLM_URL; // e.g., http://10.71.20.53:4000

async function generateEmbedding(text: string): Promise<number[] | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), EMBEDDING_TIMEOUT_MS);

  try {
    const response = await fetch(`${LITELLM_URL}/embeddings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "embeddings", // LiteLLM alias
        input: text,
        dimensions: 768,
      }),
      signal: controller.signal,
    });

    if (!response.ok) throw new Error(`LiteLLM ${response.status}`);
    const data = await response.json();
    return data.data[0].embedding;
  } catch (err) {
    // Log but don't throw -- graceful degradation
    logger.warn("Embedding generation failed", { error: err });
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

function contentHash(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}
```

### Anti-Patterns to Avoid
- **Wrong halfvec operator class:** Using `vector_cosine_ops` with `halfvec` columns silently falls back to sequential scan. MUST use `halfvec_cosine_ops`.
- **God tool file:** All tools in one file. Use one file per tool in `tools/`.
- **Direct pool access in tools:** Import pg Pool in tool handlers. Route all DB access through `db/queries.ts`.
- **OAuth for this use case:** Full OAuth 2.1 for a single-user system with 5 known consumers. Static Bearer tokens with role map are sufficient.
- **REPEATABLE READ with vector search:** HNSW breaks MVCC immutability -- use READ COMMITTED (the default).
- **Async embedding queue at this volume:** Over-engineering for tens of writes/day. Inline with graceful degradation is correct.
- **Stateless transport:** Creating/tearing down transport per request wastes resources on a single-node deployment.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| SQL migration framework | Custom migration runner with state tracking | Numbered SQL files + simple runner script | 5 tables, simple schema. Drizzle/Prisma/knex migrations are overkill. A ~50-line runner that reads `migrations/*.sql` in order and tracks applied migrations in a `_migrations` table is sufficient |
| Vector type serialization | Manual array-to-pgvector string conversion | `pgvector.toSql()` + `pgvector.registerTypes()` | Handles all type parsing, including halfvec auto-cast |
| Constant-time comparison | Manual byte-by-byte comparison | `crypto.timingSafeEqual()` from `node:crypto` | Bun supports this natively, handles timing attack prevention correctly |
| Content deduplication | Custom dedup logic with timestamps | SHA-256 content hash with unique constraint | `content_hash TEXT UNIQUE` on each table. Let PostgreSQL enforce it |
| Health check connectivity | Custom TCP probes | `pool.query('SELECT 1')` + `fetch(litellm/health)` | pg Pool handles connection lifecycle; LiteLLM has a health endpoint |

**Key insight:** The complexity budget for Phase 1 should go into getting the auth context flow and embedding pipeline right, not into building infrastructure that already exists as standard library functions.

## Common Pitfalls

### Pitfall 1: halfvec Operator Class Mismatch
**What goes wrong:** Creating an HNSW index with `vector_cosine_ops` on a `halfvec(768)` column. PostgreSQL silently falls back to sequential scan -- no error, just catastrophically slow queries.
**Why it happens:** The architecture.md examples show `vector_cosine_ops` which is correct for `vector` type but wrong for `halfvec`.
**How to avoid:** Always use `halfvec_cosine_ops` for halfvec columns. The operator class MUST match both the column type AND the distance function.
**Warning signs:** EXPLAIN ANALYZE shows "Seq Scan" instead of "Index Scan using hnsw".

### Pitfall 2: req.auth Not Propagating to authInfo
**What goes wrong:** Setting `req.auth` in middleware but tool handlers receive `undefined` for `authInfo`.
**Why it happens:** The `req.auth` -> `authInfo` propagation may be a feature of `@mcp-auth` middleware or MCP SDK v2, not necessarily present in vanilla v1.27.x `StreamableHTTPServerTransport`.
**How to avoid:** Test auth propagation early. Fallback: use a session-keyed context store (`Map<string, AuthInfo>`) populated from middleware, read from tool handlers via session ID.
**Warning signs:** `authInfo` is `undefined` in tool handler despite middleware setting `req.auth`.

### Pitfall 3: pgvector registerTypes Not Called Per Connection
**What goes wrong:** Vector columns return raw strings instead of parsed arrays, or inserts fail with type errors.
**Why it happens:** `registerTypes` must be called on each new connection from the pool, not just once at startup.
**How to avoid:** Use the pool's `connect` event: `pool.on("connect", async (client) => { await pgvector.registerTypes(client); })`.
**Warning signs:** Results contain `"[0.123,0.456,...]"` as strings instead of `number[]` arrays.

### Pitfall 4: Embedding Timeout Not Set
**What goes wrong:** LiteLLM response latency spikes to 30-45 seconds, holding pool connections and blocking other requests.
**Why it happens:** Google embedding API has documented daily performance degradation windows.
**How to avoid:** Hard 5-second AbortController timeout on all LiteLLM fetch calls. On timeout, store NULL embedding and log for backfill.
**Warning signs:** Increasing pool `waitingCount` in health check, slow tool responses.

### Pitfall 5: Connection Pool Too Large on Shared Instance
**What goes wrong:** Open Brain claims too many connections, starving n8n's PostgreSQL access.
**Why it happens:** Default PostgreSQL `max_connections` is 100. If Open Brain uses 30+ and n8n uses 30+, headroom disappears.
**How to avoid:** Set `max: 10` in pg Pool config. Also set `ALTER DATABASE open_brain CONNECTION LIMIT 20;` at the database level.
**Warning signs:** n8n workflow failures with "too many connections" errors.

### Pitfall 6: MCP SDK v2 Imports
**What goes wrong:** Import from `@modelcontextprotocol/server` or `@modelcontextprotocol/node` (v2 packages) instead of `@modelcontextprotocol/sdk/server/mcp.js` (v1.x).
**Why it happens:** The SDK's main branch now contains v2 code. Docs/examples may reference v2 imports.
**How to avoid:** Pin `@modelcontextprotocol/sdk@^1.27.0`. All imports use the `@modelcontextprotocol/sdk/...` path pattern.
**Warning signs:** `Module not found` errors, or behavior differences from what v1.x docs describe.

## Code Examples

Verified patterns from official sources:

### Database Schema (001_init.sql)
```sql
-- Source: pgvector GitHub, architecture.md (corrected for halfvec)
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Thoughts table
CREATE TABLE thoughts (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  content       TEXT NOT NULL,
  tags          TEXT[] DEFAULT '{}',
  source        TEXT DEFAULT 'manual',
  created_by    TEXT NOT NULL,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW(),
  embedding     halfvec(768),
  content_hash  TEXT,
  embedded_at   TIMESTAMPTZ,
  embedding_model TEXT
);

CREATE INDEX idx_thoughts_embedding ON thoughts
  USING hnsw (embedding halfvec_cosine_ops)
  WITH (m = 16, ef_construction = 200);

CREATE UNIQUE INDEX idx_thoughts_content_hash ON thoughts (content_hash)
  WHERE content_hash IS NOT NULL;

-- Decisions table
CREATE TABLE decisions (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title         TEXT NOT NULL,
  rationale     TEXT NOT NULL,
  alternatives  JSONB DEFAULT '[]',
  tags          TEXT[] DEFAULT '{}',
  context       TEXT,
  created_by    TEXT NOT NULL,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW(),
  embedding     halfvec(768),
  content_hash  TEXT,
  embedded_at   TIMESTAMPTZ,
  embedding_model TEXT
);

CREATE INDEX idx_decisions_embedding ON decisions
  USING hnsw (embedding halfvec_cosine_ops)
  WITH (m = 16, ef_construction = 200);

-- Relationships table
CREATE TABLE relationships (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  person_name   TEXT NOT NULL,
  context       TEXT,
  warmth        INTEGER CHECK (warmth BETWEEN 1 AND 5),
  last_contact  DATE,
  notes         TEXT,
  tags          TEXT[] DEFAULT '{}',
  created_by    TEXT NOT NULL,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW(),
  embedding     halfvec(768),
  content_hash  TEXT,
  embedded_at   TIMESTAMPTZ,
  embedding_model TEXT
);

CREATE UNIQUE INDEX idx_relationships_person ON relationships (person_name);
CREATE INDEX idx_relationships_embedding ON relationships
  USING hnsw (embedding halfvec_cosine_ops)
  WITH (m = 16, ef_construction = 200);

-- Projects table (DATA-02: secondary store alongside .planning/)
CREATE TABLE projects (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name          TEXT NOT NULL,
  status        TEXT DEFAULT 'active',
  description   TEXT,
  tags          TEXT[] DEFAULT '{}',
  metadata      JSONB DEFAULT '{}',
  created_by    TEXT NOT NULL,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW(),
  embedding     halfvec(768),
  content_hash  TEXT,
  embedded_at   TIMESTAMPTZ,
  embedding_model TEXT
);

CREATE UNIQUE INDEX idx_projects_name ON projects (name);
CREATE INDEX idx_projects_embedding ON projects
  USING hnsw (embedding halfvec_cosine_ops)
  WITH (m = 16, ef_construction = 200);

-- Sessions table
CREATE TABLE sessions (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project       TEXT,
  summary       TEXT NOT NULL,
  tags          TEXT[] DEFAULT '{}',
  blockers      TEXT[] DEFAULT '{}',
  next_steps    TEXT[] DEFAULT '{}',
  key_decisions TEXT[] DEFAULT '{}',
  created_by    TEXT NOT NULL,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  embedding     halfvec(768),
  content_hash  TEXT,
  embedded_at   TIMESTAMPTZ,
  embedding_model TEXT
);

CREATE INDEX idx_sessions_project ON sessions (project, created_at DESC);
CREATE INDEX idx_sessions_embedding ON sessions
  USING hnsw (embedding halfvec_cosine_ops)
  WITH (m = 16, ef_construction = 200);

-- Migrations tracking table
CREATE TABLE _migrations (
  id            SERIAL PRIMARY KEY,
  filename      TEXT NOT NULL UNIQUE,
  applied_at    TIMESTAMPTZ DEFAULT NOW()
);

-- Database-level safety for shared instance
ALTER DATABASE open_brain SET statement_timeout = '30s';
```

### Connection Pool with pgvector Type Registration
```typescript
// Source: pgvector-node GitHub, node-postgres docs
import pg from "pg";
import pgvector from "pgvector/pg";

export function createPool(): pg.Pool {
  const pool = new pg.Pool({
    host: process.env.DB_HOST || "10.71.20.49",
    port: parseInt(process.env.DB_PORT || "5432"),
    database: process.env.DB_NAME || "open_brain",
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    max: 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
    maxUses: 7500,
  });

  // Register pgvector types on each new connection
  pool.on("connect", async (client) => {
    await pgvector.registerTypes(client);
  });

  pool.on("error", (err) => {
    logger.error("Unexpected pool error", { error: err.message });
  });

  return pool;
}

// Health check
export async function checkPoolHealth(pool: pg.Pool): Promise<{
  connected: boolean;
  total: number;
  idle: number;
  waiting: number;
}> {
  try {
    await pool.query("SELECT 1");
    return {
      connected: true,
      total: pool.totalCount,
      idle: pool.idleCount,
      waiting: pool.waitingCount,
    };
  } catch {
    return { connected: false, total: 0, idle: 0, waiting: 0 };
  }
}
```

### Health Endpoint
```typescript
// Source: concerns.md, architecture.md
app.get("/health", async (_req, res) => {
  const dbHealth = await checkPoolHealth(pool);
  let litellmOk = false;

  try {
    const resp = await fetch(`${process.env.LITELLM_URL}/health`, {
      signal: AbortSignal.timeout(3000),
    });
    litellmOk = resp.ok;
  } catch {
    litellmOk = false;
  }

  const status = dbHealth.connected && litellmOk ? "healthy" : "degraded";
  const code = status === "healthy" ? 200 : 503;

  res.status(code).json({
    status,
    database: dbHealth,
    litellm: { connected: litellmOk },
    timestamp: new Date().toISOString(),
  });
});
```

### Role Permission Matrix
```typescript
// Source: architecture.md auth section
type Role = "admin" | "agent" | "discord" | "n8n" | "readonly";
type Table = "thoughts" | "decisions" | "relationships" | "projects" | "sessions";
type Permission = "read" | "write";

const PERMISSIONS: Record<Role, Record<Table, Set<Permission>>> = {
  admin:    { thoughts: new Set(["read", "write"]), decisions: new Set(["read", "write"]), relationships: new Set(["read", "write"]), projects: new Set(["read", "write"]), sessions: new Set(["read", "write"]) },
  agent:    { thoughts: new Set(["read", "write"]), decisions: new Set(["read", "write"]), relationships: new Set(["read"]),          projects: new Set(["read"]),          sessions: new Set(["read", "write"]) },
  discord:  { thoughts: new Set(["write"]),         decisions: new Set([]),                relationships: new Set([]),                projects: new Set([]),                sessions: new Set([]) },
  n8n:      { thoughts: new Set(["read", "write"]), decisions: new Set(["read", "write"]), relationships: new Set(["read", "write"]), projects: new Set(["read", "write"]), sessions: new Set(["read", "write"]) },
  readonly: { thoughts: new Set(["read"]),          decisions: new Set(["read"]),          relationships: new Set(["read"]),          projects: new Set(["read"]),          sessions: new Set(["read"]) },
};

export function canWrite(role: Role, table: Table): boolean {
  return PERMISSIONS[role]?.[table]?.has("write") ?? false;
}

export function canRead(role: Role, table: Table): boolean {
  return PERMISSIONS[role]?.[table]?.has("read") ?? false;
}
```

### .env.example
```bash
# Database (shared PostgreSQL instance)
DB_HOST=10.71.20.49
DB_PORT=5432
DB_NAME=open_brain
DB_USER=open_brain
DB_PASSWORD=

# LiteLLM Proxy
LITELLM_URL=http://10.71.20.53:4000

# Server
PORT=3100

# Auth tokens (one per consumer)
AUTH_TOKEN_ADMIN=
AUTH_TOKEN_AGENT=
AUTH_TOKEN_DISCORD=
AUTH_TOKEN_N8N=
AUTH_TOKEN_READONLY=
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| SSE transport | StreamableHTTPServerTransport | MCP SDK 1.10+ (2025) | SSE deprecated, Streamable HTTP is the standard |
| text-embedding-004 | gemini-embedding-001 | 2026-01-14 | Old model returns 404. Must use new model with `dimensions: 768` |
| vector(768) | halfvec(768) | pgvector 0.7.0+ | 50% storage savings, negligible precision loss for text embeddings |
| IVFFlat indexes | HNSW indexes | pgvector 0.5.0+ | Better speed-recall tradeoff, no training step, handles dynamic data |
| Sequential scan for vectors | Iterative index scans | pgvector 0.8.0+ | 5.7x improvement for filtered queries (critical for multi-table search) |
| MCP SDK server.tool() | server.registerTool() | SDK v1.x | registerTool supports annotations, title, richer metadata |

**Deprecated/outdated:**
- `text-embedding-004`: Shut down 2026-01-14. Returns 404.
- SSE transport: Deprecated in MCP spec. Use Streamable HTTP.
- `@modelcontextprotocol/server`, `@modelcontextprotocol/node`, `@modelcontextprotocol/express`: v2 packages, pre-alpha. Do NOT install.
- `vector_cosine_ops` with halfvec columns: Wrong operator class. Use `halfvec_cosine_ops`.

## Open Questions

1. **Does `req.auth` auto-propagate to `authInfo` in MCP SDK v1.27.x?**
   - What we know: The `@mcp-auth` library and MCP SDK docs describe this flow. It works in some implementations.
   - What's unclear: Whether vanilla v1.27.x `StreamableHTTPServerTransport` reads `req.auth` and passes it to tool handlers, or if this requires `@mcp-auth` middleware specifically.
   - Recommendation: Test early in implementation. If it doesn't work, use a session-keyed `Map<string, AuthInfo>` as fallback. This is a ~20-line change, not a blocker.

2. **halfvec recall quality with gemini-embedding-001 embeddings**
   - What we know: halfvec saves 50% storage. For 768-dim text embeddings, precision loss is theoretically negligible.
   - What's unclear: No empirical test with actual gemini-embedding-001 embeddings has been done.
   - Recommendation: Use halfvec in the schema (the research consensus is strong). If recall issues surface, switching to `vector(768)` is a migration, not an architecture change.

3. **LiteLLM `task_type` passthrough**
   - What we know: Gemini-embedding-001 supports asymmetric embeddings (RETRIEVAL_QUERY vs RETRIEVAL_DOCUMENT). LiteLLM currently ignores `task_type` through the proxy (GitHub issue #17759).
   - What's unclear: Whether this has been fixed in recent LiteLLM releases.
   - Recommendation: Don't block on this. Symmetric embeddings work fine. Monitor the issue for future improvement.

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | bun:test (Bun built-in, Jest-compatible API) |
| Config file | bunfig.toml (Wave 0 -- needs creation) |
| Quick run command | `bun test` |
| Full suite command | `bun test --coverage` |

### Phase Requirements -> Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| DB-01 | 5 tables created with correct columns and indexes | integration | `bun test src/db/migrations/001_init.test.ts -x` | No -- Wave 0 |
| DB-02 | Embedding generation returns 768-dim vector, graceful NULL on failure | unit | `bun test src/embedding.test.ts -x` | No -- Wave 0 |
| SRV-01 | Server starts, GET /health returns DB+LiteLLM status, POST /mcp accepts requests | HTTP | `bun test src/server.test.ts -x` | No -- Wave 0 |
| AUTH-01 | 401 on missing token, 401 on invalid token, role correctly identified, permission matrix enforced | unit + HTTP | `bun test src/auth.test.ts -x` | No -- Wave 0 |
| DATA-02 | Projects table exists with name, status, tags, description, metadata fields | integration | `bun test src/db/migrations/001_init.test.ts -x` | No -- Wave 0 |

### Sampling Rate
- **Per task commit:** `bun test`
- **Per wave merge:** `bun test --coverage`
- **Phase gate:** Full suite green before `/gsd:verify-work`

### Wave 0 Gaps
- [ ] `bunfig.toml` -- test config with coverage thresholds (80% lines/functions/statements)
- [ ] `tsconfig.json` -- TypeScript configuration for Bun
- [ ] `src/db/migrations/001_init.test.ts` -- verify all 5 tables exist with correct columns, indexes, and constraints
- [ ] `src/embedding.test.ts` -- mock LiteLLM, verify 768-dim output, verify graceful NULL on failure, verify content hash
- [ ] `src/server.test.ts` -- start server on random port, test /health, test /mcp POST with auth
- [ ] `src/auth.test.ts` -- test token validation, role mapping, permission matrix, constant-time comparison
- [ ] `src/permissions.test.ts` -- test canRead/canWrite for all role x table combinations
- [ ] Pre-computed test embedding fixtures (768-dim vectors captured once from real API call)
- [ ] Test database setup: separate `open_brain_test` database or transaction rollback pattern

## Sources

### Primary (HIGH confidence)
- [pgvector GitHub](https://github.com/pgvector/pgvector) -- halfvec_cosine_ops operator class, HNSW config, iterative scans
- [pgvector-node GitHub](https://github.com/pgvector/pgvector-node) -- registerTypes, toSql, halfvec support
- [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk) -- v1.x imports, StreamableHTTPServerTransport, tool registration
- [MCP SDK server.md](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/server.md) -- registerTool API, transport patterns
- [node-postgres Pool](https://node-postgres.com/apis/pool) -- pool configuration, lifecycle, connect event
- [Bun test runner](https://bun.com/docs/test) -- Jest-compatible API, coverage, lifecycle hooks
- [crypto.timingSafeEqual](https://docs.deno.com/api/node/crypto/~/timingSafeEqual) -- constant-time comparison API

### Secondary (MEDIUM confidence)
- [mcp-auth.dev Bearer Auth](https://mcp-auth.dev/docs/configure-server/bearer-auth) -- req.auth -> authInfo flow pattern
- [Building MCP Server with Authentication](https://atlassc.net/2026/02/25/building-an-mcp-server-with-authentication) -- auth middleware patterns
- [Koyeb MCP Deployment](https://www.koyeb.com/tutorials/deploy-remote-mcp-servers-to-koyeb-using-streamable-http-transport) -- Express + StreamableHTTPServerTransport example
- [express-mcp-handler](https://github.com/jhgaylor/express-mcp-handler) -- session dispatch patterns
- [HNSW halfvec issue #835](https://github.com/pgvector/pgvector/issues/835) -- known planner issue with halfvec_ip_ops (not cosine)
- [Supabase HNSW docs](https://supabase.com/docs/guides/ai/vector-indexes/hnsw-indexes) -- HNSW configuration reference
- [MCP Auth Discussion #1247](https://github.com/modelcontextprotocol/modelcontextprotocol/discussions/1247) -- Bearer token patterns for MCP

### Tertiary (LOW confidence)
- None -- all critical findings verified with at least two sources

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH -- all libraries verified against npm registry, official docs, and ecosystem research
- Architecture: HIGH -- patterns sourced from MCP SDK docs, pgvector maintainers, production examples
- Auth flow: MEDIUM -- req.auth -> authInfo propagation needs runtime verification in v1.27.x
- Pitfalls: HIGH -- halfvec operator class confirmed across pgvector docs and GitHub issues

**Research date:** 2026-03-13
**Valid until:** 2026-04-13 (stable ecosystem, 30-day validity)
