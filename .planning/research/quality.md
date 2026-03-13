# Quality & Testing Research: Open Brain

**Domain:** MCP server (Bun + Express.js + PostgreSQL/pgvector)
**Researched:** 2026-03-13
**Overall confidence:** HIGH

---

## 1. Bun Test Runner

**Confidence: HIGH** (official docs verified)

### Capabilities

Bun ships a built-in, Jest-compatible test runner with zero configuration. It handles TypeScript natively, runs 3-10x faster than Vitest (which itself is 3.7x faster than Jest), and is the correct choice for a Bun-native project.

| Feature | Status | Notes |
|---------|--------|-------|
| `describe`/`it`/`test` | Supported | Standard Jest-style organization |
| Lifecycle hooks | Supported | `beforeAll`, `afterAll`, `beforeEach`, `afterEach` |
| Assertions | Full Jest API | `toBe`, `toEqual`, `toBeCloseTo`, `toContain`, etc. |
| Mocking | Full | `mock()`, `jest.fn()`, `spyOn()`, `mock.module()` |
| Module mocking | Supported | `mock.module("pg", () => ...)` -- updates live bindings |
| Snapshot testing | Supported | `toMatchSnapshot()`, `--update-snapshots` |
| Code coverage | Built-in | `--coverage` flag, text + lcov formats |
| Coverage thresholds | Supported | `coverageThreshold = { lines = 0.9, functions = 0.9 }` |
| Timeouts | Configurable | Default 5s, `--timeout` flag or per-test `{ timeout: N }` |
| Parallelism | Supported | `--concurrent`, `--max-concurrency` (default 20) |
| CI integration | Auto-detected | GitHub Actions annotations, JUnit XML via `--reporter=junit` |
| Watch mode | Supported | `bun test --watch` |

### File Discovery

Bun auto-discovers test files matching: `*.test.ts`, `*_test.ts`, `*.spec.ts`, `*_spec.ts` (and `.js`/`.tsx`/`.jsx` variants).

### Recommended Organization

```
src/
  tools/
    search-brain.ts
    search-brain.test.ts        # Unit test co-located with source
    log-thought.ts
    log-thought.test.ts
  db/
    queries.ts
    queries.test.ts
  middleware/
    auth.ts
    auth.test.ts
test/
  integration/
    tools.integration.test.ts   # Full MCP protocol tests
    db.integration.test.ts      # Real database tests
  fixtures/
    vectors.ts                  # Pre-computed test embeddings
    seed-data.ts                # Database seed helpers
```

### Coverage Configuration (bunfig.toml)

```toml
[test]
coverage = true
coverageReporter = ["text", "lcov"]
coverageDir = "coverage"
coverageSkipTestFiles = true
coverageThreshold = { lines = 0.8, functions = 0.8, statements = 0.8 }
```

### Key Limitation

Testcontainers for Node.js has known compatibility issues with Bun (Docker socket connectivity). This affects the integration testing strategy -- see Section 4 below.

---

## 2. Testing MCP Servers

**Confidence: HIGH** (SDK source + community examples verified)

### Unit Testing: InMemoryTransport Pattern

The `@modelcontextprotocol/sdk` provides `InMemoryTransport` -- a pair of linked in-memory transports that let you test the full MCP protocol without spawning subprocesses or opening ports. This is the correct approach for unit-testing tool handlers.

```typescript
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

describe("search_brain tool", () => {
  let server: McpServer;
  let client: Client;

  beforeEach(async () => {
    // Create server with tools registered
    server = createOpenBrainServer({ db: mockDb, embedder: mockEmbedder });

    // Create linked in-memory transports
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    // Connect both sides
    await server.connect(serverTransport);
    client = new Client({ name: "test-client", version: "1.0.0" });
    await client.connect(clientTransport);
  });

  afterEach(async () => {
    await client.close();
    await server.close();
  });

  it("returns matching thoughts for semantic query", async () => {
    const result = await client.callTool({
      name: "search_brain",
      arguments: { query: "deployment strategy", limit: 5 },
    });

    expect(result.isError).toBeFalsy();
    const content = result.content as Array<{ type: string; text: string }>;
    expect(content[0].type).toBe("text");
    const parsed = JSON.parse(content[0].text);
    expect(parsed.results.length).toBeGreaterThan(0);
  });

  it("returns isError for empty query", async () => {
    const result = await client.callTool({
      name: "search_brain",
      arguments: { query: "", limit: 5 },
    });

    expect(result.isError).toBe(true);
  });
});
```

### Testing Strategy by Layer

| Layer | What to Test | Approach | Speed |
|-------|-------------|----------|-------|
| Tool handler logic | Business logic, validation, transforms | Direct function calls with mocked deps | Fast |
| MCP protocol | Parameter schemas, response format, `isError` | `InMemoryTransport` + `Client` | Fast |
| HTTP transport | Auth headers, CORS, route handling | Supertest or `fetch()` against running server | Medium |
| Database queries | SQL correctness, vector search | Real PostgreSQL (CI service container) | Slow |
| End-to-end | Full stack: HTTP -> MCP -> DB -> response | Real server + real DB | Slowest |

### Recommended: Separate Server Factory from Transport

Structure the server so the MCP tool registration is decoupled from the transport:

```typescript
// src/server.ts -- pure MCP server factory (testable)
export function createBrainServer(deps: { db: Database; embedder: Embedder }) {
  const server = new McpServer({ name: "open-brain", version: "1.0.0" });

  server.tool("log_thought", { content: z.string(), tags: z.array(z.string()).optional() },
    async (args) => { /* uses deps.db, deps.embedder */ }
  );
  // ... more tools

  return server;
}

// src/main.ts -- wires transport (not tested directly)
const server = createBrainServer({ db: realDb, embedder: realEmbedder });
const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
```

This lets unit tests inject mock `db` and `embedder` while testing the full MCP protocol via `InMemoryTransport`.

### Integration Testing: MCP Inspector

For manual and smoke testing, use the official MCP Inspector:

```bash
npx @modelcontextprotocol/inspector
```

This provides a visual UI for invoking tools, viewing responses, and debugging protocol issues. Useful during development but not a substitute for automated tests.

---

## 3. Testing pgvector Queries

**Confidence: HIGH** (pgvector docs + Testcontainers docs verified)

### The Core Challenge

Vector similarity search returns floating-point distances and approximate results (when using indexes). Tests must account for:

1. **Floating-point imprecision** -- distances are not exact decimals
2. **Approximate vs. exact search** -- HNSW/IVFFlat indexes trade recall for speed
3. **Embedding determinism** -- same text should produce same vector from same model
4. **Result ordering** -- closest vectors first, but ties are non-deterministic

### Pre-computed Test Embeddings

Use pre-computed, deterministic embedding vectors in tests instead of calling the real embedding API. This eliminates network dependency and makes assertions deterministic.

```typescript
// test/fixtures/vectors.ts
export const TEST_EMBEDDINGS = {
  // Real embeddings from text-embedding-004 (768 dims), captured once
  deployment: Float32Array.from([0.023, -0.041, 0.089, /* ... 768 values */]),
  kubernetes: Float32Array.from([0.019, -0.038, 0.092, /* ... 768 values */]),
  unrelated:  Float32Array.from([0.891, 0.234, -0.567, /* ... 768 values */]),
} as const;

// Helper to generate a vector as pgvector literal
export function toPgVector(embedding: Float32Array): string {
  return `[${Array.from(embedding).join(",")}]`;
}
```

### Floating-Point Assertions

Use `toBeCloseTo` for distance comparisons and `expect.closeTo` for distances nested in objects:

```typescript
it("returns closer distance for related concepts", async () => {
  const results = await searchBrain(db, TEST_EMBEDDINGS.deployment, 2);

  // "kubernetes" should be closer to "deployment" than "unrelated"
  expect(results[0].distance).toBeLessThan(results[1].distance);

  // Distance should be in expected range (not exact)
  expect(results[0].distance).toBeCloseTo(0.15, 1); // 1 decimal precision
});

it("similarity scores are in valid range", async () => {
  const results = await searchBrain(db, TEST_EMBEDDINGS.deployment, 5);

  for (const r of results) {
    // Cosine distance is 0..2, similarity is -1..1
    expect(r.distance).toBeGreaterThanOrEqual(0);
    expect(r.distance).toBeLessThanOrEqual(2);
  }
});
```

### Testing Recall Quality

Compare approximate search (with index) against exact search (without index) to verify acceptable recall:

```sql
-- Exact search (disable index)
SET LOCAL enable_indexscan = off;
SELECT id, embedding <=> $1 AS distance FROM thoughts ORDER BY distance LIMIT 10;

-- Approximate search (with HNSW index)
RESET enable_indexscan;
SELECT id, embedding <=> $1 AS distance FROM thoughts ORDER BY distance LIMIT 10;
```

```typescript
it("HNSW recall is above 90% for top-10", async () => {
  const exact = await exactSearch(db, queryVector, 10);
  const approx = await approxSearch(db, queryVector, 10);

  const exactIds = new Set(exact.map((r) => r.id));
  const hits = approx.filter((r) => exactIds.has(r.id)).length;
  const recall = hits / exact.length;

  expect(recall).toBeGreaterThanOrEqual(0.9);
});
```

### Test Database Setup

For integration tests that hit a real database, use a dedicated `open_brain_test` database:

```typescript
// test/fixtures/seed-data.ts
export async function seedTestData(db: Pool) {
  await db.query("DELETE FROM thoughts");
  await db.query("DELETE FROM decisions");
  // ... clear all tables

  // Insert known test data with pre-computed embeddings
  await db.query(
    `INSERT INTO thoughts (content, embedding, tags, created_at)
     VALUES ($1, $2, $3, NOW())`,
    ["Deploy to k8s", toPgVector(TEST_EMBEDDINGS.deployment), ["infra", "k8s"]]
  );
  // ... more seed data
}

export async function resetTestDb(db: Pool) {
  // Truncate is faster than DELETE for test resets
  await db.query("TRUNCATE thoughts, decisions, relationships, projects, sessions CASCADE");
}
```

---

## 4. Integration Test Patterns

**Confidence: HIGH** (multiple sources verified)

### Testcontainers vs. Shared Test DB

| Approach | Pros | Cons | Recommendation |
|----------|------|------|----------------|
| Testcontainers | Fully isolated, disposable, no cleanup | Bun compatibility issues, slower startup | Use for CI (via Node.js runner) |
| Shared test DB | Fast, simple, works with Bun | Requires cleanup, potential test interference | Use for local dev |
| CI service container | Native GH Actions support, fast | Only for CI | Use in CI pipeline |

**Recommendation: Shared test database for local dev, GitHub Actions service container for CI.** Testcontainers has documented Bun compatibility issues (Docker socket connectivity). Skip the complexity.

### Database Integration Test Pattern

```typescript
// test/integration/db.integration.test.ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { Pool } from "pg";
import { resetTestDb, seedTestData } from "../fixtures/seed-data";

describe("database operations", () => {
  let db: Pool;

  beforeAll(async () => {
    db = new Pool({
      connectionString: process.env.TEST_DATABASE_URL
        ?? "postgresql://localhost:5432/open_brain_test",
    });
    // Run migrations
    await runMigrations(db);
  });

  afterAll(async () => {
    await db.end();
  });

  beforeEach(async () => {
    await resetTestDb(db);
    await seedTestData(db);
  });

  it("inserts a thought with embedding", async () => {
    const result = await logThought(db, {
      content: "Test thought",
      embedding: TEST_EMBEDDINGS.deployment,
      tags: ["test"],
    });

    expect(result.id).toBeDefined();
    expect(result.content).toBe("Test thought");
  });

  it("finds thoughts by semantic search", async () => {
    const results = await searchThoughts(db, TEST_EMBEDDINGS.kubernetes, 5);

    expect(results.length).toBeGreaterThan(0);
    // "deployment" embedding should be semantically close to "kubernetes"
    expect(results[0].content).toBe("Deploy to k8s");
  });
});
```

### Testing Express Middleware (Auth)

```typescript
// src/middleware/auth.test.ts
import { describe, it, expect } from "bun:test";
import { createAuthMiddleware } from "./auth";

describe("Bearer token auth", () => {
  const middleware = createAuthMiddleware({
    tokens: {
      "test-admin-token": { role: "admin", tables: ["*"] },
      "test-reader-token": { role: "reader", tables: ["thoughts", "sessions"] },
    },
  });

  it("rejects missing Authorization header", async () => {
    const req = new Request("http://localhost/mcp", { method: "POST" });
    const result = await middleware(req);
    expect(result.status).toBe(401);
  });

  it("rejects invalid token", async () => {
    const req = new Request("http://localhost/mcp", {
      method: "POST",
      headers: { Authorization: "Bearer bad-token" },
    });
    const result = await middleware(req);
    expect(result.status).toBe(401);
  });

  it("passes valid admin token", async () => {
    const req = new Request("http://localhost/mcp", {
      method: "POST",
      headers: { Authorization: "Bearer test-admin-token" },
    });
    const result = await middleware(req);
    expect(result).toBeNull(); // null = proceed
  });

  it("enforces table-level permissions", async () => {
    // Reader token should not write to decisions
    const ctx = { role: "reader", tables: ["thoughts", "sessions"] };
    expect(canWrite(ctx, "decisions")).toBe(false);
    expect(canWrite(ctx, "thoughts")).toBe(true);
  });
});
```

### HTTP Transport Integration Test

```typescript
// test/integration/http.integration.test.ts
import { describe, it, expect, beforeAll, afterAll } from "bun:test";

describe("HTTP transport", () => {
  let server: ReturnType<typeof startServer>;
  let baseUrl: string;

  beforeAll(async () => {
    server = await startServer({ port: 0 }); // random port
    baseUrl = `http://localhost:${server.port}`;
  });

  afterAll(async () => {
    await server.close();
  });

  it("rejects unauthenticated requests", async () => {
    const res = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
        params: {},
      }),
    });
    expect(res.status).toBe(401);
  });

  it("lists tools for authenticated client", async () => {
    const res = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.TEST_TOKEN}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
        params: {},
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.result.tools).toBeArray();
    expect(body.result.tools.length).toBe(6);
  });
});
```

---

## 5. CI/CD Pipeline

**Confidence: HIGH** (GitHub Actions docs + pgvector/setup-pgvector verified)

### Recommended Pipeline

```yaml
# .github/workflows/ci.yml
name: CI

on:
  push:
    branches: [main, "wip/**", "feat/**", "fix/**"]
  pull_request:
    branches: [main]

jobs:
  quality:
    runs-on: ubuntu-latest

    services:
      postgres:
        image: pgvector/pgvector:pg17-bookworm
        env:
          POSTGRES_DB: open_brain_test
          POSTGRES_USER: postgres
          POSTGRES_PASSWORD: postgres
        options: >-
          --health-cmd "pg_isready -U postgres"
          --health-interval 10s
          --health-timeout 5s
          --health-retries 5
        ports:
          - 5432:5432

    steps:
      - uses: actions/checkout@v4

      - uses: oven-sh/setup-bun@v2
        with:
          bun-version: latest

      - name: Install dependencies
        run: bun install --frozen-lockfile

      - name: Typecheck
        run: bun run typecheck

      - name: Create pgvector extension
        run: |
          PGPASSWORD=postgres psql -h localhost -U postgres -d open_brain_test \
            -c "CREATE EXTENSION IF NOT EXISTS vector;"

      - name: Run migrations
        run: bun run migrate
        env:
          DATABASE_URL: postgresql://postgres:postgres@localhost:5432/open_brain_test

      - name: Unit tests
        run: bun test --coverage

      - name: Integration tests
        run: bun test test/integration/ --timeout 30000
        env:
          DATABASE_URL: postgresql://postgres:postgres@localhost:5432/open_brain_test
          TEST_TOKEN: ci-test-token

      - name: Upload coverage
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: coverage
          path: coverage/
```

### Key CI Decisions

| Decision | Rationale |
|----------|-----------|
| `pgvector/pgvector:pg17-bookworm` image | Pre-built with pgvector, no manual extension install needed beyond `CREATE EXTENSION` |
| Separate unit and integration test steps | Unit tests are fast and don't need DB; integration tests need the service container |
| `--frozen-lockfile` | Ensures reproducible installs in CI |
| Coverage upload as artifact | Available for review without external service dependency |
| Typecheck before tests | Catch type errors before spending time on test execution |

### Package.json Scripts

```json
{
  "scripts": {
    "typecheck": "tsc --noEmit",
    "test": "bun test",
    "test:unit": "bun test src/",
    "test:integration": "bun test test/integration/ --timeout 30000",
    "test:coverage": "bun test --coverage",
    "migrate": "bun run src/db/migrate.ts",
    "dev": "bun run --watch src/main.ts",
    "build": "bun build src/main.ts --outdir dist --target bun"
  }
}
```

---

## 6. Error Handling Patterns

**Confidence: HIGH** (MCP spec + SDK docs verified)

### Three-Tier Error Model

MCP servers handle errors at three layers:

| Layer | What | How |
|-------|------|-----|
| Transport | Network failures, connection drops | Express error handler, HTTP status codes |
| Protocol | Malformed JSON-RPC, unknown methods | SDK handles automatically via JSON-RPC error codes |
| Application | Invalid tool args, DB failures, business logic | Return `isError: true` in tool response |

### JSON-RPC Error Codes (handled by SDK)

| Code | Meaning | When |
|------|---------|------|
| -32700 | Parse Error | Invalid JSON received |
| -32600 | Invalid Request | Missing required JSON-RPC fields |
| -32601 | Method Not Found | Unknown method name |
| -32602 | Invalid Params | Schema validation failed (Zod) |
| -32603 | Internal Error | Unhandled server exception |

### Application Error Pattern: `isError` Flag

Tool handlers should **never throw exceptions**. Catch errors and return structured responses with `isError: true`. This lets the LLM understand what went wrong and potentially retry or ask the user.

```typescript
server.tool(
  "log_decision",
  {
    title: z.string().min(1, "Title is required"),
    rationale: z.string().min(1, "Rationale is required"),
    alternatives: z.array(z.string()).optional(),
    tags: z.array(z.string()).optional(),
  },
  async (args, extra) => {
    try {
      // Zod validation happens automatically before this runs.
      // Additional business validation:
      if (args.title.length > 500) {
        return {
          isError: true,
          content: [{ type: "text", text: "Title must be under 500 characters" }],
        };
      }

      const result = await deps.db.insertDecision(args);
      return {
        content: [{ type: "text", text: JSON.stringify({ id: result.id, status: "saved" }) }],
      };
    } catch (error) {
      // Log full error internally
      console.error("log_decision failed:", error);

      // Return sanitized error to client
      return {
        isError: true,
        content: [{
          type: "text",
          text: error instanceof Error
            ? `Failed to save decision: ${error.message}`
            : "Failed to save decision: unknown error",
        }],
      };
    }
  }
);
```

### Zod Validation

The MCP SDK uses Zod for tool parameter schemas. Validation happens automatically before the handler runs. If validation fails, the SDK returns a JSON-RPC `-32602 Invalid Params` error -- the handler never executes.

**Use Zod schemas as the first line of defense:**

```typescript
const SearchBrainSchema = {
  query: z.string().min(1, "Query cannot be empty").max(1000, "Query too long"),
  limit: z.number().int().min(1).max(100).default(10),
  tables: z.array(
    z.enum(["thoughts", "decisions", "relationships", "projects", "sessions"])
  ).optional(),
  tags: z.array(z.string()).optional(),
};
```

**Reserve `isError: true` for runtime failures** -- things Zod can't catch (DB down, embedding API timeout, no results found).

### Structured Error Helper

```typescript
// src/errors.ts
export function toolError(message: string) {
  return {
    isError: true as const,
    content: [{ type: "text" as const, text: message }],
  };
}

export function toolSuccess(data: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
  };
}

// Usage in tool handler:
if (results.length === 0) {
  return toolError("No results found for query. Try broader search terms.");
}
return toolSuccess({ results, count: results.length });
```

### Testing Error Scenarios

Every tool should have tests for:

1. **Valid input, happy path** -- correct response format
2. **Zod validation failure** -- empty strings, out-of-range numbers, wrong types
3. **Runtime failure** -- DB down, embedding API timeout
4. **Edge cases** -- very long input, special characters, empty arrays

```typescript
describe("error handling", () => {
  it("returns isError for database failure", async () => {
    // Mock DB to throw
    mockDb.query.mockRejectedValue(new Error("connection refused"));

    const result = await client.callTool({
      name: "log_thought",
      arguments: { content: "test thought" },
    });

    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ text: string }>)[0].text;
    expect(text).toContain("Failed");
    // Should NOT leak connection details
    expect(text).not.toContain("connection refused");
  });

  it("rejects invalid schema via protocol error", async () => {
    // Zod rejects this before handler runs
    try {
      await client.callTool({
        name: "search_brain",
        arguments: { query: 123 }, // should be string
      });
    } catch (error) {
      expect(error).toBeDefined();
      // SDK throws McpError with code -32602
    }
  });
});
```

---

## Summary: Test Matrix

| Tool | Unit (mocked DB) | Protocol (InMemoryTransport) | Integration (real DB) |
|------|:-:|:-:|:-:|
| `search_brain` | Query construction, result mapping | Response format, `isError` cases | Vector search accuracy, recall |
| `log_thought` | Validation, embedding call | Schema enforcement | Insert + retrieve roundtrip |
| `log_decision` | Business validation | Schema enforcement | Insert with tags, search back |
| `find_person` | Warmth score logic | Response format | Query by name, partial match |
| `session_save` | Field validation | Schema, structured fields | Write + read roundtrip |
| `session_load` | Fallback logic | Response when no session | Latest session retrieval |

### Libraries Needed

```bash
# Already included (Bun built-in)
# bun:test -- test runner, assertions, mocks

# MCP SDK (already a dependency)
bun add @modelcontextprotocol/sdk

# Database (already a dependency)
bun add pg
bun add -d @types/pg

# Schema validation (already a dependency via MCP SDK)
# zod -- comes with @modelcontextprotocol/sdk

# No additional test libraries needed.
# Bun's built-in test runner covers everything.
```

### Test Execution Order

```bash
# Local development
bun test                          # All tests
bun test src/                     # Unit tests only (fast)
bun test test/integration/        # Integration tests (needs DB)
bun test --coverage               # With coverage report
bun test --watch                  # Watch mode during development

# CI pipeline
bun run typecheck                 # 1. Type safety
bun test src/ --coverage          # 2. Unit tests + coverage
bun test test/integration/        # 3. Integration tests (service container DB)
```

---

## Sources

- [Bun Test Runner Docs](https://bun.com/docs/test)
- [Bun Code Coverage](https://bun.com/docs/test/coverage)
- [Bun Mocking API](https://bun.com/docs/test/mocks)
- [Bun Writing Tests](https://bun.com/docs/test/writing-tests)
- [Bun Matchers API (toBeCloseTo)](https://bun.com/reference/bun/test/Matchers)
- [MCP TypeScript SDK (InMemoryTransport)](https://github.com/modelcontextprotocol/typescript-sdk)
- [MCP E2E Testing Example](https://github.com/mkusaka/mcp-server-e2e-testing-example)
- [Unit Testing MCP Servers Guide](https://mcpcat.io/guides/writing-unit-tests-mcp-servers/)
- [MCP Error Handling Best Practices](https://mcpcat.io/guides/error-handling-custom-mcp-servers/)
- [MCP Inspector](https://github.com/modelcontextprotocol/inspector)
- [pgvector GitHub](https://github.com/pgvector/pgvector)
- [Testcontainers pgvector Module](https://testcontainers.com/modules/pgvector/)
- [Testcontainers Bun Compatibility Discussion](https://github.com/testcontainers/testcontainers-node/discussions/1115)
- [pgvector GitHub Actions Setup](https://github.com/pgvector/setup-pgvector)
- [GitHub Actions PostgreSQL Service Containers](https://docs.github.com/en/actions/tutorials/use-containerized-services/create-postgresql-service-containers)
