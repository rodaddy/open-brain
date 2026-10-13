# Open Brain

Agent memory as an MCP server. Open Brain stores what AI agents learn
(thoughts, decisions, session events, repo facts, contacts) in PostgreSQL with
pgvector, and serves it back through versioned MCP tools with hybrid retrieval
(vector similarity plus full-text, fused with reciprocal rank fusion).

## Why it exists

Coding agents forget everything between sessions. Open Brain is the one place
several agents (Claude Code, Codex, chat bots) write to and read from, with
three properties a plain vector store does not give you:

- **Scope and identity.** Every caller has a bearer token mapped to a role
  (admin, agent, readonly, promoter, ...). Memory lives in namespaces, and a
  context pack only returns items whose agent, platform, channel and session
  scope match exactly.
- **A contract, not a tool list.** `get_contract` publishes the tool surface,
  input schemas and a schema hash. Clients negotiate against it instead of
  hard-coding tool names.
- **Nothing becomes durable on its own.** Captured conversation turns are
  distilled into *candidates*. A candidate becomes memory only after it is
  graded (by a human on the grading page, `docs/grading-page.md`, or by an
  explicit promotion rule).

## What is in this repo

| Path | What it is |
|---|---|
| `server/` | The MCP server (Node 24, TypeScript, Express, `pg`, pgvector). Streamable HTTP transport, optional NATS request/reply transport. |
| `server/db/migrations/` | The schema, as ordered SQL migrations. |
| `scripts/` | Migrations runner, backfill, curation, the DREAM distillation stages, backup and restore, the grading server. |
| `python/openbrain-memory` | Python client library and CLI (`openbrain-memory`). |
| `python/openbrain` | Session-capture hooks for Claude Code and Codex (`openbrain-capture-stop`, `openbrain-session-start`, and siblings). |
| `python/openbrain-provider` | Context-budget and policy gates used by those hooks. |
| `clients/ts` | TypeScript client. |
| `contracts/` | Recorded request/response fixtures that pin the public contract. |
| `eval/` | Retrieval and context-pack evaluations. |
| `skill/` | An agent skill that teaches a model how to use the tools. |
| `k8s/` | Example Kustomize manifests (registry and hostnames are placeholders). |
| `docs/` | Architecture, configuration reference, contracts, design notes, gotchas. |

## Running it

Requirements: Node.js 24, PostgreSQL 13+ with the `vector` extension, and an
OpenAI-compatible `/v1/embeddings` endpoint (768 dimensions by default).

```bash
npm ci
cp .env.example .env          # fill in DB_*, EMBEDDING_*, and AUTH_TOKEN_* values
psql -c 'CREATE EXTENSION IF NOT EXISTS vector;'   # once, against your database
npm run migrate
npm start                     # serves MCP on PORT (default 3100)
```

Generate each auth token with `openssl rand -hex 32`. Full setup, every
environment variable, and client configuration are in `docs/README.md` and
`docs/CONFIG_REFERENCE.md`.

## Tests

```bash
npm test                      # unit tests; database suites fail fast without one
npm run test:isolated         # whole suite against a fresh, throwaway database
cd python/openbrain-memory && uv run pytest
```

Suites named `*.pg.test.ts`, `*.live.test.ts` and a few script tests need a
real Postgres (`OPENBRAIN_TEST_DATABASE_URL`); `npm run test:isolated` creates
one, migrates it, runs everything, and drops it.

## What is production-proven and what is not

- **Used daily, by one operator.** The server, the Python client, and the
  Claude Code / Codex capture hooks run every day on a single operator's
  machines and home lab, for a handful of agents. That is the whole
  deployment history. It has not been run multi-tenant or at scale.
- **Built and tested, lightly used:** the NATS transport, the DREAM
  distillation stages (light, REM, deep), the grading page, backup and
  restore drills.
- **Design only:** several documents under `docs/` describe designs that are
  not built. Each says so in its status line.
- Paths such as `/srv/dev` and hostnames such as `*.example.internal` in docs
  and tests are placeholders for the original operator's layout.

## What it does not do

- It is not a hosted service and has no UI beyond the local grading page.
- It does not choose what is worth remembering for you: capture is broad,
  promotion to durable memory is deliberate.
- It does not ship an embedding model. Point it at any OpenAI-compatible
  embeddings endpoint.
- There is no CI configuration in this snapshot; the original ran on
  self-hosted runners that are not part of this repo.

## License

MIT. See `LICENSE`.
