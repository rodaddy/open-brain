# Phase 4: Operational Hardening - Research

**Researched:** 2026-03-13
**Domain:** CI/CD, structured logging, embedding backfill, service deployment
**Confidence:** HIGH

## Summary

Phase 4 covers four independent operational concerns: (1) an embedding backfill script that retries NULL embeddings across all 5 tables, (2) a GitHub Actions CI pipeline with Bun and pgvector, (3) structured JSON request logging for every MCP tool call, and (4) deploying the server as a systemd service on an LXC container. None of these change the application's functional behavior -- they harden what already works.

The existing codebase is well-structured for all four. The logger already outputs structured JSON. The test suite uses `bun test` with mocked dependencies. The `generateEmbedding` function is pure and reusable for backfill. The deploy-service skill handles LXC + Caddy + DNS automation. Each deliverable can be implemented independently with no cross-dependencies.

**Primary recommendation:** Build all four as separate scripts/configs with no new dependencies -- the existing logger, pool, embedding, and test infrastructure are sufficient. Don't add logging libraries (pino, winston, morgan) -- the custom `logger.ts` already does structured JSON and adding a library would be over-engineering for a single-service MCP server.

## Standard Stack

### Core (already installed -- no new dependencies needed)

| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| bun | 1.3.9 | Runtime + test runner + bundler | Already the project runtime |
| express | ^5.2.1 | HTTP framework | Already installed, middleware pattern for logging |
| pg | ^8.20.0 | PostgreSQL driver | Already installed, used by backfill |
| pgvector | ^0.2.1 | Vector type support | Already installed, toSql for backfill |

### CI/CD

| Tool | Version | Purpose | Why Standard |
|------|---------|---------|--------------|
| oven-sh/setup-bun | v2 | GitHub Actions Bun setup | Official Bun CI action |
| pgvector/pgvector | pg16 | Docker image for CI service | Official pgvector image with postgres + vector extension pre-installed |
| actions/checkout | v4 | Repo checkout | Standard GHA action |

### Alternatives Considered

| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| Custom logger.ts | pino + pino-http | Pino is faster and has more features, but this is a single-service MCP server -- custom logger is 36 lines, already structured JSON, zero deps. Not worth the dependency. |
| Custom logger.ts | morgan + winston | Even heavier. Morgan is HTTP-only, would need winston for app logs. Two deps for what 50 lines of custom code handles. |
| systemd unit | Docker/Podman | LXC + systemd is the project's established deployment pattern (deploy-service skill). Docker would require a separate workflow. |

## Architecture Patterns

### Recommended Project Structure (new files only)

```
scripts/
  backfill.ts          # Embedding backfill script (bun run backfill)
src/
  middleware/
    request-logger.ts  # Express middleware for structured request/response logging
  logger.ts            # Existing -- extend with child logger or keep as-is
.github/
  workflows/
    ci.yml             # GitHub Actions CI pipeline
.env.example           # Documentation of all required env vars
```

### Pattern 1: Backfill Script -- Table-Iterating Retry Loop

**What:** A standalone script that queries each of the 5 tables for `WHERE embedding IS NULL`, generates embeddings using the existing `generateEmbedding` function, and updates rows one-by-one with rate limiting.
**When to use:** Manual invocation via `bun run backfill` or triggered by n8n workflow.
**Key design decisions:**
- Process one row at a time with a small delay (100-200ms) to avoid hammering LiteLLM
- Use the existing `generateEmbedding` function -- don't duplicate logic
- Log progress per-table (found N, processed M, failed K)
- Exit code 0 on success (even if some rows still NULL from persistent failures), exit code 1 on fatal errors (pool failure, etc.)
- Each table has different "embeddable content" -- thoughts use `content`, decisions use `title\nrationale`, relationships use `person_name\ncontext\nnotes`, etc.

**Example:**
```typescript
// Source: project schema analysis
const TABLES = [
  { name: "thoughts", textCol: "content", textFn: (r: any) => r.content },
  { name: "decisions", textCol: "title", textFn: (r: any) => `${r.title}\n${r.rationale}` },
  { name: "relationships", textCol: "person_name", textFn: (r: any) => `${r.person_name}\n${r.context ?? ""}\n${r.notes ?? ""}` },
  { name: "projects", textCol: "name", textFn: (r: any) => `${r.name}\n${r.description ?? ""}` },
  { name: "sessions", textCol: "summary", textFn: (r: any) => r.summary },
] as const;

for (const table of TABLES) {
  const { rows } = await pool.query(
    `SELECT id, ${relevantColumns} FROM ${table.name} WHERE embedding IS NULL`
  );
  // process each row...
}
```

### Pattern 2: Express Request Logger Middleware

**What:** An Express middleware that captures method, path, consumer ID (from auth), response status, and latency for every request -- outputting structured JSON via the existing `logger.info()`.
**When to use:** Applied globally to the Express app, but designed to be useful primarily for `/mcp` routes.
**Key design decisions:**
- Measure latency using `process.hrtime.bigint()` at request start, compute on `res.on('finish')`
- Extract consumer ID from `(req as any).auth?.clientId` -- will be `undefined` for `/health`
- NEVER log request bodies (contains user data) or tokens (security)
- Log embedding success/failure at the tool handler level, not the middleware level (the middleware doesn't know tool-level outcomes)

**Example:**
```typescript
// Source: Express middleware pattern
function requestLogger(req: Request, res: Response, next: NextFunction): void {
  const start = process.hrtime.bigint();

  res.on("finish", () => {
    const durationMs = Number(process.hrtime.bigint() - start) / 1_000_000;
    logger.info("request", {
      method: req.method,
      path: req.path,
      status: res.statusCode,
      durationMs: Math.round(durationMs),
      consumerId: (req as any).auth?.clientId ?? "anonymous",
    });
  });

  next();
}
```

### Pattern 3: Tool-Level Embedding Logging

**What:** Each tool handler already logs via `logger.warn` on embedding failure. The success path needs a `logger.info` call with `{ tool, embedded: true/false }` to satisfy "embedding success/failure for every MCP tool call."
**When to use:** Add to each write tool after embedding attempt.
**Key insight:** The middleware handles request-level metrics. Tool-level metrics (embedding success/failure) must live in the tool handlers because the middleware has no visibility into MCP tool execution.

### Pattern 4: CI Pipeline -- Typecheck + Unit + Integration

**What:** GitHub Actions workflow with Bun setup + pgvector service container.
**When to use:** On every push to `wip/*`, `feat/*`, `fix/*` branches and PRs to `main`.
**Key design decisions:**
- Use `pgvector/pgvector:pg16` service container (matches production Postgres 16)
- Run `CREATE EXTENSION vector` + migrations before integration tests
- Typecheck step: `bunx tsc --noEmit`
- Unit tests: `bun test` (existing mocked tests)
- Integration tests: separate test files that connect to the CI Postgres service (optional -- only if time permits, since unit tests with mocks already cover tool logic)
- Bun version: pin to `1.3.9` to match local dev

**Example:**
```yaml
# Source: oven-sh/setup-bun + pgvector/setup-pgvector
name: CI
on:
  push:
    branches: ["wip/**", "feat/**", "fix/**"]
  pull_request:
    branches: [main]

jobs:
  check:
    runs-on: ubuntu-latest
    services:
      postgres:
        image: pgvector/pgvector:pg16
        env:
          POSTGRES_DB: open_brain_test
          POSTGRES_USER: test
          POSTGRES_PASSWORD: test
        options: >-
          --health-cmd pg_isready
          --health-interval 10s
          --health-timeout 5s
          --health-retries 5
        ports:
          - 5432:5432
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
        with:
          bun-version: "1.3.9"
      - run: bun install
      - run: bunx tsc --noEmit
      - run: bun test
```

### Pattern 5: Deployment -- systemd on LXC

**What:** Use the `/deploy-service` skill to create an LXC, then configure a systemd unit that runs `bun run src/index.ts`.
**When to use:** One-time deployment, documented for reproducibility.
**Key design decisions:**
- Use the existing `deploy-service` skill template (Caddy proxy, DNS, LXC creation)
- systemd unit uses `EnvironmentFile=/opt/open-brain/.env` to load secrets
- `Restart=on-failure` with `RestartSec=5`
- Working directory: `/opt/open-brain`
- ExecStart: `/usr/local/bin/bun run src/index.ts`
- `.env.example` documents ALL required variables (already partially covered by `.env.schema`)

### Anti-Patterns to Avoid

- **Don't add pino/winston/morgan:** The project has a 36-line custom logger that already does structured JSON. Adding a logging library for 4 extra fields (method, status, latency, consumerId) is over-engineering.
- **Don't batch embedding backfill:** LiteLLM's embedding endpoint handles one text at a time. Batching would require API changes. Process rows sequentially with a small delay.
- **Don't build Docker images for deployment:** The infrastructure uses LXC + systemd. Docker would be a second deployment paradigm to maintain.
- **Don't log request bodies:** The success criteria explicitly says "never logging request bodies or tokens." Even partial bodies could contain sensitive user thoughts/decisions.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| LXC provisioning | Manual LXC creation scripts | `/deploy-service` skill | Handles dual NIC, Caddy proxy, DNS, Ansible, systemd -- 8 steps automated |
| CI Postgres with vectors | Custom Dockerfile | `pgvector/pgvector:pg16` image | Official pre-built image, drop-in replacement for `postgres:16` |
| Secret management in CI | Hardcoded tokens in workflow | GitHub Secrets + env mapping | Standard GHA pattern, no secrets in code |
| Process management | Custom restart scripts | systemd `Restart=on-failure` | Battle-tested, handles crashes, boot, logging |

**Key insight:** This phase is operational plumbing. Every piece has an established, zero-dependency solution. The risk is adding complexity (new libraries, new paradigms) where simplicity suffices.

## Common Pitfalls

### Pitfall 1: Backfill Hammering LiteLLM

**What goes wrong:** Processing hundreds of NULL-embedding rows with no delay overwhelms the LiteLLM proxy, causing rate limiting or timeouts.
**Why it happens:** The backfill query returns all NULLs at once, and a tight loop fires requests faster than the embedding service can handle.
**How to avoid:** Add a 100-200ms delay between rows (`await new Promise(r => setTimeout(r, 150))`). Log progress every 10 rows. Cap batch size with a configurable `--limit N` flag.
**Warning signs:** LiteLLM returning 429s or timeouts in backfill logs.

### Pitfall 2: CI Service Container Not Ready

**What goes wrong:** Tests start before Postgres is fully ready despite health checks, causing connection refused errors.
**Why it happens:** `pg_isready` returns true before the database accepts SQL connections in some edge cases.
**How to avoid:** The health check options (`--health-interval 10s --health-retries 5`) give 50 seconds. Additionally, run `CREATE EXTENSION vector` as a setup step before tests -- if it succeeds, the DB is truly ready.
**Warning signs:** Intermittent CI failures with "connection refused" or "database does not exist" errors.

### Pitfall 3: Logging Request Bodies Accidentally

**What goes wrong:** A well-meaning debug log in the request logger middleware logs `req.body`, which contains user thoughts, decisions, and session summaries.
**Why it happens:** Common Express logging patterns include body logging by default.
**How to avoid:** The middleware must ONLY log: method, path, status, latency, consumerId. No `req.body`, no `req.headers.authorization`, no `res.body`. Code review should check for this.
**Warning signs:** Large log entries, PII in log aggregators.

### Pitfall 4: Backfill Text Construction Diverges from Tool Logic

**What goes wrong:** The backfill script constructs embedding text differently from the tool handlers (e.g., decisions embed `title\nrationale` in the tool but backfill only embeds `title`), causing semantic search inconsistency.
**Why it happens:** Text construction logic is duplicated between tool handlers and the backfill script.
**How to avoid:** Extract `buildEmbeddingText(table, row)` as a shared helper used by both tool handlers and the backfill script. Or, since tool handlers already embed inline, just ensure the backfill uses the exact same concatenation pattern documented in each tool's INSERT.
**Warning signs:** Search results from backfilled rows have different quality/relevance than live-embedded rows.

### Pitfall 5: .env.example Contains Real Values

**What goes wrong:** `.env.example` is committed with actual IP addresses, ports, or placeholder tokens that look real.
**Why it happens:** Copy-paste from `.env` without sanitizing.
**How to avoid:** Use clearly fake values: `DB_HOST=your-postgres-host`, `AUTH_TOKEN_ADMIN=generate-a-secure-token`. The `.env.schema` already exists and has the right structure -- `.env.example` should mirror it with placeholder values.
**Warning signs:** ggshield flags on commit.

### Pitfall 6: systemd Unit Missing EnvironmentFile

**What goes wrong:** Server starts but can't connect to DB or authenticate because environment variables aren't loaded.
**Why it happens:** systemd doesn't source `.bashrc` or `.profile`. Environment must come from `EnvironmentFile=` or `Environment=` directives.
**How to avoid:** Use `EnvironmentFile=/opt/open-brain/.env` in the unit file. Verify with `systemctl show open-brain --property=Environment`.
**Warning signs:** Server crashes immediately with "DB_HOST environment variable is required" in journal.

## Code Examples

### Backfill Script Entry Point

```typescript
// scripts/backfill.ts
// Source: project codebase analysis
import { createPool } from "../src/db/pool.ts";
import { generateEmbedding, contentHash } from "../src/embedding.ts";
import { toSql } from "pgvector/pg";
import { logger } from "../src/logger.ts";

const TABLES = [
  { name: "thoughts", textFn: (r: any) => r.content },
  { name: "decisions", textFn: (r: any) => `${r.title}\n${r.rationale}` },
  { name: "relationships", textFn: (r: any) => [r.person_name, r.context, r.notes].filter(Boolean).join("\n") },
  { name: "projects", textFn: (r: any) => [r.name, r.description].filter(Boolean).join("\n") },
  { name: "sessions", textFn: (r: any) => r.summary },
] as const;

const DELAY_MS = 150;

async function backfill(): Promise<void> {
  const pool = createPool();
  let totalProcessed = 0;
  let totalFailed = 0;

  for (const table of TABLES) {
    const { rows } = await pool.query(`SELECT * FROM ${table.name} WHERE embedding IS NULL`);
    logger.info(`Backfill: ${table.name}`, { nullCount: rows.length });

    for (const row of rows) {
      const text = table.textFn(row);
      const embedding = await generateEmbedding(text);

      if (embedding) {
        await pool.query(
          `UPDATE ${table.name} SET embedding = $1, content_hash = $2, embedded_at = NOW(), embedding_model = 'gemini-embedding-001' WHERE id = $3`,
          [toSql(embedding), contentHash(text), row.id],
        );
        totalProcessed++;
      } else {
        totalFailed++;
      }

      await new Promise((r) => setTimeout(r, DELAY_MS));
    }
  }

  logger.info("Backfill complete", { totalProcessed, totalFailed });
  await pool.end();
}

backfill();
```

### Request Logger Middleware

```typescript
// src/middleware/request-logger.ts
// Source: Express middleware pattern + project logger
import type { Request, Response, NextFunction } from "express";
import { logger } from "../logger.ts";

export function requestLogger(req: Request, res: Response, next: NextFunction): void {
  const start = process.hrtime.bigint();

  res.on("finish", () => {
    const durationMs = Number(process.hrtime.bigint() - start) / 1_000_000;
    logger.info("request", {
      method: req.method,
      path: req.path,
      status: res.statusCode,
      durationMs: Math.round(durationMs),
      consumerId: (req as any).auth?.clientId ?? "anonymous",
    });
  });

  next();
}
```

### systemd Unit File

```ini
# /etc/systemd/system/open-brain.service
# Source: deploy-service skill template
[Unit]
Description=Open Brain MCP Server
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=/opt/open-brain
EnvironmentFile=/opt/open-brain/.env
ExecStart=/usr/local/bin/bun run src/index.ts
Restart=on-failure
RestartSec=5
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
```

### .env.example

```bash
# Database
DB_HOST=your-postgres-host
DB_PORT=5432
DB_NAME=open_brain
DB_USER=open_brain
DB_PASSWORD=your-db-password

# LiteLLM Proxy
LITELLM_URL=http://your-litellm-host:4000

# Server
PORT=3100

# CORS (comma-separated origins, or empty for none)
ALLOWED_ORIGINS=

# Auth tokens (one per consumer role -- generate with: openssl rand -hex 32)
AUTH_TOKEN_ADMIN=generate-a-secure-token
AUTH_TOKEN_AGENT=generate-a-secure-token
AUTH_TOKEN_DISCORD=generate-a-secure-token
AUTH_TOKEN_N8N=generate-a-secure-token
AUTH_TOKEN_READONLY=generate-a-secure-token
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| `oven-sh/setup-bun@v1` | `oven-sh/setup-bun@v2` | 2024 | v2 supports Bun 1.x caching, version pinning |
| `postgres:16` image | `pgvector/pgvector:pg16` | 2024 | Drop-in replacement with vector extension pre-installed |
| Manual Bun install in CI | `oven-sh/setup-bun@v2` | 2024 | Handles PATH, caching, version management |
| `server.tool()` | `server.registerTool()` | MCP SDK 1.27+ | Already migrated in this project |

**Deprecated/outdated:**
- `oven-sh/setup-bun@v1`: Use v2 for better caching and version support
- `pgvector/pgvector:pg17`: pg16 matches the production Postgres version on 10.71.20.49

## Open Questions

1. **Integration tests scope**
   - What we know: Unit tests with mocked pool/embedFn cover all tool logic. The CI pipeline has a real pgvector Postgres available.
   - What's unclear: Whether to write integration tests that actually hit the CI Postgres. The mocked tests are thorough (12 test files, covering happy path, errors, permissions).
   - Recommendation: Keep integration tests as a stretch goal. The unit tests + typecheck provide high confidence. If time permits, add one smoke test that starts the server against CI Postgres and hits `/health`.

2. **Backfill trigger from n8n**
   - What we know: Success criteria says "triggered by n8n workflow." The script will be runnable via `bun run backfill`.
   - What's unclear: How n8n triggers it -- SSH exec? HTTP webhook endpoint?
   - Recommendation: Build the script as CLI-runnable (`bun run backfill`). n8n integration is Phase 5 territory (consumer integration). For now, document that n8n can trigger via SSH exec or a future webhook.

3. **Deployment service name and port**
   - What we know: Server runs on port 3100. The deploy-service skill needs a service name and port.
   - What's unclear: Whether the user wants `open-brain` or a different subdomain.
   - Recommendation: Default to `open-brain` (open-brain.rodaddy.live). Let the planner note this as a user decision point.

## Validation Architecture

### Test Framework

| Property | Value |
|----------|-------|
| Framework | bun:test (built into Bun 1.3.9) |
| Config file | None (Bun discovers `*.test.ts` automatically) |
| Quick run command | `bun test` |
| Full suite command | `bun test` |

### Phase Requirements -> Test Map

Phase 4 has no direct v1 requirement IDs. Tests are mapped to success criteria instead.

| SC | Behavior | Test Type | Automated Command | File Exists? |
|----|----------|-----------|-------------------|-------------|
| SC-1 | Backfill finds NULL embeddings across all tables and retries | unit | `bun test scripts/backfill.test.ts` | No -- Wave 0 |
| SC-2 | CI pipeline runs typecheck + tests | CI workflow | Push to branch, observe GHA | No -- Wave 0 |
| SC-3 | Request logger captures method, consumerId, status, latency | unit | `bun test src/middleware/request-logger.test.ts` | No -- Wave 0 |
| SC-3 | Request logger never logs request bodies or tokens | unit | `bun test src/middleware/request-logger.test.ts` | No -- Wave 0 |
| SC-4 | Server runs as systemd service with auto-restart | manual | `systemctl status open-brain` | N/A -- manual |

### Sampling Rate

- **Per task commit:** `bun test`
- **Per wave merge:** `bun test && bunx tsc --noEmit`
- **Phase gate:** Full suite green + CI pipeline passes on a test push

### Wave 0 Gaps

- [ ] `scripts/backfill.test.ts` -- covers SC-1 (backfill logic with mocked pool/embed)
- [ ] `src/middleware/request-logger.test.ts` -- covers SC-3 (middleware captures fields, omits bodies)
- [ ] `.github/workflows/ci.yml` -- covers SC-2 (the CI config IS the deliverable)
- [ ] `.env.example` -- covers SC-4 (documents all required vars)

## Sources

### Primary (HIGH confidence)

- [oven-sh/setup-bun](https://github.com/oven-sh/setup-bun) -- Official Bun GitHub Actions setup, v2
- [pgvector/setup-pgvector](https://github.com/pgvector/setup-pgvector) -- Official pgvector CI instructions with service container example
- [pgvector/pgvector Docker Hub](https://hub.docker.com/r/pgvector/pgvector) -- Official Docker images, pg16 tag confirmed
- [Bun CI/CD docs](https://bun.com/docs/guides/runtime/cicd) -- Official Bun CI guide
- Project codebase -- logger.ts, embedding.ts, pool.ts, all tool handlers, test patterns (direct code analysis)

### Secondary (MEDIUM confidence)

- [deploy-service skill](~/.config/pai/Skills/deploy-service/SKILL.md) -- LXC + Caddy + systemd deployment automation
- [OneUptime: Service Containers in GitHub Actions](https://oneuptime.com/blog/post/2025-12-20-service-containers-github-actions/view) -- Service container patterns

### Tertiary (LOW confidence)

- None -- all findings verified against primary sources or project code

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH -- no new dependencies, everything already in project
- Architecture: HIGH -- patterns derived from existing codebase analysis
- Pitfalls: HIGH -- derived from production experience with each component
- CI/CD: HIGH -- verified against official setup-bun and setup-pgvector repos

**Research date:** 2026-03-13
**Valid until:** 2026-04-13 (stable domain -- operational patterns don't change fast)
