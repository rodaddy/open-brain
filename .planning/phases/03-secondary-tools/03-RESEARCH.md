# Phase 3: Secondary Tools - Research

**Researched:** 2026-03-13
**Domain:** MCP tool registration (find_person, session_save, session_load), PostgreSQL ILIKE + semantic search, ON CONFLICT upsert, TEXT[] array handling
**Confidence:** HIGH

## Summary

Phase 3 adds three tools to complete the Open Brain tool suite: `find_person` (relationship lookup with dual search modes), `session_save` (write session summaries with structured fields), and `session_load` (retrieve most recent session by project). All three tools follow the exact patterns established in Phase 2 -- `registerTool()` with Zod raw shape schemas, `ToolDeps` dependency injection, `canRead`/`canWrite` permission checks, and the same test patterns (unit tests with mocked pool + protocol tests with InMemoryTransport).

The primary technical challenges are: (1) `find_person` needs two search modes -- ILIKE partial name match for direct lookups and semantic (embedding distance) search for queries like "who do I know at Google" -- and the tool must decide which mode to use based on input; (2) `session_save` must handle multiple TEXT[] array columns (`blockers`, `next_steps`, `key_decisions`) which node-postgres serializes automatically from JavaScript arrays; (3) the relationships table has a unique index on `person_name` requiring `ON CONFLICT (person_name) DO UPDATE` for upsert semantics.

The database schema is already fully defined in the 001_init.sql migration. No new tables or migrations are needed. The relationships table has `CHECK (warmth BETWEEN 1 AND 5)`, a unique index on `person_name`, and HNSW index on `embedding`. The sessions table has a composite index on `(project, created_at DESC)` which directly supports `session_load`'s "most recent session for project" query pattern.

**Primary recommendation:** Follow Phase 2 patterns exactly. Use ILIKE for name-based `find_person`, embedding distance for semantic `find_person`. Use `ON CONFLICT (person_name) DO UPDATE` for relationship upserts. Pass JavaScript arrays directly to `pg` for TEXT[] columns.

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|-----------------|
| TOOL-04 | `find_person` tool -- relationship lookup with warmth score | ILIKE partial match for name search, embedding distance for semantic search, dual-mode based on input analysis, canRead permission check |
| TOOL-05 | `session_save` tool -- write full session summary with structured fields | INSERT with TEXT[] arrays (blockers, next_steps, key_decisions), embedding of summary content, canWrite permission check, content_hash dedup |
| TOOL-06 | `session_load` tool -- read latest session context for a project or globally | `ORDER BY created_at DESC LIMIT 1` with optional `WHERE project = $1`, composite index `(project, created_at DESC)` supports this, canRead permission check |
| DATA-01 | Relationships table tracks everyone with last contact date and warmth score | Schema already exists: person_name, context, warmth (1-5 CHECK), last_contact DATE, notes, tags TEXT[], unique index on person_name |
| DATA-03 | Sessions table stores full summaries + structured fields for semantic search | Schema already exists: project, summary, tags TEXT[], blockers TEXT[], next_steps TEXT[], key_decisions TEXT[], embedding halfvec(768), composite index on (project, created_at DESC) |
</phase_requirements>

## Standard Stack

### Core (already installed from Phase 1)
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| @modelcontextprotocol/sdk | ^1.27.1 | McpServer.registerTool(), InMemoryTransport, Client | Official SDK, verified from installed source |
| zod | ^4.3.6 | Tool input schema validation | SDK auto-detects Zod version via zod-compat |
| pg | ^8.20.0 | PostgreSQL queries, TEXT[] auto-serialization | Already configured with pgvector type registration |
| pgvector | ^0.2.1 | toSql() for halfvec serialization | Handles halfvec format for embedding inserts |

### Supporting (already installed)
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| bun:test | built-in | Unit tests and protocol tests | All test files |

### No New Dependencies
Phase 3 requires zero new package installations. Everything is in place from Phase 1.

## Architecture Patterns

### Recommended Project Structure (additions for Phase 3)
```
src/
  tools/
    find-person.ts        # find_person tool registration
    session-save.ts       # session_save tool registration
    session-load.ts       # session_load tool registration
    index.ts              # registerAllTools -- add 3 new tools
    log-thought.ts        # (existing)
    log-decision.ts       # (existing)
    search-brain.ts       # (existing)
    __tests__/
      find-person.test.ts      # Unit tests (mocked deps)
      session-save.test.ts     # Unit tests (mocked deps)
      session-load.test.ts     # Unit tests (mocked deps)
      protocol.test.ts         # Add protocol tests for 3 new tools
      log-thought.test.ts      # (existing)
      log-decision.test.ts     # (existing)
      search-brain.test.ts     # (existing)
```

### Pattern 1: Dual-Mode Search in find_person

**What:** `find_person` supports two modes: (a) ILIKE name match for direct lookups like "Alice" or "Bob Smith", and (b) semantic embedding search for contextual queries like "who do I know at Google" or "ML engineers". The tool auto-detects which mode to use based on a `mode` parameter or defaults to name-based search.

**When to use:** `find_person` tool implementation.

**Example:**
```typescript
// Mode 1: Name-based search (ILIKE)
const nameSearchSQL = `
  SELECT id, person_name, context, warmth, last_contact, notes, tags, created_at
  FROM relationships
  WHERE person_name ILIKE $1
  ORDER BY warmth DESC NULLS LAST, last_contact DESC NULLS LAST
  LIMIT $2
`;
// params: [`%${args.query}%`, limit]

// Mode 2: Semantic search (embedding distance)
const semanticSearchSQL = `
  SELECT id, person_name, context, warmth, last_contact, notes, tags, created_at,
         embedding <=> $1::halfvec(768) AS distance
  FROM relationships
  WHERE embedding IS NOT NULL
  ORDER BY distance ASC
  LIMIT $2
`;
// params: [toSql(embedding), limit]
```

**Key design decision:** Use an explicit `mode` parameter (`"name"` | `"semantic"`) rather than trying to auto-detect intent from the query string. Auto-detection is fragile (is "Google" a person name or a company?). Let the caller choose. Default to `"name"` since that's the most common use case and doesn't require an embedding call.

### Pattern 2: ON CONFLICT Upsert for Relationships

**What:** The relationships table has a unique index on `person_name`. When inserting a person who already exists, update their fields instead of failing or silently dropping.

**When to use:** Any tool that writes to the relationships table (currently `find_person` doesn't write -- but a future `add_person`/`update_person` tool would, or `find_person` could include an upsert variant). For Phase 3, this pattern applies if `find_person` includes write capabilities, or it documents the pattern for the data model requirement (DATA-01).

**Example:**
```typescript
// Source: PostgreSQL ON CONFLICT docs, verified against idx_relationships_person unique index
const upsertSQL = `
  INSERT INTO relationships (person_name, context, warmth, last_contact, notes, tags, created_by, embedding, content_hash, embedded_at, embedding_model)
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
  ON CONFLICT (person_name) DO UPDATE SET
    context = COALESCE(EXCLUDED.context, relationships.context),
    warmth = COALESCE(EXCLUDED.warmth, relationships.warmth),
    last_contact = COALESCE(EXCLUDED.last_contact, relationships.last_contact),
    notes = COALESCE(EXCLUDED.notes, relationships.notes),
    tags = EXCLUDED.tags,
    embedding = COALESCE(EXCLUDED.embedding, relationships.embedding),
    content_hash = COALESCE(EXCLUDED.content_hash, relationships.content_hash),
    embedded_at = COALESCE(EXCLUDED.embedded_at, relationships.embedded_at),
    embedding_model = COALESCE(EXCLUDED.embedding_model, relationships.embedding_model),
    updated_at = NOW()
  RETURNING id
`;
```

**Critical detail:** The unique index `idx_relationships_person` is NOT a partial index (no WHERE clause), so `ON CONFLICT (person_name)` works directly without needing a predicate. This is simpler than the `content_hash` conflict handling which requires `WHERE content_hash IS NOT NULL`.

### Pattern 3: Session Save with TEXT[] Arrays

**What:** The sessions table has three TEXT[] columns (`blockers`, `next_steps`, `key_decisions`). Node-postgres (`pg`) automatically serializes JavaScript arrays to PostgreSQL array literals.

**When to use:** `session_save` tool implementation.

**Example:**
```typescript
// Source: node-postgres docs -- JS arrays auto-serialize to PG TEXT[] arrays
// No JSON.stringify needed for TEXT[] columns -- only for JSONB columns
const insertSQL = `
  INSERT INTO sessions (project, summary, tags, blockers, next_steps, key_decisions, created_by, embedding, content_hash, embedded_at, embedding_model)
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
  ON CONFLICT (content_hash) WHERE content_hash IS NOT NULL DO NOTHING
  RETURNING id, created_at
`;

// params -- JS arrays passed directly, pg serializes them
const params = [
  args.project ?? null,             // TEXT (nullable)
  args.summary,                     // TEXT NOT NULL
  args.tags ?? [],                  // TEXT[] -- JS array -> PG array
  args.blockers ?? [],              // TEXT[] -- JS array -> PG array
  args.next_steps ?? [],            // TEXT[] -- JS array -> PG array
  args.key_decisions ?? [],         // TEXT[] -- JS array -> PG array
  auth.clientId,                    // TEXT NOT NULL
  embedding ? toSql(embedding) : null,  // halfvec(768)
  hash,                             // TEXT
  embedding ? new Date().toISOString() : null,  // TIMESTAMPTZ
  embedding ? "gemini-embedding-001" : null,    // TEXT
];
```

### Pattern 4: Session Load with Optional Project Filter

**What:** Retrieve the most recent session, optionally filtered by project. The composite index `(project, created_at DESC)` efficiently supports this.

**When to use:** `session_load` tool implementation.

**Example:**
```typescript
// With project filter -- uses idx_sessions_project (project, created_at DESC)
const withProjectSQL = `
  SELECT id, project, summary, tags, blockers, next_steps, key_decisions, created_by, created_at
  FROM sessions
  WHERE project = $1
  ORDER BY created_at DESC
  LIMIT 1
`;

// Without project filter (global latest)
const globalSQL = `
  SELECT id, project, summary, tags, blockers, next_steps, key_decisions, created_by, created_at
  FROM sessions
  ORDER BY created_at DESC
  LIMIT 1
`;
```

**Alternative:** Use a single parameterized query with `WHERE ($1::text IS NULL OR project = $1)` to handle both cases. However, this can confuse the query planner and prevent index usage. Two separate queries is clearer and guarantees index utilization.

### Pattern 5: Registering New Tools in the Orchestrator

**What:** Add the three new tool registrations to `registerAllTools()` in `src/tools/index.ts`.

**Example:**
```typescript
// src/tools/index.ts -- updated
import { registerFindPerson } from "./find-person.ts";
import { registerSessionSave } from "./session-save.ts";
import { registerSessionLoad } from "./session-load.ts";

export function registerAllTools(server: McpServer, deps: ToolDeps): void {
  // Phase 2 tools
  registerLogThought(server, deps);
  registerLogDecision(server, deps);
  registerSearchBrain(server, deps);
  // Phase 3 tools
  registerFindPerson(server, deps);
  registerSessionSave(server, deps);
  registerSessionLoad(server, deps);
}
```

### Anti-Patterns to Avoid
- **Auto-detecting name vs semantic search from query text:** Don't try to infer whether "Google" means a person name or a company. Use an explicit `mode` parameter. The caller (LLM) is better positioned to decide.
- **Using JSON.stringify for TEXT[] columns:** node-postgres auto-serializes JS arrays to PostgreSQL array literals (`{a,b,c}`). Only use `JSON.stringify()` for JSONB columns (like `alternatives` in decisions). Using `JSON.stringify` for TEXT[] will cause type mismatch errors.
- **Single dynamic query for session_load with and without project:** Prefer two simple queries over one with `($1::text IS NULL OR project = $1)`. The conditional approach confuses the planner and may skip the composite index.
- **Forgetting updated_at on upsert:** The `trg_relationships_updated_at` trigger fires on UPDATE, so `updated_at` is auto-maintained. But it's good practice to explicitly set it in DO UPDATE for clarity.
- **Not checking read permissions on find_person:** Even though it's a "find" tool, it reads from the relationships table. `canRead(auth.role, "relationships")` must be checked. Discord role has NONE on relationships.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| TEXT[] serialization | Manual `'{' + items.join(',') + '}'` | Pass JS array directly to pg | pg handles escaping, NULL, nested arrays, special characters |
| Vector serialization | `JSON.stringify(embedding)` | `toSql(embedding)` from pgvector/pg | Handles halfvec format correctly |
| Partial name matching | Custom fuzzy match algorithm | PostgreSQL `ILIKE '%term%'` | Database-native, index-friendly with pg_trgm if needed |
| Most recent session | Fetch all sessions + sort in JS | `ORDER BY created_at DESC LIMIT 1` | Database handles it with index support |
| Input validation | Manual arg checking | Zod schemas in registerTool | SDK validates before handler runs, returns structured errors |
| Upsert logic | SELECT-then-INSERT/UPDATE | `ON CONFLICT DO UPDATE` | Atomic, race-condition-free, single round trip |

**Key insight:** The database schema already has all the indexes and constraints needed. The composite index `(project, created_at DESC)` is purpose-built for `session_load`. The unique index on `person_name` enables atomic upserts. The CHECK constraint on `warmth` validates the 1-5 range at the database level. The tools just need to use these correctly.

## Common Pitfalls

### Pitfall 1: JSON.stringify vs Raw Arrays for TEXT[] Columns
**What goes wrong:** Using `JSON.stringify(["blocker1", "blocker2"])` for TEXT[] columns produces `'["blocker1","blocker2"]'` (a JSON string), not `'{"blocker1","blocker2"}'` (a PostgreSQL array literal). PostgreSQL rejects this with a type mismatch error.
**Why it happens:** Phase 2 used `JSON.stringify(args.alternatives ?? [])` for the JSONB `alternatives` column in decisions. Developers may copy that pattern for TEXT[] columns.
**How to avoid:** Pass JavaScript arrays directly as parameters for TEXT[] columns. Only use `JSON.stringify()` for JSONB columns.
**Warning signs:** `invalid input syntax for type text[]` error from PostgreSQL.

### Pitfall 2: ON CONFLICT with Partial vs Non-Partial Unique Index
**What goes wrong:** Using `ON CONFLICT (person_name) WHERE person_name IS NOT NULL` when the index has no WHERE clause, or omitting a required WHERE clause on a partial index.
**Why it happens:** The `content_hash` unique indexes are partial (`WHERE content_hash IS NOT NULL`), but the `person_name` unique index is NOT partial. Developers may confuse the two patterns.
**How to avoid:** Check the actual index definition. `idx_relationships_person` is `CREATE UNIQUE INDEX idx_relationships_person ON relationships (person_name)` -- no WHERE clause. Use `ON CONFLICT (person_name)` without a predicate. For content_hash, use `ON CONFLICT (content_hash) WHERE content_hash IS NOT NULL`.
**Warning signs:** `there is no unique or exclusion constraint matching the ON CONFLICT specification` error.

### Pitfall 3: Warmth Score Validation Mismatch
**What goes wrong:** Zod schema allows warmth 0 or 6, but database CHECK constraint `warmth BETWEEN 1 AND 5` rejects the insert. User gets a cryptic database error instead of a clean validation message.
**Why it happens:** Zod validation and database constraint defined independently; they can drift.
**How to avoid:** Match Zod schema exactly to database constraint: `z.number().int().min(1).max(5)`. This rejects invalid values at the MCP protocol level with a clear Zod validation error before hitting the database.
**Warning signs:** Database CHECK violation errors in production logs.

### Pitfall 4: ILIKE Injection via Percent/Underscore Characters
**What goes wrong:** User searches for "100%" and the `%` in the search term matches any suffix, returning unexpected results.
**Why it happens:** In `ILIKE`, `%` and `_` are wildcards. When wrapping user input in `%${query}%`, special characters in the query are interpreted as ILIKE wildcards.
**How to avoid:** Escape ILIKE special characters before wrapping: `query.replace(/%/g, '\\%').replace(/_/g, '\\_')`. Or use PostgreSQL's `LIKE ... ESCAPE '\'` syntax. For this project, the risk is low (person names rarely contain % or _), but it's good hygiene.
**Warning signs:** Searches for names with underscores or percent signs return wrong results.

### Pitfall 5: session_load Returns pg TEXT[] as String
**What goes wrong:** PostgreSQL returns TEXT[] columns as strings like `{"item1","item2"}` instead of JavaScript arrays when the column value is retrieved via `pool.query()`.
**Why it happens:** By default, node-postgres (`pg`) DOES parse TEXT[] columns into JavaScript arrays. However, if type parsing is overridden or misconfigured, arrays may come back as raw strings.
**How to avoid:** The project's pool setup already calls `registerTypes(pool)` from pgvector which doesn't interfere with built-in array parsing. TEXT[] columns should return as JS arrays automatically. Verify in tests by checking `Array.isArray(result.blockers)`.
**Warning signs:** Returned data has `{item1,item2}` strings instead of `["item1","item2"]` arrays.

### Pitfall 6: Missing Permission Check on session_save Write
**What goes wrong:** `session_save` accepts writes from roles that shouldn't have write access to sessions.
**Why it happens:** Forgetting to check `canWrite(auth.role, "sessions")`. The success criteria says "only admin/agent/n8n roles can write" -- discord and readonly should be denied.
**How to avoid:** Check the permissions matrix. Discord has NONE on sessions, readonly has RO on sessions. Only admin, agent, and n8n have write. Use `canWrite(auth.role, "sessions")` which returns true for admin/agent/n8n and false for discord/readonly.
**Warning signs:** Discord or readonly consumers successfully saving sessions.

### Pitfall 7: Embedding Text for find_person Upsert
**What goes wrong:** Embedding only the person_name, which gives poor semantic search results for queries like "who do I know at Google".
**Why it happens:** Choosing minimal text for embedding instead of rich context.
**How to avoid:** Embed a concatenation of relevant fields: `${person_name}\n${context ?? ''}\n${notes ?? ''}`. This produces embeddings that capture the person's professional context, company, role, and notes -- enabling semantic queries about companies, industries, or topics.
**Warning signs:** Semantic search mode in find_person returns irrelevant results.

## Code Examples

### find_person Input Schema
```typescript
// Source: REQUIREMENTS.md TOOL-04, relationships table schema
{
  query: z.string().min(1).describe("Person name or semantic search query"),
  mode: z.enum(["name", "semantic"])
    .optional()
    .describe("Search mode: 'name' for ILIKE partial match (default), 'semantic' for embedding-based contextual search"),
  limit: z.number().int().min(1).max(20)
    .optional()
    .describe("Maximum results to return (default 5)"),
}
```

### find_person Result Format
```typescript
// Each result includes all relationship fields
interface PersonResult {
  id: string;
  person_name: string;
  context: string | null;
  warmth: number | null;     // 1-5
  last_contact: string | null; // DATE as ISO string
  notes: string | null;
  tags: string[];
  created_at: string;
  distance?: number;          // Only present in semantic mode
}
```

### session_save Input Schema
```typescript
// Source: REQUIREMENTS.md TOOL-05, sessions table schema
{
  summary: z.string().min(1).describe("Full session summary text"),
  project: z.string().optional().describe("Project name this session relates to"),
  tags: z.array(z.string()).optional().describe("Optional tags"),
  blockers: z.array(z.string()).optional().describe("Current blockers"),
  next_steps: z.array(z.string()).optional().describe("Planned next steps"),
  key_decisions: z.array(z.string()).optional().describe("Key decisions made during this session"),
}
```

### session_save Embedding Text Construction
```typescript
// Embed the summary content for semantic search across session history
const textToEmbed = args.summary;
const hash = contentHash(textToEmbed);
const embedding = await deps.embedFn(textToEmbed);
```

### session_load Input Schema
```typescript
// Source: REQUIREMENTS.md TOOL-06
{
  project: z.string().optional().describe("Project name to load session for (omit for most recent global session)"),
}
```

### session_load Return Format
```typescript
// Returns full session record or "no sessions found" message
// On success:
return {
  content: [{
    type: "text" as const,
    text: JSON.stringify({
      id: row.id,
      project: row.project,
      summary: row.summary,
      tags: row.tags,         // TEXT[] -> JS array (auto by pg)
      blockers: row.blockers, // TEXT[] -> JS array
      next_steps: row.next_steps,       // TEXT[] -> JS array
      key_decisions: row.key_decisions, // TEXT[] -> JS array
      created_by: row.created_by,
      created_at: row.created_at,
    }),
  }],
};

// On no results:
return {
  content: [{
    type: "text" as const,
    text: args.project
      ? `No sessions found for project: ${args.project}`
      : "No sessions found",
  }],
};
```

### Tool Annotations for Phase 3 Tools
```typescript
// find_person -- read-only search tool
annotations: {
  title: "Find Person",
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
}

// session_save -- write tool
annotations: {
  title: "Save Session",
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,  // Each save creates a new session record
}

// session_load -- read-only tool
annotations: {
  title: "Load Session",
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
}
```

### Permission Matrix for Phase 3 Tools

| Role | find_person | session_save | session_load |
|------|-------------|--------------|--------------|
| admin | read (yes) | write (yes) | read (yes) |
| agent | read (yes) | write (yes) | read (yes) |
| discord | none (denied) | none (denied) | none (denied) |
| n8n | read (yes) | write (yes) | read (yes) |
| readonly | read (yes) | write (no) | read (yes) |

Source: `src/permissions.ts` -- discord has NONE on relationships and sessions; readonly has RO on sessions.

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| `server.tool()` | `server.registerTool()` | MCP SDK v1.27+ | Old API deprecated, Phase 2 already uses registerTool |
| Manual fuzzy matching | PostgreSQL ILIKE + pgvector semantic | Established pattern | Two complementary search modes cover exact and contextual lookups |
| SELECT-then-UPDATE for person upsert | `ON CONFLICT (person_name) DO UPDATE` | PostgreSQL 9.5+ | Atomic, no race conditions, single round trip |
| JSON columns for structured arrays | TEXT[] native PostgreSQL arrays | Phase 1 schema design | Better indexing, native array operators, pg auto-serialization |

**Deprecated/outdated:**
- `server.tool()`: Still exists in SDK but deprecated. All tools use `registerTool()`.
- Manual array serialization for pg: node-postgres handles TEXT[] natively since pg@7.x.

## Open Questions

1. **Should find_person have a write mode (add/update person)?**
   - What we know: The success criteria says `find_person` "searches" and "returns person details". DATA-01 requires the data model with upsert on person_name. The relationships table already has a unique index supporting upserts.
   - What's unclear: Whether `find_person` should also handle creating/updating people, or if that should be a separate `add_person` tool.
   - Recommendation: Keep `find_person` as read-only search. The DATA-01 requirement for "upsert on person name for concurrent safety" establishes the database-level pattern -- search_brain already covers write-side dedup for other tables. A future phase could add `add_person` if needed, or the upsert pattern can be documented as the way relationships are populated (e.g., via n8n workflows or direct SQL). **However**, the success criteria item 4 says "Relationships table enforces the data model... with upsert on person name for concurrent safety" -- this means the upsert SQL must be tested. Consider including a `registerFindPerson` that also handles upsert writes, or split into `find_person` (read) + ensure the upsert works via a test. The planner should decide.

2. **session_save: Should content_hash dedup be applied?**
   - What we know: The sessions table has a partial unique index on `content_hash`. Phase 2 tools use content_hash dedup for thoughts and decisions.
   - What's unclear: Whether duplicate session summaries should be silently dropped (like thoughts) or always inserted (each session is unique even if summary text is similar).
   - Recommendation: Apply content_hash dedup for consistency. Identical session summaries within seconds are likely retries/duplicates. The `ON CONFLICT (content_hash) WHERE content_hash IS NOT NULL DO NOTHING` pattern is already established.

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | bun:test (Bun built-in, Jest-compatible API) |
| Config file | bunfig.toml (exists from Phase 1) |
| Quick run command | `bun test src/tools/` |
| Full suite command | `bun test` |

### Phase Requirements -> Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| TOOL-04 | find_person name-based ILIKE search returns person details with warmth | unit | `bun test src/tools/__tests__/find-person.test.ts -x` | No -- Wave 0 |
| TOOL-04 | find_person semantic search returns ranked results by embedding distance | unit | `bun test src/tools/__tests__/find-person.test.ts -x` | No -- Wave 0 |
| TOOL-04 | find_person protocol test -- call via Client, validate response format | protocol | `bun test src/tools/__tests__/protocol.test.ts -x` | Exists -- add tests |
| TOOL-05 | session_save inserts summary + structured TEXT[] fields + embedding | unit | `bun test src/tools/__tests__/session-save.test.ts -x` | No -- Wave 0 |
| TOOL-05 | session_save permission denied for readonly/discord | unit | `bun test src/tools/__tests__/session-save.test.ts -x` | No -- Wave 0 |
| TOOL-05 | session_save protocol test -- full round-trip with structured fields | protocol | `bun test src/tools/__tests__/protocol.test.ts -x` | Exists -- add tests |
| TOOL-06 | session_load returns most recent session for project | unit | `bun test src/tools/__tests__/session-load.test.ts -x` | No -- Wave 0 |
| TOOL-06 | session_load returns global latest when no project specified | unit | `bun test src/tools/__tests__/session-load.test.ts -x` | No -- Wave 0 |
| TOOL-06 | session_load protocol test -- with and without project filter | protocol | `bun test src/tools/__tests__/protocol.test.ts -x` | Exists -- add tests |
| DATA-01 | Relationships upsert on person_name with all fields | unit | `bun test src/tools/__tests__/find-person.test.ts -x` | No -- Wave 0 |
| DATA-03 | Sessions table stores structured fields correctly | unit | `bun test src/tools/__tests__/session-save.test.ts -x` | No -- Wave 0 |

### Sampling Rate
- **Per task commit:** `bun test src/tools/`
- **Per wave merge:** `bun test`
- **Phase gate:** Full suite green before `/gsd:verify-work`

### Wave 0 Gaps
- [ ] `src/tools/__tests__/find-person.test.ts` -- unit tests for name + semantic modes, permission checks
- [ ] `src/tools/__tests__/session-save.test.ts` -- unit tests for structured fields, TEXT[] arrays, permission checks
- [ ] `src/tools/__tests__/session-load.test.ts` -- unit tests for project filter, global latest, empty results
- [ ] Protocol tests added to existing `src/tools/__tests__/protocol.test.ts` for all 3 new tools

## Sources

### Primary (HIGH confidence)
- Installed codebase: `src/tools/log-thought.ts`, `src/tools/log-decision.ts`, `src/tools/search-brain.ts` -- established registerTool pattern with ToolDeps
- Installed codebase: `src/tools/index.ts` -- registerAllTools orchestrator with ToolDeps interface
- Installed codebase: `src/permissions.ts` -- canRead/canWrite with full role/table matrix
- Installed codebase: `src/tools/__tests__/*.test.ts` -- established test patterns (mock pool, mock embed, setupToolClient, createProtocolClient)
- Database schema: `src/db/migrations/001_init.sql` -- relationships and sessions table definitions with indexes and constraints
- Installed SDK source: `node_modules/@modelcontextprotocol/sdk/` -- registerTool, InMemoryTransport, Client APIs

### Secondary (MEDIUM confidence)
- [PostgreSQL ILIKE docs](https://www.postgresql.org/docs/current/functions-matching.html) -- pattern matching with case-insensitive LIKE
- [PostgreSQL ON CONFLICT docs](https://www.postgresql.org/docs/current/sql-insert.html) -- upsert with EXCLUDED reference, partial index predicates
- [node-postgres array serialization](https://node-postgres.com/features/queries) -- JS arrays auto-serialize to PostgreSQL array literals for TEXT[] columns
- [pgvector cosine distance](https://github.com/pgvector/pgvector) -- `<=>` operator for cosine distance with halfvec

### Tertiary (LOW confidence)
- None -- all findings verified from installed source code or official documentation

## Metadata

**Confidence breakdown:**
- Tool registration pattern: HIGH -- directly copying established Phase 2 pattern from codebase
- ILIKE name search: HIGH -- standard PostgreSQL feature, straightforward parameterized query
- Semantic search mode: HIGH -- same embedding distance pattern as search_brain, verified in codebase
- ON CONFLICT upsert: HIGH -- verified against actual unique index definition in 001_init.sql (non-partial)
- TEXT[] array handling: HIGH -- verified node-postgres auto-serialization from official docs, confirmed no interference from pgvector registerTypes
- Permission matrix: HIGH -- read directly from src/permissions.ts
- Test patterns: HIGH -- copying exact patterns from existing Phase 2 test files

**Research date:** 2026-03-13
**Valid until:** 2026-04-13 (stable ecosystem, all dependencies pinned from Phase 1)
