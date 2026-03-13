# Phase 2: Core Tools - Research

**Researched:** 2026-03-13
**Domain:** MCP tool registration, Zod schema validation, pgvector cross-table semantic search, InMemoryTransport protocol testing
**Confidence:** HIGH

## Summary

Phase 2 builds the three core MCP tools on top of Phase 1's foundation: `log_thought` (write to thoughts table), `log_decision` (write to decisions table with permission enforcement), and `search_brain` (cross-table semantic search). The implementation requires understanding four APIs verified directly from the installed SDK source:

1. **`McpServer.registerTool()`** -- the current API for tool registration (`.tool()` is deprecated). Takes a name string, a config object with `inputSchema` (Zod raw shape), `description`, and `annotations`, plus a callback receiving `(args, extra)` where `extra.authInfo` contains the authenticated identity.

2. **`InMemoryTransport.createLinkedPair()`** -- creates two linked transports for in-process client/server testing. The critical detail: the `Client` class does NOT inject `authInfo` into messages, so protocol tests must monkey-patch the client transport's `send()` to inject auth for every message.

3. **Cross-table CTE UNION ALL** -- the SQL pattern for searching across 5 tables with different schemas, normalizing results to a common shape (source_type, id, content_preview, distance, metadata), ordered by cosine distance.

4. **Dependency injection** -- tools need access to `pool` and `generateEmbedding`. The existing codebase injects `pool` and `tokenMap` into `createApp()`. Tools should follow the same pattern: a registration function that takes dependencies and the `McpServer` instance.

**Primary recommendation:** Use `registerTool` with Zod v4 raw shapes for input schemas. Inject `pool` and embedding function as closures into tool registration functions. Test with both unit tests (mocked pool/embedding) and protocol tests (InMemoryTransport with Client).

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|-----------------|
| TOOL-01 | `search_brain` tool -- semantic search across all tables | CTE UNION ALL SQL pattern, cosine distance operator `<=>`, query embedding generation, optional table filter, result ranking |
| TOOL-02 | `log_thought` tool -- capture free-form notes with embedding | registerTool API with Zod inputSchema, generateEmbedding + contentHash inline, INSERT with halfvec serialization via pgvector toSql |
| TOOL-03 | `log_decision` tool -- record choices with rationale and permission checks | Same as TOOL-02 plus canWrite permission check via extra.authInfo, alternatives as JSONB |
</phase_requirements>

## Standard Stack

### Core (already installed from Phase 1)
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| @modelcontextprotocol/sdk | ^1.27.1 | McpServer.registerTool(), InMemoryTransport, Client | Official SDK, verified from installed source |
| zod | ^4.3.6 | Tool input schema validation | SDK supports both Zod v3 and v4 via zod-compat layer |
| pg | ^8.20.0 | PostgreSQL queries for tool handlers | Already configured with pgvector type registration |
| pgvector | ^0.2.1 | toSql() for vector serialization, registerTypes | Handles halfvec serialization automatically |

### Supporting (already installed)
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| bun:test | built-in | Unit tests and protocol tests | All test files |

### No New Dependencies
Phase 2 requires zero new package installations. Everything is already in place from Phase 1.

## Architecture Patterns

### Recommended Project Structure (additions to Phase 1)
```
src/
  tools/
    log-thought.ts      # log_thought tool registration
    log-decision.ts     # log_decision tool registration
    search-brain.ts     # search_brain tool registration
    index.ts            # registerAllTools orchestrator
  tools/
    __tests__/
      log-thought.test.ts      # Unit tests (mocked deps)
      log-decision.test.ts     # Unit tests (mocked deps)
      search-brain.test.ts     # Unit tests (mocked deps)
      protocol.test.ts         # InMemoryTransport protocol tests for all 3 tools
```

### Pattern 1: Tool Registration with Dependency Injection

**What:** Each tool module exports a function that takes dependencies (pool, embedding fn) and the McpServer, then registers the tool. No global imports of pool or embedding.

**When to use:** Every tool registration.

**Example:**
```typescript
// Source: verified from SDK mcp.d.ts -- registerTool signature
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type pg from "pg";
import { canWrite } from "../permissions.ts";
import { generateEmbedding, contentHash } from "../embedding.ts";
import { toSql } from "pgvector/pg";
import type { AuthInfo } from "../types.ts";

interface ToolDeps {
  pool: pg.Pool;
  embedFn: typeof generateEmbedding;
}

export function registerLogThought(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    "log_thought",
    {
      description: "Log a thought, idea, or observation to the brain",
      inputSchema: {
        content: z.string().min(1).describe("The thought content"),
        tags: z.array(z.string()).optional().describe("Optional tags"),
      },
      annotations: {
        title: "Log Thought",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
      },
    },
    async (args, extra) => {
      const auth = extra.authInfo as AuthInfo | undefined;
      if (!auth || !canWrite(auth.role, "thoughts")) {
        return {
          content: [{ type: "text", text: "Permission denied: cannot write to thoughts" }],
          isError: true,
        };
      }

      const hash = contentHash(args.content);
      const embedding = await deps.embedFn(args.content);

      const { rows } = await deps.pool.query(
        `INSERT INTO thoughts (content, tags, source, created_by, embedding, content_hash, embedded_at, embedding_model)
         VALUES ($1, $2, 'mcp', $3, $4, $5, $6, $7)
         ON CONFLICT (content_hash) WHERE content_hash IS NOT NULL DO NOTHING
         RETURNING id`,
        [
          args.content,
          args.tags ?? [],
          auth.clientId,
          embedding ? toSql(embedding) : null,
          hash,
          embedding ? new Date().toISOString() : null,
          embedding ? "gemini-embedding-001" : null,
        ],
      );

      if (rows.length === 0) {
        return {
          content: [{ type: "text", text: "Duplicate: thought with identical content already exists" }],
        };
      }

      return {
        content: [{ type: "text", text: JSON.stringify({ id: rows[0].id, embedded: !!embedding }) }],
      };
    },
  );
}
```

### Pattern 2: Cross-Table Semantic Search with CTE UNION ALL

**What:** Generate a query embedding, then use CTEs to search each table independently, UNION ALL the results, and ORDER BY cosine distance.

**When to use:** `search_brain` tool implementation.

**Example:**
```sql
-- Source: pgvector docs for cosine distance operator, standard CTE pattern
-- $1 = query embedding (toSql'd), $2 = result limit, $3 = optional table filter (NULL = all)
WITH query_embedding AS (
  SELECT $1::halfvec(768) AS emb
),
thoughts_results AS (
  SELECT
    'thought' AS source_type,
    t.id,
    t.content AS content_preview,
    t.tags,
    t.created_at,
    t.embedding <=> (SELECT emb FROM query_embedding) AS distance
  FROM thoughts t
  WHERE t.embedding IS NOT NULL
    AND ($3 IS NULL OR $3 = 'thoughts')
  ORDER BY distance
  LIMIT $2
),
decisions_results AS (
  SELECT
    'decision' AS source_type,
    d.id,
    d.title || ': ' || d.rationale AS content_preview,
    d.tags,
    d.created_at,
    d.embedding <=> (SELECT emb FROM query_embedding) AS distance
  FROM decisions d
  WHERE d.embedding IS NOT NULL
    AND ($3 IS NULL OR $3 = 'decisions')
  ORDER BY distance
  LIMIT $2
),
relationships_results AS (
  SELECT
    'relationship' AS source_type,
    r.id,
    r.person_name || ': ' || COALESCE(r.context, '') AS content_preview,
    r.tags,
    r.created_at,
    r.embedding <=> (SELECT emb FROM query_embedding) AS distance
  FROM relationships r
  WHERE r.embedding IS NOT NULL
    AND ($3 IS NULL OR $3 = 'relationships')
  ORDER BY distance
  LIMIT $2
),
projects_results AS (
  SELECT
    'project' AS source_type,
    p.id,
    p.name || ': ' || COALESCE(p.description, '') AS content_preview,
    p.tags,
    p.created_at,
    p.embedding <=> (SELECT emb FROM query_embedding) AS distance
  FROM projects p
  WHERE p.embedding IS NOT NULL
    AND ($3 IS NULL OR $3 = 'projects')
  ORDER BY distance
  LIMIT $2
),
sessions_results AS (
  SELECT
    'session' AS source_type,
    s.id,
    COALESCE(s.project || ': ', '') || LEFT(s.summary, 200) AS content_preview,
    s.tags,
    s.created_at,
    s.embedding <=> (SELECT emb FROM query_embedding) AS distance
  FROM sessions s
  WHERE s.embedding IS NOT NULL
    AND ($3 IS NULL OR $3 = 'sessions')
  ORDER BY distance
  LIMIT $2
)
SELECT * FROM thoughts_results
UNION ALL
SELECT * FROM decisions_results
UNION ALL
SELECT * FROM relationships_results
UNION ALL
SELECT * FROM projects_results
UNION ALL
SELECT * FROM sessions_results
ORDER BY distance ASC
LIMIT $2;
```

**Key details:**
- Each CTE has its own `ORDER BY distance LIMIT $2` to use the HNSW index efficiently (iterative index scan)
- The outer `ORDER BY distance LIMIT $2` re-ranks the merged results
- The `$3 IS NULL OR $3 = 'tablename'` pattern allows optional table filtering without dynamic SQL
- Content preview is normalized to a single text column per table

### Pattern 3: InMemoryTransport Protocol Testing with Auth

**What:** Create linked InMemoryTransport pair, connect Client and McpServer, monkey-patch client transport to inject authInfo, then use `client.callTool()` to test tools end-to-end through the MCP protocol.

**When to use:** Protocol tests that verify the full tool call flow including schema validation, auth propagation, and response format.

**Example:**
```typescript
// Source: verified from SDK inMemory.d.ts, client/index.d.ts, shared/protocol.js
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createBrainServer } from "../../server.ts";
import { registerLogThought } from "../log-thought.ts";
import type { AuthInfo } from "../../types.ts";

describe("log_thought protocol tests", () => {
  let client: Client;
  let cleanup: () => Promise<void>;

  beforeAll(async () => {
    const server = createBrainServer();
    const mockPool = { query: async () => ({ rows: [{ id: "test-uuid" }] }) } as any;
    const mockEmbed = async () => Array(768).fill(0.1);

    registerLogThought(server, { pool: mockPool, embedFn: mockEmbed });

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    // Inject authInfo into every client message
    const testAuth: AuthInfo = { role: "admin", clientId: "test" };
    const originalSend = clientTransport.send.bind(clientTransport);
    clientTransport.send = (message: any, options?: any) => {
      return originalSend(message, { ...options, authInfo: testAuth });
    };

    client = new Client({ name: "test-client", version: "1.0.0" });

    await server.connect(serverTransport);
    await client.connect(clientTransport);

    cleanup = async () => {
      await client.close();
      await server.close();
    };
  });

  afterAll(async () => {
    await cleanup();
  });

  it("should call log_thought and return created ID", async () => {
    const result = await client.callTool({
      name: "log_thought",
      arguments: { content: "Test thought", tags: ["test"] },
    });

    expect(result.isError).toBeFalsy();
    const text = (result.content as any)[0].text;
    const parsed = JSON.parse(text);
    expect(parsed.id).toBe("test-uuid");
    expect(parsed.embedded).toBe(true);
  });

  it("should return validation error for empty content", async () => {
    const result = await client.callTool({
      name: "log_thought",
      arguments: { content: "" },
    });

    // SDK validates against Zod schema and returns error
    expect(result.isError).toBe(true);
  });
});
```

### Pattern 4: Tool Registration Orchestrator

**What:** A single `registerAllTools()` function that wires up all tool registrations with shared dependencies. Called from `index.ts` after creating the McpServer.

**When to use:** Once, at server startup.

**Example:**
```typescript
// src/tools/index.ts
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type pg from "pg";
import { generateEmbedding } from "../embedding.ts";
import { registerLogThought } from "./log-thought.ts";
import { registerLogDecision } from "./log-decision.ts";
import { registerSearchBrain } from "./search-brain.ts";

interface ToolDeps {
  pool: pg.Pool;
  embedFn: typeof generateEmbedding;
}

export function registerAllTools(server: McpServer, deps: ToolDeps): void {
  registerLogThought(server, deps);
  registerLogDecision(server, deps);
  registerSearchBrain(server, deps);
}
```

### Anti-Patterns to Avoid
- **Using deprecated `server.tool()`:** The `.tool()` method is deprecated in the installed SDK version. Use `.registerTool()` which supports title, annotations, and richer config.
- **Importing pool/embedding directly in tool files:** All tool dependencies must be injected. Tool modules should have zero side effects and no global imports of infrastructure.
- **Building dynamic SQL with string concatenation for table filter:** Use the `$3 IS NULL OR $3 = 'tablename'` pattern in CTEs. PostgreSQL optimizes away branches that can't match.
- **Skipping content_hash on insert:** Every write must compute and include content_hash for deduplication. Use `ON CONFLICT (content_hash) DO NOTHING` to handle duplicates gracefully.
- **Returning raw database rows from tools:** MCP tools must return `{ content: [{ type: "text", text: "..." }] }`. Serialize results as JSON strings in the text content.
- **Casting authInfo without null check:** `extra.authInfo` can be `undefined`. Always check before accessing `.role`.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Tool input validation | Manual arg parsing | `registerTool` with Zod inputSchema | SDK validates against schema before handler runs, returns structured error on validation failure |
| Vector serialization for INSERT | Manual `'[0.1, 0.2, ...]'` string building | `pgvector.toSql(embedding)` | Handles halfvec format, escaping, and edge cases |
| MCP protocol compliance | Manual JSON-RPC response building | Return `{ content: [...], isError?: boolean }` | SDK handles JSON-RPC envelope, content type validation |
| Permission error responses | Custom error format per tool | Standardized `{ content: [{ type: "text", text: "..." }], isError: true }` | Consistent error handling across all tools |
| Cross-table search ranking | Application-level sort after separate queries | Single SQL query with CTE + UNION ALL + ORDER BY distance | PostgreSQL HNSW handles ranking natively, single round trip |

**Key insight:** The MCP SDK handles schema validation, JSON-RPC serialization, and transport-level details. Tool handlers should focus purely on business logic: auth check, embedding, database query, response formatting.

## Common Pitfalls

### Pitfall 1: Client Does Not Inject authInfo in InMemoryTransport Tests
**What goes wrong:** Protocol tests create a Client + InMemoryTransport pair, call tools, but `extra.authInfo` is always `undefined` in handlers.
**Why it happens:** The `Client` class calls `transport.send(message)` without passing `authInfo` in options. `InMemoryTransport.send()` only forwards `options?.authInfo`, which is undefined.
**How to avoid:** Monkey-patch the client transport's `send` method to inject `authInfo` into every message. Wrap the original send and add authInfo to options.
**Warning signs:** Permission denied errors in protocol tests even though the tool handler should allow the action.

### Pitfall 2: Zod v4 Import Path
**What goes wrong:** Importing `import { z } from "zod/v4"` or `import { z } from "zod/v3"` instead of `import { z } from "zod"`.
**Why it happens:** The SDK's zod-compat layer supports both v3 and v4. The project has Zod v4.3.6 installed. The correct import is simply `from "zod"`.
**How to avoid:** Always use `import { z } from "zod"`. The SDK's `isZ4Schema()` function detects the version automatically.
**Warning signs:** Module resolution errors, or schema validation silently failing.

### Pitfall 3: toSql vs JSON.stringify for Vector Inserts
**What goes wrong:** Using `JSON.stringify(embedding)` for the embedding parameter in INSERT queries.
**Why it happens:** The Phase 1 migration test uses `JSON.stringify(testEmbedding)` for inserting test vectors, which works for `vector` type but may cause issues with `halfvec`.
**How to avoid:** Use `pgvector.toSql(embedding)` from `pgvector/pg` for all vector inserts. It handles both vector and halfvec serialization correctly.
**Warning signs:** INSERT succeeds but SELECT returns wrong values, or type mismatch errors.

### Pitfall 4: Missing NULL Embedding Filter in Search
**What goes wrong:** Search returns rows with NULL embeddings, causing cosine distance to return NULL and breaking ORDER BY.
**Why it happens:** Not all rows have embeddings (graceful degradation stores NULL). The `<=>` operator returns NULL when either operand is NULL.
**How to avoid:** Always include `WHERE embedding IS NOT NULL` in search CTEs. This also helps the HNSW index scan.
**Warning signs:** NULL values in distance column, inconsistent result ordering.

### Pitfall 5: Not Handling Embedding Failure in Write Tools
**What goes wrong:** Tool handler throws when `generateEmbedding()` returns null, causing the entire write to fail.
**Why it happens:** Treating embedding as required instead of optional. The design explicitly calls for graceful degradation.
**How to avoid:** Check for null return from `generateEmbedding()`. If null, still INSERT the row but with `embedding = NULL`, `embedded_at = NULL`, `embedding_model = NULL`. Return the record ID with `embedded: false` in the response.
**Warning signs:** Tool calls fail when LiteLLM is down or slow.

### Pitfall 6: Forgetting to Check Read Permission in search_brain
**What goes wrong:** `search_brain` searches tables the caller doesn't have read access to, leaking data.
**Why it happens:** Write tools check `canWrite`, but `search_brain` needs `canRead` checks per table. The discord role has no read access to most tables.
**How to avoid:** Before executing the search query, filter the table list based on `canRead(auth.role, table)`. Only include CTEs for tables the caller can read.
**Warning signs:** Discord consumer seeing decisions or relationships in search results.

### Pitfall 7: ON CONFLICT on Partial Unique Index
**What goes wrong:** `ON CONFLICT (content_hash)` fails because the unique index on content_hash is partial (`WHERE content_hash IS NOT NULL`).
**Why it happens:** PostgreSQL requires the conflict target to match an actual constraint or index, including its WHERE clause.
**How to avoid:** Use `ON CONFLICT (content_hash) WHERE content_hash IS NOT NULL DO NOTHING` to match the partial unique index exactly.
**Warning signs:** `there is no unique or exclusion constraint matching the ON CONFLICT specification` error.

## Code Examples

### Tool Handler Return Format
```typescript
// Source: SDK types.d.ts -- CallToolResult
// Success response
return {
  content: [{ type: "text", text: JSON.stringify({ id, embedded: true }) }],
};

// Error response (isError flag)
return {
  content: [{ type: "text", text: "Permission denied: cannot write to decisions" }],
  isError: true,
};

// Duplicate response (not an error, informational)
return {
  content: [{ type: "text", text: "Duplicate: content already exists" }],
};
```

### log_decision Input Schema
```typescript
// Source: REQUIREMENTS.md TOOL-03, decisions table schema from 001_init.sql
{
  title: z.string().min(1).describe("Decision title"),
  rationale: z.string().min(1).describe("Why this decision was made"),
  alternatives: z
    .array(z.string())
    .optional()
    .describe("Alternatives that were considered"),
  tags: z.array(z.string()).optional().describe("Optional tags"),
  context: z.string().optional().describe("Additional context"),
}
```

### search_brain Input Schema
```typescript
// Source: REQUIREMENTS.md TOOL-01, success criteria #3
{
  query: z.string().min(1).describe("Natural language search query"),
  table: z
    .enum(["thoughts", "decisions", "relationships", "projects", "sessions"])
    .optional()
    .describe("Optional: limit search to a specific table"),
  limit: z
    .number()
    .int()
    .min(1)
    .max(50)
    .optional()
    .default(10)
    .describe("Maximum results to return (default 10)"),
}
```

### search_brain Result Format
```typescript
// Source: success criteria #3 -- "returns ranked results with source type, content, distance, and metadata"
interface SearchResult {
  source_type: string;     // "thought", "decision", "relationship", "project", "session"
  id: string;              // UUID
  content_preview: string; // Normalized text preview
  distance: number;        // Cosine distance (lower = more similar)
  tags: string[];          // Tags array
  created_at: string;      // ISO timestamp
}
```

### Integration Point: Wiring Tools into Server Startup
```typescript
// In src/index.ts -- add to createApp or startup sequence
import { registerAllTools } from "./tools/index.ts";

// After creating mcpServer, before creating transport handlers
const mcpServer = createBrainServer();
registerAllTools(mcpServer, {
  pool,
  embedFn: generateEmbedding,
});
const handlers = createTransportHandlers(mcpServer);
```

### Alternatives Column Handling for log_decision
```typescript
// Tool receives alternatives as string[], store as JSONB
// The decisions table column is: alternatives JSONB DEFAULT '[]'
const alternativesJson = JSON.stringify(
  (args.alternatives ?? []).map((alt: string) => ({ description: alt }))
);

// Or store as simple string array in JSONB:
const alternativesJson = JSON.stringify(args.alternatives ?? []);
```

### Embedding Text Construction for Decisions
```typescript
// For decisions, embed the concatenation of title + rationale for semantic search
// This gives the best semantic match quality
const textToEmbed = `${args.title}\n${args.rationale}`;
const embedding = await deps.embedFn(textToEmbed);
const hash = contentHash(textToEmbed);
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| `server.tool()` | `server.registerTool()` | MCP SDK v1.27+ | Old API deprecated, new API supports title, annotations, richer config |
| Positional args for tool() | Config object for registerTool() | MCP SDK v1.27+ | Cleaner API, less error-prone, supports optional fields |
| Custom JSON-RPC test harness | InMemoryTransport + Client | MCP SDK v1.x | Official in-process testing, handles protocol negotiation automatically |
| `import { z } from "zod/v3"` | `import { z } from "zod"` | Zod v4 + SDK zod-compat | SDK auto-detects Zod version, transparent compatibility |

**Deprecated/outdated:**
- `server.tool()`: All overloads deprecated, use `registerTool()`.
- Manual JSON-RPC message construction for tests: Use `Client.callTool()` via InMemoryTransport instead.

## Open Questions

1. **Does `z.number().default(10)` work with the SDK's Zod v4 compat layer?**
   - What we know: The SDK's `zod-compat.ts` handles both v3 and v4. Default values in Zod schemas become part of the JSON Schema `default` field.
   - What's unclear: Whether the SDK actually applies Zod defaults to missing tool arguments, or if defaults only appear in the schema definition sent to clients.
   - Recommendation: Test during implementation. If defaults don't work, make `limit` required or handle the default in the handler code with `args.limit ?? 10`.

2. **Per-table LIMIT vs global LIMIT in search CTE**
   - What we know: Each CTE applies `LIMIT $2` independently, then the outer query also applies `LIMIT $2`.
   - What's unclear: Whether per-CTE LIMIT should be the same as global LIMIT (may miss results from tables with fewer matches) or higher (more DB work but better recall).
   - Recommendation: Use the same limit for both per-CTE and global. At this scale (tens of rows per table), the difference is negligible. Can be tuned later.

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | bun:test (Bun built-in, Jest-compatible API) |
| Config file | bunfig.toml (exists from Phase 1) |
| Quick run command | `bun test src/tools/` |
| Full suite command | `bun test --coverage` |

### Phase Requirements -> Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| TOOL-02 | log_thought inserts to thoughts table with embedding, handles duplicates | unit | `bun test src/tools/__tests__/log-thought.test.ts -x` | No -- Wave 0 |
| TOOL-02 | log_thought protocol test -- call via Client, validate response format | protocol | `bun test src/tools/__tests__/protocol.test.ts -x` | No -- Wave 0 |
| TOOL-03 | log_decision inserts to decisions table, enforces permission, handles alternatives | unit | `bun test src/tools/__tests__/log-decision.test.ts -x` | No -- Wave 0 |
| TOOL-03 | log_decision protocol test -- permission denied for unauthorized role | protocol | `bun test src/tools/__tests__/protocol.test.ts -x` | No -- Wave 0 |
| TOOL-01 | search_brain generates query embedding, runs CTE search, returns ranked results | unit | `bun test src/tools/__tests__/search-brain.test.ts -x` | No -- Wave 0 |
| TOOL-01 | search_brain protocol test -- table filter, empty results, isError on embed failure | protocol | `bun test src/tools/__tests__/protocol.test.ts -x` | No -- Wave 0 |

### Sampling Rate
- **Per task commit:** `bun test src/tools/`
- **Per wave merge:** `bun test --coverage`
- **Phase gate:** Full suite green before `/gsd:verify-work`

### Wave 0 Gaps
- [ ] `src/tools/` directory -- does not exist yet
- [ ] `src/tools/__tests__/log-thought.test.ts` -- unit tests with mocked pool and embedding
- [ ] `src/tools/__tests__/log-decision.test.ts` -- unit tests including permission checks
- [ ] `src/tools/__tests__/search-brain.test.ts` -- unit tests with mocked query results
- [ ] `src/tools/__tests__/protocol.test.ts` -- InMemoryTransport protocol tests for all 3 tools

## Sources

### Primary (HIGH confidence)
- Installed SDK source: `node_modules/@modelcontextprotocol/sdk/dist/esm/server/mcp.d.ts` -- registerTool signature, ToolCallback type, deprecated .tool() overloads
- Installed SDK source: `node_modules/@modelcontextprotocol/sdk/dist/esm/inMemory.d.ts` -- InMemoryTransport.createLinkedPair(), send() with authInfo
- Installed SDK source: `node_modules/@modelcontextprotocol/sdk/dist/esm/inMemory.js` -- send() implementation confirms authInfo passthrough
- Installed SDK source: `node_modules/@modelcontextprotocol/sdk/dist/esm/shared/protocol.js` line 345 -- confirms `authInfo: extra?.authInfo` propagation to request handlers
- Installed SDK source: `node_modules/@modelcontextprotocol/sdk/dist/esm/shared/protocol.d.ts` -- RequestHandlerExtra type with `authInfo?: AuthInfo`, `sessionId?: string`
- Installed SDK source: `node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.d.ts` -- Client class, callTool() method
- Installed SDK source: `node_modules/@modelcontextprotocol/sdk/dist/esm/server/zod-compat.d.ts` -- ZodRawShapeCompat, AnySchema, confirms v3+v4 support
- pgvector docs: `<=>` cosine distance operator, HNSW iterative index scans
- Existing codebase: `src/server.ts`, `src/types.ts`, `src/permissions.ts`, `src/embedding.ts`, `src/index.ts`, `src/transport.ts`

### Secondary (MEDIUM confidence)
- Phase 1 Research: architecture patterns, auth flow, embedding pipeline
- pgvector CTE UNION ALL pattern: standard PostgreSQL pattern, not specific to pgvector

### Tertiary (LOW confidence)
- None -- all critical findings verified from installed SDK source code

## Metadata

**Confidence breakdown:**
- registerTool API: HIGH -- verified directly from installed SDK type definitions and source
- InMemoryTransport: HIGH -- verified from installed SDK source code, including authInfo flow through protocol.js
- Cross-table search SQL: HIGH -- standard PostgreSQL CTE pattern with pgvector cosine distance operator
- Auth propagation in tests: HIGH -- traced the full flow from InMemoryTransport.send() through protocol.js to RequestHandlerExtra

**Research date:** 2026-03-13
**Valid until:** 2026-04-13 (stable ecosystem, installed SDK version pinned)
