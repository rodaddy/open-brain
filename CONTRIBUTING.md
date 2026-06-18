# Contributing to Open Brain

## Coding Standards

### No Hardcoded Infrastructure

Never commit real IP addresses, hostnames, credentials, or internal URLs.

```typescript
// WRONG — exposes your network topology
const EMBEDDING_BASE_URL =
  process.env.EMBEDDING_BASE_URL ?? "http://10.71.20.53:8791/v1";

// RIGHT — safe default, real value comes from env
const EMBEDDING_BASE_URL =
  process.env.EMBEDDING_BASE_URL ?? "http://localhost:8791/v1";
```

**What counts as infrastructure detail:**
- Private/internal IP addresses (`10.x.x.x`, `192.168.x.x`, `172.16-31.x.x`)
- Internal hostnames or domain names (e.g., `db.internal.mycompany.com`)
- Container IDs, LXC numbers, VM names tied to a specific deployment
- Port numbers that reveal service topology (standard ports like 5432 are fine)
- Usernames, API keys, tokens, passwords (even in comments)

**Where to put real values:**
- `.env` (gitignored, never committed)
- `.env.schema` — use fake but realistic placeholder IPs (e.g., `192.168.1.50`) with a comment explaining what goes there
- `.env.example` — use descriptive placeholders like `your-postgres-host`

**If you need a fallback in code**, default to `localhost`:
```typescript
// Fallback to local instance — override via DB_HOST env var
const DB_HOST = process.env.DB_HOST ?? "localhost";
```

### Schema and Example Files

`.env.example` uses descriptive placeholders to show what's needed:
```env
DB_HOST=your-postgres-host
EMBEDDING_API_KEY=your-embedding-api-key
```

`.env.schema` (for varlock) uses fake but realistic values with comments:
```env
# Replace with your PostgreSQL host — e.g., localhost, db.example.com, or a LAN IP
DB_HOST=192.168.1.50
```

### Private Development Artifacts

These directories are gitignored and must stay that way:
- `.planning/` — internal project plans, research, roadmaps (often reference specific infrastructure)
- `.reports/` — session logs, briefings, checkpoints
- `.claude/` — AI assistant state

If you need to document architecture for contributors, put it in this file or the README — not in tracked planning docs that tend to accumulate real deployment details.

### Pre-Commit Check

Before committing, grep for leaked infrastructure:

```bash
# Should return nothing
git diff --cached | grep -E '10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+'
```

If you find a match, replace it with `localhost` or a descriptive placeholder before pushing.

## Critical Self-Review Before PR

Before opening or marking a non-trivial PR ready, write a concise critical
self-review in the PR body or a PR comment. This is author-owned process; it
does not replace CI, reviewer sign-off, or review swarms.

Use this format:

```text
Critical self-review:
- Highest-risk behavior:
- Assumptions that could be wrong:
- Missing/weak tests:
- Security/permission risk:
- Migration/deploy risk:
- Downstream client/runtime risk:
- Rollback/cleanup concern:
- Fixes made before PR:
- Known residual risk:
```

If the self-review exposes a real issue, fix it before asking for review or
mark it deferred only with explicit Rico approval. Avoid "all good" receipts;
name the risks you checked.

## Stack

- **Runtime:** [Bun](https://bun.sh/)
- **Language:** TypeScript (strict mode)
- **Database:** PostgreSQL + pgvector
- **Package manager:** `bun` (not npm/yarn)

## Development

```bash
bun install
cp .env.example .env       # fill in your values
bun run migrate
bun run start
```

## Testing

```bash
bun run test
bun run typecheck
```

## Code Style

- Functional patterns over classes
- Explicit types, avoid `any`
- `const` over `let`
- No comments unless the "why" is non-obvious
- Keep files under 600 lines — split at that point, not after
