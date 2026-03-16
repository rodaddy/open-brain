# Phase 7: Data Curation - Research

**Researched:** 2026-03-15
**Domain:** MCP tool development, PostgreSQL schema evolution, pgvector search tuning
**Confidence:** HIGH

## Summary

This phase adds data curation capabilities to Open Brain: the ability to archive/soft-delete entries, update existing entries (with re-embedding), and enhance search to factor in usage/recency signals. The codebase has a clean, consistent pattern for tool registration, permission checking, and embedding -- all new tools follow the same shape. The database schema needs a migration to add `archived_at` and `access_count`/`last_accessed_at` columns, and search needs to filter out archived rows and optionally weight by usage.

The existing code is well-structured with clear separation: each tool lives in its own file, exports a single `register*` function, uses Zod for input validation, checks permissions via `canRead`/`canWrite`, and returns the standard MCP `{ content: [{ type: "text", text }] }` shape. Tests use `bun:test` with InMemoryTransport to test tools through the full MCP protocol stack.

**Primary recommendation:** Follow the existing tool patterns exactly. Add a `002_curation.sql` migration for schema changes. Add `canDelete` to the permission system. Create `archive-entry.ts`, `update-entry.ts`, and `brain-stats.ts` tool files. Modify `search-brain.ts` to filter archived rows and support usage-weighted ranking.

## Standard Stack

### Core (already in use -- no new dependencies needed)
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `@modelcontextprotocol/sdk` | ^1.27.1 | MCP server + tool registration | Already the server framework |
| `zod` | ^4.3.6 | Input schema validation | Already used for all tool inputs |
| `pg` | ^8.20.0 | PostgreSQL client | Already the DB driver |
| `pgvector` | ^0.2.1 | Vector operations (toSql) | Already used for embedding storage |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `bun:test` | built-in | Test framework | All unit + protocol tests |
| `@modelcontextprotocol/sdk/inMemory.js` | ^1.27.1 | InMemoryTransport for testing | Protocol-level tool tests |

**No new dependencies required.** All curation tools use the existing stack.

## Architecture Patterns

### Existing Project Structure
```
src/
  tools/
    index.ts           # ToolDeps interface + registerAllTools()
    log-thought.ts     # registerLogThought()
    log-decision.ts    # registerLogDecision()
    search-brain.ts    # registerSearchBrain()
    find-person.ts     # registerFindPerson()
    session-save.ts    # registerSessionSave()
    session-load.ts    # registerSessionLoad()
    __tests__/         # One test file per tool
  permissions.ts       # canRead(), canWrite(), PERMISSIONS matrix
  types.ts             # Role, Table, Permission, AuthInfo types
  embedding.ts         # generateEmbedding(), contentHash()
  logger.ts            # Structured JSON logger
  db/
    migrations/
      001_init.sql     # Schema creation
    migrate.ts         # Migration runner
```

### Pattern 1: Tool Registration (follow exactly)

Every tool file exports a single `register*` function with this shape:

```typescript
// Source: src/tools/log-thought.ts (representative pattern)
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { canWrite } from "../permissions.ts";
import type { AuthInfo } from "../types.ts";
import type { ToolDeps } from "./index.ts";

export function registerArchiveEntry(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    "archive_entry",                    // tool name (snake_case)
    {
      description: "...",               // tool description
      inputSchema: {                    // Zod schemas (NOT z.object -- raw shape)
        id: z.string().uuid().describe("UUID of the entry"),
        table: z.enum(["thoughts", "decisions", ...]).describe("..."),
      },
      annotations: {                    // MCP tool annotations
        title: "Archive Entry",         // human-readable title
        readOnlyHint: false,            // true for reads
        destructiveHint: true,          // true for deletes/archives
        idempotentHint: true,           // true if safe to retry
      },
    },
    async (args, extra) => {
      // 1. Auth check (ALWAYS first)
      const auth = extra.authInfo as AuthInfo | undefined;
      if (!auth || !canWrite(auth.role, "thoughts")) {
        return {
          content: [{ type: "text" as const, text: "Permission denied: ..." }],
          isError: true,
        };
      }

      // 2. Business logic (SQL queries via deps.pool)
      const { rows } = await deps.pool.query("...", [...]);

      // 3. Return result
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ ... }) }],
      };
    },
  );
}
```

**Critical details:**
- `inputSchema` is a **flat object of Zod schemas**, NOT `z.object({...})`. The MCP SDK wraps it.
- `type: "text" as const` -- the `as const` is required everywhere.
- Tool names are `snake_case`.
- Annotation titles are `Title Case`.
- Error returns include `isError: true`.

### Pattern 2: Tool Wiring (src/tools/index.ts)

```typescript
// Source: src/tools/index.ts
import { registerArchiveEntry } from "./archive-entry.ts";

export interface ToolDeps {
  pool: pg.Pool;
  embedFn: typeof generateEmbedding;
}

export function registerAllTools(server: McpServer, deps: ToolDeps): void {
  registerLogThought(server, deps);
  // ... existing tools ...
  registerArchiveEntry(server, deps);  // ADD new tools here
}
```

### Pattern 3: Permission System (src/permissions.ts)

```typescript
// Source: src/permissions.ts
export type Permission = "read" | "write";  // ADD "delete" here

const RW = Object.freeze(new Set<Permission>(["read", "write"]));
const RO = Object.freeze(new Set<Permission>(["read"]));
// ADD: const RWD = Object.freeze(new Set<Permission>(["read", "write", "delete"]));

export const PERMISSIONS: Record<Role, Record<Table, Set<Permission>>> = {
  admin: { thoughts: RWD, ... },    // admin + n8n get delete
  agent: { thoughts: RW, ... },     // agents can write but NOT delete
  n8n: { thoughts: RWD, ... },      // n8n gets delete for automation
  discord: { thoughts: WO, ... },   // no change
  readonly: { thoughts: RO, ... },  // no change
};

// ADD:
export function canDelete(role: Role, table: Table): boolean {
  return PERMISSIONS[role][table].has("delete");
}
```

### Pattern 4: Embedding for Write Tools

Write tools that create/update content follow this pattern:

```typescript
// Source: src/tools/log-thought.ts
const hash = contentHash(args.content);
const embedding = await deps.embedFn(args.content);
logger.info("tool_embedding", { tool: "log_thought", embedded: !!embedding });

// INSERT with ON CONFLICT (content_hash) dedup
const { rows } = await deps.pool.query(
  `INSERT INTO thoughts (..., embedding, content_hash, embedded_at, embedding_model)
   VALUES ($1, ..., $4, $5, $6, $7)
   ON CONFLICT (content_hash) WHERE content_hash IS NOT NULL DO NOTHING
   RETURNING id`,
  [
    args.content,
    // ...
    embedding ? toSql(embedding) : null,
    hash,
    embedding ? new Date().toISOString() : null,
    embedding ? "gemini-embedding-001" : null,
  ],
);
```

For `update_entry`, this pattern changes to an UPDATE that re-embeds and updates the content_hash.

### Pattern 5: Search Brain CTE Pattern (src/tools/search-brain.ts)

The `buildTableCTE` function generates per-table CTEs. This is where `archived_at` filtering must be added:

```typescript
// Source: src/tools/search-brain.ts -- current implementation
function buildTableCTE(table: Table): string {
  const alias = TABLE_ALIAS[table];
  const label = SOURCE_LABELS[table];
  const preview = CONTENT_PREVIEW[table];
  const cteName = `${table}_results`;

  return `${cteName} AS (
  SELECT
    '${label}' AS source_type,
    ${alias}.id,
    ${preview} AS content_preview,
    ${alias}.tags,
    ${alias}.created_at,
    ${alias}.embedding <=> (SELECT emb FROM query_embedding) AS distance
  FROM ${table} ${alias}
  WHERE ${alias}.embedding IS NOT NULL
  ORDER BY distance
  LIMIT $2
)`;
}
```

**Where to add archived_at filtering:** Add `AND ${alias}.archived_at IS NULL` to the WHERE clause.

**Where to add usage-weighted ranking:** The final `ORDER BY distance ASC` can become a composite score. For example:
```sql
ORDER BY (distance * 0.7 + (1.0 / (1 + EXTRACT(EPOCH FROM (NOW() - ${alias}.last_accessed_at)) / 86400.0)) * 0.3) ASC
```
Or simpler: just add a `include_archived` boolean param that when true removes the filter.

### Pattern 6: Test Structure

```typescript
// Source: src/tools/__tests__/log-thought.test.ts (representative)
import { describe, it, expect } from "bun:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

// Mock helpers
function createMockPool(rows = [{ id: "test-uuid" }]) {
  return { query: async () => ({ rows }) };
}

function createMockEmbed(result: number[] | null = Array(768).fill(0.1)) {
  return async (_text: string) => result;
}

// Setup helper (creates server, registers tool, connects via InMemoryTransport)
async function setupToolClient(mockPool, mockEmbed, auth: AuthInfo) {
  const server = new McpServer({ name: "test", version: "1.0.0" });
  const deps: ToolDeps = { pool: mockPool as any, embedFn: mockEmbed };
  registerNewTool(server, deps);

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  // Inject authInfo into every client message
  const originalSend = clientTransport.send.bind(clientTransport);
  clientTransport.send = (message: any, options?: any) => {
    return originalSend(message, { ...options, authInfo: auth });
  };

  const client = new Client({ name: "test-client", version: "1.0.0" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);

  return { client, cleanup: async () => { await client.close(); await server.close(); } };
}

// Tests follow describe/it with try/finally cleanup
describe("tool_name", () => {
  it("does the thing", async () => {
    const { client, cleanup } = await setupToolClient(...);
    try {
      const result = await client.callTool({ name: "tool_name", arguments: { ... } });
      expect(result.isError).toBeFalsy();
      // Assert on result.content[0].text
    } finally {
      await cleanup();
    }
  });
});
```

**Key test patterns to replicate:**
- Mock pool that captures `queryCalls` for SQL assertion
- Mock embed that captures `embeddedTexts` for verification
- Auth injection via transport send override
- Permission denied tests (wrong role, missing auth)
- Duplicate/conflict tests (empty rows = ON CONFLICT DO NOTHING)

### Anti-Patterns to Avoid
- **Never use `z.object()` for inputSchema** -- the MCP SDK expects a flat map of Zod schemas.
- **Never skip the auth check** -- every tool handler starts with auth validation.
- **Never hard-delete** -- this phase uses soft-delete (archived_at) by design.
- **Never add columns without a migration file** -- the migration runner reads `src/db/migrations/*.sql` in sort order.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Migration system | Custom migration runner | Existing `src/db/migrate.ts` | Already handles ordering, idempotency, _migrations tracking |
| Embedding generation | Direct API calls | `deps.embedFn` (ToolDeps) | Already handles LiteLLM routing, timeouts, error handling |
| Content dedup | Manual hash comparison | `contentHash()` from `src/embedding.ts` | Normalizes whitespace, uses SHA-256 |
| Auth checking | Manual token inspection | `canRead/canWrite/canDelete` from `src/permissions.ts` | Centralized permission matrix |
| Vector SQL formatting | Manual array formatting | `toSql()` from `pgvector/pg` | Handles halfvec encoding correctly |
| Test transport | HTTP mocking | `InMemoryTransport.createLinkedPair()` | Tests the full MCP protocol, not just the handler |

## Common Pitfalls

### Pitfall 1: Forgetting to Filter Archived Rows in ALL Read Paths
**What goes wrong:** Archives still show up in search results, session loads, find_person.
**Why it happens:** `search_brain` has 5 table CTEs, `session_load` has 2 query paths, `find_person` has 2 search modes -- easy to miss one.
**How to avoid:** Add `AND archived_at IS NULL` to every SELECT in: `buildTableCTE()` (search), `handleProjectLoad()` + `handleGlobalLoad()` (session_load), `handleNameSearch()` + `handleSemanticSearch()` (find_person).
**Warning signs:** Archived items appearing in search results.

### Pitfall 2: Content Hash Collision on Update
**What goes wrong:** After updating entry content, the new content hash conflicts with another entry.
**Why it happens:** ON CONFLICT (content_hash) DO NOTHING prevents the update.
**How to avoid:** For `update_entry`, use UPDATE (not INSERT), and recalculate the content_hash. Check for hash collision before updating: if the new hash already exists on a different row, return a "duplicate" error.
**Warning signs:** Update silently fails, returns 0 rows.

### Pitfall 3: Re-embedding Text Construction Per Table
**What goes wrong:** Update tool embeds wrong text, breaking semantic search quality.
**Why it happens:** Each table constructs embeddable text differently:
  - `thoughts`: just `content`
  - `decisions`: `title + "\n" + rationale`
  - `relationships`: `person_name + ": " + context`
  - `projects`: `name + ": " + description`
  - `sessions`: `summary`
**How to avoid:** Build a lookup/helper that maps table name to text-construction logic, reusing the exact same logic as the original log/save tools.
**Warning signs:** Semantic search quality degrades after updates.

### Pitfall 4: Sessions Table Has No updated_at Column
**What goes wrong:** Trying to add update_updated_at trigger for sessions fails.
**Why it happens:** The sessions table was designed as append-only (no updated_at column, no update trigger).
**How to avoid:** The migration must ADD an `updated_at` column to sessions if you want to support updating sessions. Or treat sessions as archive-only (no updates).
**Warning signs:** Migration failure on sessions table trigger.

### Pitfall 5: HNSW Index and NULL Embeddings
**What goes wrong:** Rows with NULL embeddings are invisible to semantic search but should still be archivable/updatable.
**Why it happens:** The CTE WHERE clause already filters `embedding IS NOT NULL`.
**How to avoid:** Archive/update tools work on the row ID directly (not via embedding search), so NULL embeddings don't affect them. But `brain_stats` queries should count NULL embeddings as "unembedded".
**Warning signs:** Stats showing fewer rows than expected.

### Pitfall 6: Migration Numbering
**What goes wrong:** Migration runs out of order or conflicts.
**Why it happens:** Migration files are sorted lexically by filename.
**How to avoid:** Name the new migration `002_curation.sql`. The existing runner in `src/db/migrate.ts` reads `*.sql` files sorted alphabetically.
**Warning signs:** Migration applies before 001_init.sql.

## Database Migration Design

The `002_curation.sql` migration needs to add these columns to ALL 5 tables:

```sql
-- 002_curation.sql: Add curation columns for archive + usage tracking

-- Add archived_at to all 5 tables (soft delete)
ALTER TABLE thoughts ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ;
ALTER TABLE decisions ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ;
ALTER TABLE relationships ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ;

-- Add usage tracking columns to all 5 tables
ALTER TABLE thoughts ADD COLUMN IF NOT EXISTS access_count INTEGER DEFAULT 0;
ALTER TABLE thoughts ADD COLUMN IF NOT EXISTS last_accessed_at TIMESTAMPTZ;
ALTER TABLE decisions ADD COLUMN IF NOT EXISTS access_count INTEGER DEFAULT 0;
ALTER TABLE decisions ADD COLUMN IF NOT EXISTS last_accessed_at TIMESTAMPTZ;
ALTER TABLE relationships ADD COLUMN IF NOT EXISTS access_count INTEGER DEFAULT 0;
ALTER TABLE relationships ADD COLUMN IF NOT EXISTS last_accessed_at TIMESTAMPTZ;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS access_count INTEGER DEFAULT 0;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS last_accessed_at TIMESTAMPTZ;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS access_count INTEGER DEFAULT 0;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS last_accessed_at TIMESTAMPTZ;

-- Add updated_at to sessions (missing from 001_init.sql)
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();

-- Partial index for fast "active only" queries
CREATE INDEX IF NOT EXISTS idx_thoughts_active ON thoughts (created_at DESC) WHERE archived_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_decisions_active ON decisions (created_at DESC) WHERE archived_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_relationships_active ON relationships (created_at DESC) WHERE archived_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_projects_active ON projects (created_at DESC) WHERE archived_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_sessions_active ON sessions (created_at DESC) WHERE archived_at IS NULL;
```

## New Tool Specifications

### archive_entry
- **Input:** `{ table: Table, id: string (UUID) }`
- **Permission:** `canDelete(role, table)` -- new permission level
- **SQL:** `UPDATE {table} SET archived_at = NOW() WHERE id = $1 AND archived_at IS NULL RETURNING id`
- **Annotations:** `{ readOnlyHint: false, destructiveHint: true, idempotentHint: true }`
- **Edge cases:** Already archived (0 rows returned) -- return "already archived" message. Invalid UUID -- Zod validation catches it.

### update_entry
- **Input:** `{ table: Table, id: string (UUID), content: string, tags?: string[] }`
- **Permission:** `canWrite(role, table)` -- existing permission
- **Logic:**
  1. Build embeddable text based on table type
  2. Generate new content hash + embedding
  3. Check hash collision (same hash on different row)
  4. UPDATE row with new content, embedding, content_hash, embedded_at, embedding_model, tags
- **Annotations:** `{ readOnlyHint: false, destructiveHint: false, idempotentHint: false }`
- **Complexity:** Each table has different columns to update:
  - `thoughts`: `content`, `tags`
  - `decisions`: `title`, `rationale`, `alternatives`, `context`, `tags`
  - `sessions`: `summary`, `tags`, `blockers`, `next_steps`, `key_decisions`
  - `relationships`: `person_name`, `context`, `warmth`, `notes`, `tags`
  - `projects`: `name`, `status`, `description`, `tags`, `metadata`

  The input schema needs to be flexible. Recommendation: accept a generic `fields` object (Record<string, unknown>) plus required `table` and `id`, then validate server-side that only valid columns for that table are included. Alternatively, accept the union of all possible fields and ignore irrelevant ones per table.

### brain_stats
- **Input:** `{ table?: Table }` (optional -- all tables if omitted)
- **Permission:** `canRead(role, table)` -- existing permission
- **SQL:** Counts per table: total rows, archived rows, embedded rows, unembedded rows, most/least recently accessed
- **Annotations:** `{ readOnlyHint: true, destructiveHint: false, idempotentHint: true }`

### search_brain modifications
- Add `include_archived?: boolean` parameter (default false)
- When false (default): add `AND {alias}.archived_at IS NULL` to WHERE clause in `buildTableCTE()`
- Increment `access_count` and `last_accessed_at` for returned row IDs (fire-and-forget UPDATE after returning results)
- Optional: Add `boost_recent?: boolean` parameter for usage-weighted ranking

## Permission System Changes

Current `Permission` type is `"read" | "write"`. Adding `"delete"`:

```typescript
// src/types.ts
export type Permission = "read" | "write" | "delete";

// src/permissions.ts -- new constants
const RWD = Object.freeze(new Set<Permission>(["read", "write", "delete"]));

// Updated PERMISSIONS matrix
export const PERMISSIONS: Record<Role, Record<Table, Set<Permission>>> = {
  admin: {
    thoughts: RWD, decisions: RWD, relationships: RWD, projects: RWD, sessions: RWD,
  },
  agent: {
    thoughts: RW, decisions: RW, relationships: RO, projects: RO, sessions: RW,
  },
  discord: {
    thoughts: WO, decisions: NONE, relationships: NONE, projects: NONE, sessions: NONE,
  },
  n8n: {
    thoughts: RWD, decisions: RWD, relationships: RWD, projects: RWD, sessions: RWD,
  },
  readonly: {
    thoughts: RO, decisions: RO, relationships: RO, projects: RO, sessions: RO,
  },
};

// New function
export function canDelete(role: Role, table: Table): boolean {
  return PERMISSIONS[role][table].has("delete");
}
```

**Key decision:** Only `admin` and `n8n` get delete. Agents should NOT be able to archive/delete knowledge -- that's a human/admin decision. This prevents runaway AI cleanup.

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | bun:test (built-in) |
| Config file | None needed -- bun test auto-discovers `*.test.ts` |
| Quick run command | `bun test --filter "archive"` |
| Full suite command | `bun test` |

### Phase Requirements -> Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| CUR-01 | archive_entry soft-deletes rows | unit | `bun test src/tools/__tests__/archive-entry.test.ts` | No -- Wave 0 |
| CUR-02 | update_entry re-embeds content | unit | `bun test src/tools/__tests__/update-entry.test.ts` | No -- Wave 0 |
| CUR-03 | search_brain filters archived | unit | `bun test src/tools/__tests__/search-brain.test.ts` | Yes -- needs new cases |
| CUR-04 | brain_stats returns counts | unit | `bun test src/tools/__tests__/brain-stats.test.ts` | No -- Wave 0 |
| CUR-05 | canDelete permission works | unit | `bun test src/tools/__tests__/archive-entry.test.ts` | No -- Wave 0 |
| CUR-06 | 002_curation.sql migration | integration | `bun test src/db/migrations/002_curation.test.ts` | No -- Wave 0 |

### Sampling Rate
- **Per task commit:** `bun test --filter "{tool_name}"`
- **Per wave merge:** `bun test`
- **Phase gate:** Full suite green before verification

### Wave 0 Gaps
- [ ] `src/tools/__tests__/archive-entry.test.ts` -- covers CUR-01, CUR-05
- [ ] `src/tools/__tests__/update-entry.test.ts` -- covers CUR-02
- [ ] `src/tools/__tests__/brain-stats.test.ts` -- covers CUR-04
- [ ] `src/db/migrations/002_curation.test.ts` -- covers CUR-06
- [ ] New test cases in existing `search-brain.test.ts` -- covers CUR-03

## Sources

### Primary (HIGH confidence)
- Direct codebase analysis of all files in `src/tools/`, `src/permissions.ts`, `src/types.ts`, `src/embedding.ts`, `src/db/migrations/001_init.sql`, `src/db/migrate.ts`, `src/index.ts`
- All 7 existing test files in `src/tools/__tests__/`
- `.planning/REQUIREMENTS.md` and `.planning/ROADMAP.md`

### Secondary (MEDIUM confidence)
- PostgreSQL `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` is idempotent and safe for migrations (standard PostgreSQL DDL)
- Partial indexes (`WHERE archived_at IS NULL`) are standard PostgreSQL for soft-delete patterns

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH -- no new dependencies, all patterns established
- Architecture: HIGH -- direct codebase analysis, patterns are consistent across 6 existing tools
- Pitfalls: HIGH -- identified from actual code paths and schema analysis
- Migration design: HIGH -- follows existing migration pattern exactly

**Research date:** 2026-03-15
**Valid until:** 2026-04-15 (stable -- internal codebase patterns, no external API changes)
