# Contributing to Open Brain

Thanks for your interest in contributing. This document covers the development workflow, coding standards, and rules for keeping infrastructure details out of the codebase.

## Getting Started

```bash
git clone https://github.com/rodaddy/open-brain.git
cd open-brain
bun install
cp .env.example .env    # fill in your values
bun run migrate
bun run start
```

## Development Workflow

### Branching

All work happens on feature branches. Never commit directly to `main`.

```bash
git checkout -b feat/my-feature    # new feature
git checkout -b fix/bug-name       # bug fix
git checkout -b wip/experiment     # work in progress
```

### Testing

```bash
bun run test         # run test suite
bun run typecheck    # type-check without emit
```

Tests live alongside source files in `__tests__/` directories. Coverage threshold is 80% for lines, functions, and statements (configured in `bunfig.toml`).

### Pull Requests

PRs trigger two automated checks:

1. **CI** — typecheck + migrations + tests against a real PostgreSQL + pgvector instance
2. **Claude Code Review** — AI-powered review for bugs, security, and performance issues

## Coding Standards

### Language and Style

- **TypeScript** in strict mode. Explicit types, avoid `any`.
- **Functional patterns** over classes. Pure functions where possible.
- **`const` over `let`**. Never `var`.
- **No comments** unless the "why" is non-obvious. The code should explain the "what."
- **File size limit: 750 lines.** Split proactively at ~600 lines.

### Dependencies

- **Runtime:** [Bun](https://bun.sh/) — not Node.js
- **Package manager:** `bun` — not npm or yarn
- **Validation:** [Zod](https://zod.dev/) for all external input

### No Hardcoded Infrastructure

Never commit real IP addresses, hostnames, credentials, or internal URLs.

```typescript
// WRONG — exposes network topology
const LITELLM_URL = process.env.LITELLM_URL ?? "http://10.71.20.53:4000";

// RIGHT — safe default, real value comes from env
const LITELLM_URL = process.env.LITELLM_URL ?? "http://localhost:4000";
```

**What counts as infrastructure detail:**

- Private/internal IP addresses (`10.x.x.x`, `192.168.x.x`, `172.16-31.x.x`)
- Internal hostnames or domain names
- Container IDs, LXC numbers, VM names tied to a specific deployment
- Usernames, API keys, tokens, passwords (even in comments)

**Where to put real values:**

- `.env` — gitignored, never committed
- `.env.schema` — varlock schema with fake but realistic placeholder IPs
- `.env.example` — descriptive placeholders like `your-postgres-host`

**If you need a fallback in code**, default to `localhost`:

```typescript
const DB_HOST = process.env.DB_HOST ?? "localhost";
```

### Pre-Commit Check

Before committing, verify no infrastructure details leaked:

```bash
git diff --cached | grep -E '10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+'
# Should return nothing
```

### Gitignored Directories

These directories are gitignored and must stay that way:

| Directory | Contents |
|-----------|----------|
| `.planning/` | Internal project plans and research |
| `.reports/` | Session logs and briefings |
| `.claude/` | AI assistant state |
| `node_modules/` | Dependencies |

## Adding a New MCP Tool

1. Create `src/tools/your-tool.ts` following the existing pattern
2. Accept `ToolDeps` (`pool` + `embedFn`) as the dependency argument
3. Define input schema with Zod
4. Add tool annotations (`readOnlyHint`, `destructiveHint`, `idempotentHint`)
5. Register in `src/tools/index.ts` via `registerAllTools()`
6. Add tests in `src/tools/__tests__/your-tool.test.ts`
7. Update the tool table in `README.md`

## Adding a Migration

1. Create `src/db/migrations/NNN_description.sql` (next sequential number)
2. Migrations run automatically on server start
3. Test against a clean database: `bun run migrate` on a fresh `open_brain_test` DB
4. CI validates migrations against `pgvector/pgvector:pg17`

## Security

- Auth tokens use constant-time comparison (no early-exit)
- Table names are Zod-enum validated before SQL interpolation
- `update_entry` uses `SELECT ... FOR UPDATE` to prevent TOCTOU races
- Content hashing uses SHA-256 for deduplication
- Never log tokens, passwords, or embedding content at info level

## Questions?

Open an issue on GitHub or check the [README](README.md) for architecture details.
