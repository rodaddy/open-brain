# Open Brain — Configuration Reference

Every setting Open Brain reads, where it is read, and what happens when it is
absent. Measured against `src/` and `python/openbrain-memory/src/` on
2026-07-30.

**61 distinct environment variables** are read across the two languages: 52 in
TypeScript (`src/`, tests included), 9 in Python
(`python/openbrain-memory/src/`). `.env.example` documents roughly half of them.

---

## The rule this file exists to enforce

> **A setting is defined in exactly one place.** Everything else imports it.

Today it is not. `process.env.X ?? default` appears inline at the point of use,
scattered across `src/`, with the default written as a literal beside it. The
same variable read in two files can carry two different defaults and nothing
detects the divergence.

This is the configuration form of the defect that produced four copies of the
64 KB admission rule: no single owner, so a fix reaches one reader and not the
others.

**Target state:** a Pydantic `BaseSettings` class in `config/` for Python, a Zod
schema in `config/` for TypeScript. `process.env` / `os.environ` is read in
**one module per language**, at startup, and validated. Every other module
receives a typed settings object. An unknown or malformed value fails at boot
with a named error, not at 3am on the first request that happens to reach that
line.

---

## Where configuration comes from

| source | scope | contains |
|---|---|---|
| `.env` (from `.env.example`) | server process | database, embedding, auth tokens, port |
| `~/.local/share/openbrain-memory/env/claudex-observation.env` | Claude runtime | `OPENBRAIN_BASE_URL`, `OPENBRAIN_TOKEN` |
| CI job `env:` blocks | `.github/workflows/ci.yml` | throwaway per-run database coordinates |
| runtime `config` mapping | Python CLI JSON envelope | per-call override of base_url / namespace / role / timeout |

**Never hardcode a host.** Not `10.71.1.21`, not `127.0.0.1`. The endpoint comes
from the environment. This is a repo-local hook-enforced rule.

---

## Database

| variable | default | read at | notes |
|---|---|---|---|
| `DB_HOST` | **required** | `src/db/pool.ts:14` | no default; absent means failure |
| `DB_PORT` | `5432` | `src/db/pool.ts:21` | |
| `DB_NAME` | `open_brain` | `src/db/pool.ts:22` | |
| `DB_USER` | **required** | `src/db/pool.ts:16` | |
| `DB_PASSWORD` | — | `src/db/pool.ts:24` | |
| `DB_POOL_MAX` | `10` | `src/db/pool.ts:25` | pool connections |
| `DB_NAME_TEST` | — | CI only | destructive `001_init` migration test; **must differ from `DB_NAME`** |

### The libpq duplication is deliberate

`.env.example` also sets `PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER`. The
application reads `DB_*`; `psql` and other Postgres clients read `PG*`. Bare
`psql` with no arguments otherwise connects to a database named after your unix
user. Two consumers, two spellings — **keep them in sync**.

This is a documented exception to the one-definition rule, not a licence for
others.

### Test database

| variable | effect when unset |
|---|---|
| `OPENBRAIN_TEST_DATABASE_URL` | every `dbDescribe` suite **skips silently** |
| `OPENBRAIN_LOCAL_CLONE_TEST_DATABASE_URL` | local-clone boundary suites skip |
| `OPENBRAIN_BACKUP_DRILL` | `=1` makes the #298 restore drill mandatory; unset lets it skip |

**A green test run with these unset proves nothing.** Set them whenever a result
is being used as evidence. CI enforces this with
`scripts/assert-db-tests-ran.ts`; locally nothing does.

The dogfood clone (`open_brain_local_20260724`) is authoritative for this
machine.

---

## Embedding

| variable | default | read at |
|---|---|---|
| `EMBEDDING_BASE_URL` | — | `src/embedding.ts:257`, `src/index.ts:41` |
| `EMBEDDING_API_KEY` | — | `src/embedding.ts:262` |
| `EMBEDDING_MODEL` | `gemini-embedding-001` | `src/embedding.ts:36` |
| `EMBEDDING_DIMENSIONS` | `768` | `src/embedding.ts:8` |
| `EMBEDDING_TIMEOUT_MS` | `8000` | `src/embedding.ts:6` |
| `EMBEDDING_WATCHDOG_FAILURE_THRESHOLD` | `2` | `src/embedding.ts:99` |
| `EMBEDDING_WATCHDOG_COOLDOWN_MS` | `300000` | `src/embedding.ts:107` |
| `EMBEDDING_WATCHDOG_RESTART_SCRIPT` | unset | `src/embedding.ts:139` |
| `OPENBRAIN_SEARCH_EMBEDDING_TIMEOUT_MS` | — | `src/tools/search-brain.ts:165` |
| `SEARCH_EMBEDDING_TIMEOUT_MS` | — | legacy spelling, still read |

### `EMBEDDING_MODEL`'s code default is wrong for this deployment

The source default is `gemini-embedding-001`. The model actually running is
**`embeddinggemma-300m-8bit`** (`.env.example:20`), served at
`EMBEDDING_BASE_URL`. The code default is a leftover; `.env` corrects it. Do not
reason about embedding behaviour from the code default.

### `EMBEDDING_DIMENSIONS` is schema-coupled

`768` matches the `halfvec(768)` columns. **Changing it requires a column
migration and a full re-embed.** It is not a tuning knob.

### Measured behaviour of the live embedder — 2026-07-30

Measured directly against the running service, not inferred:

- Accepts 64,000 characters, HTTP 200.
- Cosine similarity between texts with distinct tails: 0.79 at 8k, 0.995 at 30k,
  exactly 1.000000000 at 60k — the tail stops affecting the vector.

Long text is therefore **segmented and combined**, not refused:
`generateEmbeddingWithMetadata` splits at `EMBEDDING_SEGMENT_CHARS` (6000) with
`EMBEDDING_SEGMENT_OVERLAP` (1200), embeds each segment, and combines the
vectors length-weighted then L2-normalised. These two are source constants, not
environment variables.

**A failed segment fails the whole embedding.** A partial vector is a wrong
answer wearing the shape of a right one.

### MLX watchdog script variables

Consumed by `scripts/restart-mlx-embedding-server.sh` when it is used as the
watchdog restart script, not by the server itself: `MLX_EMBED_DAEMON`,
`MLX_EMBED_RUNTIME_DIR`, `MLX_EMBED_PORT` (`8791`), `MLX_EMBED_HEALTH_URL`,
`MLX_EMBED_CURL`, `MLX_EMBED_HEALTH_RETRIES` (`20`),
`MLX_EMBED_HEALTH_SLEEP_SECONDS` (`1`), `MLX_EMBED_RESTART_SETTLE_SECONDS` (`2`),
`MLX_EMBED_RESTART_LOCK_STALE_AFTER_SECONDS` (`300`).

---

## Server

| variable | default | read at |
|---|---|---|
| `PORT` | `3100` | `src/index.ts:349` |
| `OPEN_BRAIN_BIND_HOST` | unset | `src/index.ts:353` |
| `OPEN_BRAIN_SERVER_IP` | unset | `src/index.ts:44` |
| `ALLOWED_ORIGINS` | `[]` (none) | `src/index.ts:78`, comma-separated |
| `OPEN_BRAIN_RUN_MIGRATIONS` | `1` | `src/index.ts:272`; `"0"` disables |
| `OPEN_BRAIN_MAINTENANCE_ENABLED` | unset | `src/index.ts:383` |
| `NODE_ENV` | unset | `src/operator-doctor.ts:375`; `production` / `development` / `test` |
| `SERVICE_NAME` | `open-brain` | `src/logger.ts:202` |
| `OPEN_BRAIN_WORKER_NAME` | unset | `src/logger.ts:180`; suffixes the service name |

### Session / transport

| variable | default | read at |
|---|---|---|
| `OPEN_BRAIN_SESSION_TTL_SECONDS` | `30` | `src/transport.ts:31` (ms internally) |
| `OPEN_BRAIN_MAX_SESSIONS` | — | `src/transport.ts:59` |
| `OPEN_BRAIN_SESSION_RETRY_AFTER_SECONDS` | — | `src/transport.ts:66` |

---

## Authentication

One token per consumer role, generated with `openssl rand -hex 32`:

`AUTH_TOKEN_ADMIN`, `AUTH_TOKEN_AGENT`, `AUTH_TOKEN_DISCORD`,
`AUTH_TOKEN_READONLY`, `AUTH_TOKEN_OB_ADMIN`, `AUTH_TOKEN_PROMOTER`.

Roles grant different write permissions. **Never log a token, never commit one,
never put one in an issue, PR, report, or memory entry.**

These are LAN-local pre-production tokens. There is no rotation ceremony until
production — a standing operator decision, not an oversight.

---

## Logging

| variable | default | read at |
|---|---|---|
| `LOG_LEVEL` | `info` | `src/logger.ts:12` |
| `LOG_FILE` | unset (stdout only) | `src/logger.ts:176` |
| `LOG_MAX_BYTES` | `1_000_000` | `src/logger.ts:184` |
| `LOG_MAX_FILES` | `3` | `src/logger.ts:185` |
| `HOSTNAME` / `HOST` | unset | `src/logger.ts:116`, first non-empty wins |

`src/operator-doctor.ts:363,410` warns when `LOG_MAX_BYTES` or `LOG_MAX_FILES`
is set without `LOG_FILE` — rotation settings with nothing to rotate.

**None of these are in `.env.example`.** Add them.

---

## Namespaces

`src/shared-namespace.ts` reads each name from a primary spelling with a
fallback:

| variable | fallback spelling |
|---|---|
| `SHARED_NAMESPACE_CANONICAL` | `OPENBRAIN_SHARED_NAMESPACE` |
| `SHARED_NAMESPACE_PHYSICAL` | `OPENBRAIN_SHARED_NAMESPACE` |
| `SHARED_NAMESPACE_LEGACY` | `OPENBRAIN_LEGACY_SHARED_NAMESPACE` |

Two flags gate the legacy path, both off by default:

- `OPENBRAIN_LEGACY_SHARED_FALLBACK=1` — read from the legacy namespace
- `OPENBRAIN_ALLOW_LEGACY_SHARED_WRITES=1` — write to it

`src/shared-namespace.ts:6-7` calls these *"a transient escape hatch during a
migration."* Both should be unset in normal operation. If one is set, something
is mid-migration — find out what before changing anything.

---

## Full-text search

| variable | default | read at |
|---|---|---|
| `OPENBRAIN_FTS_CONFIG` | `english` | `src/tools/fts-config.ts:145` |
| `OPENBRAIN_FTS_STATEMENT_TIMEOUT_MS` | — | `src/tools/fts-config.ts:206`, positive integer |

`OPENBRAIN_FTS_CONFIG` accepts a Postgres regconfig name (`german`, `french`, …)
validated against an allowlist. **A non-English config is not index-backed** —
the stored `search_vector` is `GENERATED ALWAYS AS to_tsvector('english', …)`,
so any other config recomputes tsvectors per row at query time. That is why
`.env.example:48-50` marks it an explicit operator opt-in.

Related: the test database must be **UTF8**. Under `SQL_ASCII` the snowball
stemmers split multibyte accented characters and every non-English FTS assertion
(#341) silently fails while ASCII-only English passes. See
`docs/CI_CD_REQUIREMENTS.md`.

---

## Feature flags and paths

| variable | default | read at | effect |
|---|---|---|---|
| `OPENBRAIN_PROMOTION_KILL_SWITCH` | unset | `src/promotion-service.ts:235` | `"1"` halts promotion |
| `OPENBRAIN_MCP_AUDIT_ENABLED` | on | `src/audit-log.ts:138` | `"0"` disables MCP audit logging |
| `OPENBRAIN_RECOVERY_WAL_PATH` | `null` | `src/tools/index.ts:88` | recovery WAL location |
| `QMD_PATH` | `/opt/qmd/src/qmd.ts` | `src/qmd-path.ts:7` | must be set **empty** in local-clone mode |
| `OPENBRAIN_LOCAL_CLONE` | `0` | `.env.example:41` | |
| `OPENBRAIN_LOCAL_CLONE_ROOT` | unset | `.env.example:42` | |

### Drop-folder collector

`src/drop-folder-collector.ts` reads four scan bounds — `DROP_COLLECTOR_MAX_FILES`
(256), `DROP_COLLECTOR_MAX_FILE_BYTES` (1 MiB), `DROP_COLLECTOR_MAX_TOTAL_BYTES`
(16 MiB), `DROP_COLLECTOR_MAX_DEPTH` (8), plus `DROP_COLLECTOR_MAX_SCAN_ENTRIES`.

These bound a **filesystem scan of an operator-controlled drop folder** — how
much of a directory tree one pass walks. They are not admission rules about what
Open Brain may remember, and must never be reused as such. Content admission is
governed by §6 of `docs/CODING_STANDARDS.md`.

---

## Python — `openbrain-memory`

Read in `python/openbrain-memory/src/openbrain_memory/runtime.py:320-340`.
Every one accepts a **per-call override** from the `config` mapping in the JSON
envelope; the environment is the fallback.

| variable | config key | notes |
|---|---|---|
| `OPENBRAIN_BASE_URL` | `base_url` | required |
| `OPENBRAIN_TOKEN` | — | env only; also accepts legacy `OPEN_BRAIN_TOKEN` |
| `OPENBRAIN_NAMESPACE` | `namespace` | |
| `OPENBRAIN_ROLE` | `role` | optional |
| `OPENBRAIN_TIMEOUT` | `timeout` | |
| `OPENBRAIN_ALLOW_INSECURE_HTTP` | — | plain-HTTP opt-in for LAN endpoints |
| `OPENBRAIN_AGENT_ID` | — | identifies the writing agent |

`OPENBRAIN_TOKEN` accepting two spellings is a compatibility shim. New code
writes `OPENBRAIN_TOKEN`.

### Live canary flags

`OPENBRAIN_LIVE_CANARY`, `OPENBRAIN_LIVE_CANARY_WRITE`,
`OPENBRAIN_LIVE_CANARY_REPO_FACT_WRITE`,
`OPENBRAIN_LIVE_CANARY_REPO_FACT_COMMIT` — opt-in live-endpoint checks. Unset,
the canary suites skip. Same evidence trap as `OPENBRAIN_TEST_DATABASE_URL`: a
green run means nothing unless they were set.

`RUN_0_1_17_COMPAT_ENV` gates a version-compatibility suite.

---

## Adding a setting

1. **Check it does not already exist under another spelling.**
   `rg 'OPENBRAIN_' src/ python/` before naming anything.
2. **Define it once**, in `config/`, with its type and default in the schema —
   not as a literal at the point of use.
3. **Validate at startup.** Malformed values fail at boot with the variable
   named, never at first use.
4. **Document it here and in `.env.example`**, in the same commit.
5. **Never introduce a content bound.** Settings configure endpoints, timeouts,
   credentials, and feature flags. What Open Brain may remember is not
   configurable — see §6 of `docs/CODING_STANDARDS.md`.

---

## Known gaps — MEASURED 2026-07-30

| gap | detail |
|---|---|
| no central config module | `process.env` read inline across `src/`; defaults are literals at each site |
| `.env.example` incomplete | missing all logging, session/transport, namespace, FTS-timeout, and Python variables |
| `EMBEDDING_MODEL` code default is stale | `gemini-embedding-001` in source; `embeddinggemma-300m-8bit` in reality |
| two spellings for the same setting | `OPENBRAIN_SEARCH_EMBEDDING_TIMEOUT_MS` / `SEARCH_EMBEDDING_TIMEOUT_MS`; `OPENBRAIN_TOKEN` / `OPEN_BRAIN_TOKEN` |
| inconsistent prefixes | `OPEN_BRAIN_*` and `OPENBRAIN_*` both in active use |
| no validation at boot | a malformed integer becomes `NaN` and surfaces far from its cause |

---

**See Also:**
- `docs/CODING_STANDARDS.md` — §3 typing, §6 recall, §7 structure
- `docs/CI_CD_REQUIREMENTS.md` — the gates, and the CI database coordinates
- `.env.example` — the template; incomplete, see above
- `AGENTS.md` — stack, hosts, commands
