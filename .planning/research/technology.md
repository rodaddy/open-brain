# Technology Ecosystem Research

**Project:** Open Brain
**Researched:** 2026-03-13
**Overall Confidence:** HIGH

---

## 1. pgvector (PostgreSQL Extension)

### Current Version
- **Extension:** pgvector 0.8.2 (released 2026-02-26, fixes CVE-2026-3172 buffer overflow in parallel HNSW builds)
- **Status:** Production-ready, 8M+ installs, top AI-native PostgreSQL extension
- **Confidence:** HIGH (official GitHub, PostgreSQL release notes)

### Key APIs for Open Brain

**Distance operators:**

| Operator | Function | Index Ops Class | Use Case |
|----------|----------|-----------------|----------|
| `<=>` | Cosine distance | `vector_cosine_ops` | **Use this.** Standard for text embeddings, ignores magnitude |
| `<->` | L2 (Euclidean) | `vector_l2_ops` | Physical/spatial data. Not appropriate here |
| `<#>` | Negative inner product | `vector_ip_ops` | Recommendation systems, normalized vectors |

**Recommendation:** Use cosine distance (`<=>`) with `vector_cosine_ops` indexes. This is the standard for semantic search with text embeddings. Most embedding models (including Google's) produce vectors where angular similarity is the meaningful metric.

**Critical gotcha:** Index operator class MUST match query operator. If your index uses `vector_cosine_ops` but your query uses `<->`, pgvector silently falls back to sequential scan -- no error, just catastrophically slow queries.

### Indexing Strategy: HNSW over IVFFlat

**Use HNSW.** For Open Brain's use case (semantic search, low latency, relatively small dataset):

| Factor | HNSW | IVFFlat |
|--------|------|---------|
| Query speed | 5,250x faster than seq scan | ~3,500x faster |
| Speed-recall tradeoff | Better (logarithmic scaling) | Worse (linear with probes) |
| Build time | Slower | Faster |
| Empty table index | Yes (no training step) | No (needs data first) |
| Memory | Higher | Lower |
| Best for | Production RAG, low-latency search | Batch workloads, very large datasets |

**HNSW tuning for 768 dimensions:**

```sql
-- Create index (do this AFTER initial data load for faster build)
CREATE INDEX ON thoughts USING hnsw (embedding vector_cosine_ops)
WITH (m = 16, ef_construction = 200);

-- Tune search quality at query time
SET hnsw.ef_search = 100;  -- Higher = better recall, slower

-- Enable iterative scans (new in 0.8.0) for filtered queries
SET hnsw.iterative_scan = on;
```

- `m = 16` -- default, sweet spot for 768-dim. Don't change without benchmarking
- `ef_construction = 200` -- bump from default 100 for production quality
- `ef_search = 100` -- good starting point, tune based on recall needs

**Build performance tips:**
```sql
SET maintenance_work_mem = '1GB';  -- Keep HNSW graph in memory during build
SET max_parallel_maintenance_workers = 7;  -- Parallelize index creation
```

### halfvec Optimization

**Use `halfvec(768)` instead of `vector(768)`.** Available since pgvector 0.7.0.

- 50% memory reduction (1,544 bytes vs 3,080 bytes per 768-dim vector)
- 50% smaller indexes -- fits more vectors in shared_buffers
- Negligible accuracy loss for text embeddings
- Faster index builds (up to 67x with binary quantization)
- No runtime penalty -- pages memory-mapped directly, no unpacking needed

```sql
CREATE TABLE thoughts (
    id bigserial PRIMARY KEY,
    content text NOT NULL,
    embedding halfvec(768),  -- NOT vector(768)
    created_at timestamptz DEFAULT now()
);
```

**Caveat:** Test with your actual embeddings first. For 768-dim text embeddings the precision loss is negligible, but verify before committing.

### pgvector 0.8.0+ Features Relevant to Open Brain

**Iterative index scans:** When combining vector search with WHERE clauses (e.g., searching only `thoughts` of a certain type, or within a date range), 0.8.0 automatically scans more of the index until enough results are found. Previous versions suffered from "overfiltering" -- returning fewer results than requested when filters excluded many candidates. This is significant for Open Brain since we filter by table/type.

**Performance:** Up to 5.7x query performance improvement over 0.7.4 for filtered queries.

### Version Pinning
- Pin to pgvector >= 0.8.0 (iterative scans are essential for filtered multi-table search)
- Current 0.8.2 recommended (security fix)

### Sources
- [pgvector GitHub](https://github.com/pgvector/pgvector)
- [pgvector 0.8.0 Release](https://www.postgresql.org/about/news/pgvector-080-released-2952/)
- [AWS HNSW vs IVFFlat Deep Dive](https://aws.amazon.com/blogs/database/optimize-generative-ai-applications-with-pgvector-indexing-a-deep-dive-into-ivfflat-and-hnsw-techniques/)
- [Neon halfvec Guide](https://neon.com/blog/dont-use-vector-use-halvec-instead-and-save-50-of-your-storage-cost)
- [pgvector Distance Functions](https://dev.to/philip_mcclarence_2ef9475/pgvector-distance-functions-cosine-vs-l2-vs-inner-product-57pd)

---

## 2. @modelcontextprotocol/sdk (MCP TypeScript SDK)

### Current Version
- **Stable:** v1.27.1 (published 2026-02-24)
- **v2 status:** Pre-alpha on main branch, not recommended for production. v1.x gets bug/security fixes for 6+ months after v2 ships
- **Confidence:** HIGH (npm registry, official GitHub releases)

### CRITICAL: v1 vs v2 Import Paths

The main branch of the SDK repo now contains v2 code with restructured packages. For production, use v1.x:

**v1.x (USE THIS):**
```typescript
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
```

**v2 (DO NOT USE YET):**
```typescript
// These are v2 imports -- NOT compatible with v1.27.x
import { McpServer } from "@modelcontextprotocol/server";
import { NodeStreamableHTTPServerTransport } from "@modelcontextprotocol/node";
import { createMcpExpressApp } from "@modelcontextprotocol/express";
```

### Tool Registration API

v1.x supports both `server.tool()` (simple) and `server.registerTool()` (recommended). Use `registerTool()`:

```typescript
import { z } from "zod";

server.registerTool(
    "search_brain",
    {
        title: "Search Brain",
        description: "Semantic search across all brain tables",
        inputSchema: z.object({
            query: z.string().describe("Natural language search query"),
            tables: z.array(z.enum(["thoughts", "decisions", "relationships", "projects", "sessions"]))
                .optional()
                .describe("Tables to search. Omit to search all"),
            limit: z.number().default(10).describe("Max results to return")
        }),
        annotations: {
            readOnlyHint: true,
            openWorldHint: false
        }
    },
    async ({ query, tables, limit }) => {
        // Implementation
        return {
            content: [{ type: "text", text: JSON.stringify(results) }]
        };
    }
);
```

### StreamableHTTPServerTransport with Express

**Stateful pattern** (recommended for Open Brain -- maintains session context):

```typescript
import express from "express";
import { randomUUID } from "node:crypto";

const app = express();
app.use(express.json());

// Map to store transports by session ID
const transports = new Map<string, StreamableHTTPServerTransport>();

app.post("/mcp", async (req, res) => {
    const sessionId = req.headers["mcp-session-id"] as string;

    if (sessionId && transports.has(sessionId)) {
        // Reuse existing transport
        const transport = transports.get(sessionId)!;
        await transport.handleRequest(req, res, req.body);
        return;
    }

    if (isInitializeRequest(req.body)) {
        // New session
        const transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
        });
        await server.connect(transport);
        transports.set(transport.sessionId!, transport);
        await transport.handleRequest(req, res, req.body);
        return;
    }

    res.status(400).json({ error: "Bad request" });
});
```

### Auth Pattern

Bearer token auth is straightforward Express middleware -- not part of MCP SDK itself:

```typescript
function requireAuth(req, res, next) {
    const token = req.headers.authorization?.replace("Bearer ", "");
    if (!token || !isValidToken(token)) {
        return res.status(401).json({ error: "Unauthorized" });
    }
    req.role = getRoleForToken(token);
    next();
}

app.post("/mcp", requireAuth, async (req, res) => { ... });
```

### Security: DNS Rebinding Protection
- Not enabled by default (CVE-2025-66414)
- For Open Brain (network service, not localhost), set `enableDnsRebindingProtection: true` or use IP binding
- Upgrade to >= v1.24.0 for the fix

### Zod Dependency
- SDK uses `zod/v4` internally but maintains backwards compatibility with Zod v3.25+
- Install `zod` as a peer dependency

### Version Pinning
- Pin to `@modelcontextprotocol/sdk@^1.27.0` (latest v1.x stable)
- Do NOT install v2 packages (`@modelcontextprotocol/server`, `@modelcontextprotocol/node`, etc.)
- Watch for v2 stable release (expected Q1-Q2 2026) but don't migrate until it ships

### Sources
- [MCP TypeScript SDK GitHub](https://github.com/modelcontextprotocol/typescript-sdk)
- [SDK Server Docs](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/server.md)
- [MCP Transports Spec](https://modelcontextprotocol.io/specification/2025-03-26/basic/transports)
- [Koyeb Streamable HTTP Tutorial](https://www.koyeb.com/tutorials/deploy-remote-mcp-servers-to-koyeb-using-streamable-http-transport)
- [Why MCP Deprecated SSE](https://blog.fka.dev/blog/2025-06-06-why-mcp-deprecated-sse-and-go-with-streamable-http/)

---

## 3. Google Embedding Models (text-embedding-004 / gemini-embedding-001)

### CRITICAL FINDING: text-embedding-004 is DEPRECATED

**text-embedding-004 was shut down on January 14, 2026.** This is not a future deprecation -- it is already gone. The project plan references this model but it cannot be used.

**Confidence:** HIGH (Google official deprecation notice, multiple sources confirm)

### Migration Path: gemini-embedding-001

| Property | text-embedding-004 (DEAD) | gemini-embedding-001 (USE THIS) |
|----------|---------------------------|----------------------------------|
| Status | Shut down 2026-01-14 | GA, actively maintained |
| Default dimensions | 768 | 3072 |
| Configurable dimensions | Up to 768 | 768, 1536, 3072 (Matryoshka) |
| Max input tokens | ~2048 | 2048 |
| MTEB ranking | Good | Top rank (multilingual) |
| Task types | Limited | RETRIEVAL_QUERY, RETRIEVAL_DOCUMENT, etc. |

### Recommended Configuration for Open Brain

**Use `gemini-embedding-001` with `output_dimensionality=768`.** Google explicitly recommends 768 as the sweet spot -- "near-peak quality at roughly one-quarter the storage footprint of 3,072 dimensions."

This means:
- No schema changes needed (still 768-dim vectors)
- Better quality embeddings than text-embedding-004
- Matryoshka training means 768-dim prefix is independently useful (not just truncated)
- Can upgrade to 1536 or 3072 later if quality isn't sufficient (requires re-embedding + schema change)

### LiteLLM Integration

LiteLLM supports gemini-embedding-001 via the `gemini/` prefix. The `dimensions` parameter maps to Google's `outputDimensionality` automatically.

```python
# LiteLLM SDK call
response = litellm.embedding(
    model="gemini/gemini-embedding-001",
    input=["text to embed"],
    dimensions=768  # Maps to outputDimensionality
)
```

**Known issues with LiteLLM proxy (as of March 2026):**

1. **task_type ignored through proxy** -- When calling via the proxy's `/embeddings` endpoint, the `task_type` parameter (RETRIEVAL_QUERY vs RETRIEVAL_DOCUMENT) is silently ignored. Embeddings are identical regardless of task type. This may affect search quality since asymmetric embeddings (different for queries vs documents) generally perform better.

2. **encoding_format: base64 rejected** -- Gemini doesn't support `encoding_format: base64`. Fix: set `litellm_settings.drop_params: true` in LiteLLM proxy config.

3. **dimensions parameter works** -- LiteLLM correctly translates `dimensions=768` to `outputDimensionality=768` for Gemini models.

**LiteLLM proxy config update needed:**
```yaml
model_list:
  - model_name: embeddings  # Keep the alias
    litellm_params:
      model: gemini/gemini-embedding-001  # Changed from text-embedding-004
      # dimensions passed at request time

litellm_settings:
  drop_params: true  # Drop unsupported params like encoding_format
```

### Future: gemini-embedding-2-preview

A multimodal embedding model (text, images, video, audio, PDF) with 8192 input tokens and configurable dimensions. Available now as preview. Not needed for v1 but worth tracking for future capabilities (e.g., embedding images from Discord).

### Version Pinning
- Use `gemini-embedding-001` (GA)
- Do NOT use `text-embedding-004` (shut down)
- LiteLLM model string: `gemini/gemini-embedding-001`

### Sources
- [Google Gemini Embedding Docs](https://ai.google.dev/gemini-api/docs/embeddings)
- [Gemini Embedding GA Announcement](https://developers.googleblog.com/gemini-embedding-available-gemini-api/)
- [n8n Community: text-embedding-004 Deprecation](https://community.n8n.io/t/google-deprecating-text-embedding-004-but-gemini-embedding-001-doesnt-work/262008)
- [LiteLLM Embedding Docs](https://docs.litellm.ai/docs/embedding/supported_embedding)
- [LiteLLM Gemini Bug #17759](https://github.com/BerriAI/litellm/issues/17759)

---

## 4. Bun + Express.js

### Current Version
- **Bun:** 1.2.x+ (as of early 2026)
- **Compatibility:** ~95% Node.js API compatibility, Express works "perfectly"
- **Confidence:** HIGH (official Bun docs, community reports)

### Express.js Compatibility Status

Express.js works out of the box with Bun. Standard middleware is fully compatible:

| Middleware | Status |
|-----------|--------|
| `express.json()` | Works |
| `express.urlencoded()` | Works |
| `express.static()` | Works |
| Error handling `(err, req, res, next)` | Works |
| `cors` | Works |
| Custom auth middleware | Works |

### Known Issues (Minor)

1. **Outgoing request body buffering** -- Bun buffers outgoing client request bodies instead of streaming. Not relevant for Open Brain (server, not client).
2. **Native addons** -- `bcrypt`, `sharp` had issues. Not relevant (we don't use them).
3. **Database drivers** -- pg works with "occasional quirks." See section 5 below.

### Performance

Bun runs Express 3x faster than Node.js. For a simple MCP server handling semantic search, this is more than adequate. No need for Bun-native alternatives like bunWay.

### Alternative: Bun.serve() Directly

Bun has a native HTTP server (`Bun.serve()`) that's faster than Express on Bun. However, Express gives us middleware ecosystem compatibility and matches the MCP SDK examples. The performance difference doesn't matter at Open Brain's scale.

**Recommendation:** Stick with Express.js. It's the path of least resistance with MCP SDK, battle-tested patterns for auth middleware, and trivial to set up.

### Sources
- [Bun Node.js Compatibility](https://bun.com/docs/runtime/nodejs-compat)
- [Bun vs Node.js 2026](https://dev.to/alexcloudstar/bun-vs-nodejs-is-it-time-to-switch-in-2026-5821)
- [Bun + Express Compatibility](https://oneuptime.com/blog/post/2026-01-31-bun-nodejs-compatibility/view)

---

## 5. pg (node-postgres) + pgvector-node

### Current Versions
- **pg:** Well-established, battle-tested (exact version to be determined at install time)
- **pgvector (npm):** 0.2.1 (published 2025-05-20)
- **Confidence:** HIGH (official pgvector-node repo, npm registry)

### pg vs Bun SQL: Use pg

| Factor | pg (node-postgres) | Bun SQL |
|--------|-------------------|---------|
| Maturity | Battle-tested, decades of use | New (Bun 1.2+) |
| pgvector support | Full, via `pgvector` npm package | Supported but newer |
| Connection pooling | `pg.Pool` -- well documented | Built-in, less documented |
| Community | Massive | Growing |
| Performance | Competitive (not the bottleneck) | ~50% faster raw reads |
| Type registration | `pgvector.registerTypes(client)` | Different API |

**Recommendation:** Use `pg` (node-postgres). The performance difference is irrelevant for Open Brain's query volume. pg's maturity, documentation, and seamless pgvector integration make it the safer choice. Connection pooling via `pg.Pool` is well-understood and production-proven.

### pgvector-node Usage with pg

```typescript
import pg from "pg";
import pgvector from "pgvector/pg";

// Connection pool
const pool = new pg.Pool({
    connectionString: process.env.DATABASE_URL,
    max: 10,  // Max connections
});

// Register pgvector types on each new connection
pool.on("connect", async (client) => {
    await pgvector.registerTypes(client);
});

// Insert with vector
await pool.query(
    "INSERT INTO thoughts (content, embedding) VALUES ($1, $2)",
    ["some thought", pgvector.toSql(embeddingArray)]
);

// Semantic search with cosine distance
const result = await pool.query(
    "SELECT *, embedding <=> $1 AS distance FROM thoughts ORDER BY embedding <=> $1 LIMIT $2",
    [pgvector.toSql(queryEmbedding), limit]
);
```

### Key API Surface

| Function | Purpose |
|----------|---------|
| `pgvector.registerTypes(client)` | Register vector/halfvec/sparsevec types with pg client |
| `pgvector.toSql(array)` | Convert JS array to pgvector format for parameterized queries |
| `pgvector.fromSql(string)` | Convert pgvector string back to JS array (usually auto-parsed after registerTypes) |

### halfvec with pgvector-node

The `pgvector` npm package supports halfvec. After `registerTypes()`, halfvec columns are automatically parsed. Use `pgvector.toSql()` for inserts -- PostgreSQL handles the float32-to-float16 cast:

```sql
-- Table uses halfvec
CREATE TABLE thoughts (
    embedding halfvec(768)
);

-- Insert with standard toSql (pg casts float32 array to halfvec)
INSERT INTO thoughts (embedding) VALUES ($1::halfvec)
```

### Connection Pooling Configuration

```typescript
const pool = new pg.Pool({
    host: "10.71.20.49",
    port: 5432,
    database: "open_brain",
    user: process.env.PG_USER,
    password: process.env.PG_PASSWORD,
    max: 10,            // Max pool size (10 is fine for our scale)
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
});
```

**Important:** This is a shared PostgreSQL instance (with n8n). Keep `max` conservative (10) to avoid starving n8n's connections. Monitor with `pg_stat_activity` if issues arise.

### Bun Compatibility

pg works with Bun. The `pgvector` npm package explicitly lists Bun support. No shims or workarounds needed.

### Version Pinning
- `pg@^8` (latest 8.x)
- `pgvector@^0.2.1`

### Sources
- [pgvector-node GitHub](https://github.com/pgvector/pgvector-node)
- [pgvector npm](https://www.npmjs.com/package/pgvector)
- [Bun + PostgreSQL Guide](https://oneuptime.com/blog/post/2026-01-31-bun-postgresql/view)
- [pg vs Bun SQL Performance](https://github.com/brianc/node-postgres/issues/3391)

---

## 6. Complete Dependency List

### Production Dependencies

```bash
bun add express @modelcontextprotocol/sdk zod pg pgvector cors
```

| Package | Version | Purpose |
|---------|---------|---------|
| `express` | `^4.x` | HTTP server framework |
| `@modelcontextprotocol/sdk` | `^1.27.0` | MCP server SDK (v1.x stable) |
| `zod` | `^3.25+` | Schema validation (MCP SDK peer dep) |
| `pg` | `^8.x` | PostgreSQL client |
| `pgvector` | `^0.2.1` | pgvector type support for pg |
| `cors` | `^2.x` | CORS middleware (for multi-consumer access) |

### Dev Dependencies

```bash
bun add -d typescript @types/express @types/pg @types/cors
```

### NOT Needed

| Package | Why Not |
|---------|---------|
| `@modelcontextprotocol/server` | v2 package, not stable |
| `@modelcontextprotocol/node` | v2 package, not stable |
| `@modelcontextprotocol/express` | v2 package, not stable |
| `postgres` (postgres.js) | pg is sufficient, better pgvector integration docs |
| `drizzle-orm` / `prisma` | Overkill for 5 tables with simple queries |

---

## 7. Action Items Before Implementation

### Immediate (Blocking)

1. **Update LiteLLM config** -- Change embedding model from `text-embedding-004` to `gemini/gemini-embedding-001`. Add `drop_params: true`. Verify `dimensions=768` works through the proxy.

2. **Verify pgvector version on 10.71.20.49** -- Run `SELECT extversion FROM pg_available_extensions WHERE name = 'vector';` to confirm >= 0.8.0. If older, upgrade before proceeding.

3. **Test embedding quality** -- Generate a few embeddings with `gemini-embedding-001` at 768 dims through LiteLLM and verify they work with pgvector cosine search. Specifically test that cosine distance rankings make semantic sense.

### Pre-Build (Non-Blocking)

4. **Decide on halfvec** -- Run a small test comparing `vector(768)` vs `halfvec(768)` recall quality with actual gemini-embedding-001 embeddings. If recall is equivalent (it should be), use halfvec for 50% storage savings.

5. **Test task_type passthrough** -- Check if LiteLLM proxy now passes `task_type` correctly for gemini-embedding-001. If not, consider calling the embedding API directly (bypassing proxy) for better search quality with asymmetric embeddings.

---

## 8. Risk Summary

| Risk | Severity | Mitigation |
|------|----------|------------|
| text-embedding-004 is dead | **CRITICAL** | Migrate to gemini-embedding-001 immediately |
| MCP SDK v2 migration coming | LOW | v1.x supported for 6+ months after v2 ships. Migration path is documented |
| LiteLLM task_type bug | MEDIUM | Test and monitor. Direct API call fallback if needed |
| Shared PostgreSQL instance | MEDIUM | Conservative connection pool (max=10), monitoring |
| pgvector < 0.8.0 on server | MEDIUM | Verify and upgrade if needed (iterative scans are important) |
| halfvec precision loss | LOW | Test with actual embeddings. 768-dim float16 precision loss is negligible for text |
