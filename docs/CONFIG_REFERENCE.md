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

### Server call tracing (#530) — TypeScript `server/`

Read by `server/observability/langfuse-tracing.ts` (`readMcpTracingConfig`),
installed in `server/main.ts` alongside the audit wrapper. Every MCP tool call
served by the rewrite entrypoint becomes one **content-ful** Langfuse trace:
tool name, caller identity, full arguments, full result (or error class and
message), duration, and session grouping.

**CONTENT-FUL is the point, and it is deliberate.** #530 explicitly supersedes
#372's content-free spec for the local dogfood deployment. Payloads are sent
verbatim: no redaction, no summarisation, no size bucketing. `OPENBRAIN_MCP_AUDIT_*`
(above) remains the separate content-FREE durable Postgres record and is
unchanged — the two lanes coexist and neither replaces the other.

| variable | default | notes |
|---|---|---|
| `OPENBRAIN_TRACING_ENABLED` | unset (off) | tracing runs only when this is exactly `"1"` |
| `OPENBRAIN_TRACING_ENDPOINT` | — | Langfuse base URL (the SDK appends its own paths) |
| `OPENBRAIN_TRACING_PUBLIC_KEY` | — | Langfuse `pk-lf-...` |
| `OPENBRAIN_TRACING_SECRET_KEY` | — | Langfuse `sk-lf-...` |

**Off unless all four are set.** The flag alone is not enough: `enabled` is
`true` only when the flag is `"1"` AND all three coordinates are non-empty. A
flag set with an incomplete triple logs one content-free
`mcp_tool_tracing_config_incomplete` warn naming which coordinate is missing
(booleans only — no key value is ever logged or persisted) and then stays off,
so a typo cannot silently produce a zero-trace deployment.

**Deploy coupling:** the keys live in the operator environment, sourced from the
Vaultwarden item `Langfuse - Open Brain Local Dogfood`; they are never committed
and never given values in `.env.example`. The variables are read ONCE at process
start — `startServer` builds a single shared client before any session can
exist — so **turning tracing on or off requires a service restart**. Editing the
environment under a running process changes nothing. A `mcp_tracing_configured`
info line at startup reports whether the lane came up.

**Payload volume is the operating cost to watch.** Every tool call ships its
full arguments and full result. Large `search_brain` result sets and
`agent_context_pack` payloads are the heaviest; size the Langfuse server's
storage against real traffic before enabling this anywhere it matters, and treat
that Langfuse instance as holding the same content sensitivity as the brain
itself.

**SDK: Langfuse JS v4 (`@langfuse/tracing` + `@langfuse/otel`), OTel-based.**
This matches the Python capture sink, which already runs on Python SDK v4, so
both lanes speak one API family. The processor posts OTLP-HTTP to
`${OPENBRAIN_TRACING_ENDPOINT}/api/public/otel/v1/traces`; give the bare server
root, not the `/api/public/ingestion` path the #372 lane uses. Verified against
the self-hosted server reporting `version 3.173.0`: server v3 and JS SDK v4 are
separate version lines, and the server has carried the OTel ingestion route
since v3.

**Outage behaviour: the brain never waits, and the window is lost on purpose.**
Langfuse being down must not stop or slow anything, so there is no disk spool
and no replay — the Postgres audit log and the capture lane remain the system of
record. Traces buffered when the endpoint is unreachable are dropped. The outage
is still visible, but on STATE CHANGE only:

| line | level | when | payload |
|---|---|---|---|
| `mcp_tool_tracing_suspended` | warn | first failed background export after healthy | error label only |
| `mcp_tool_tracing_resumed` | info | first export that reaches the endpoint again | `droppedTraces` for that window |

Never one line per failed call. Both edges are detected on the EXPORT, not on
the tool call: handing a span to the batch queue succeeds whether or not
anything is listening, so an outage is only knowable once the background export
runs. The down edge comes from OTel's global error handler; the up edge from a
health probe that runs only while the sink is already known-unhealthy and sends
its own span, so a flush that merely found an empty queue cannot be mistaken for
the endpoint coming back.

Observed against a blackholed endpoint (500 traced calls, 2026-08-04):
`mcp_tool_tracing_suspended` while the process was still running, then
`mcp_tool_tracing_resumed` with `droppedTraces: 500` once a reachable endpoint
answered — and no `resumed` line at all while the endpoint stayed unreachable.

A flapping sink is bounded rather than chatty: after a reported recovery,
another suspend/resume pair is withheld for 30 seconds, so a sink alternating
fail/success reports one pair instead of one per flap (measured 10 pairs across
20 alternating calls before this bound). A genuine outage arriving after a quiet
period is never delayed.

Measured under a blackholed endpoint: heap plateaus at 34-45 MB across 30,000
traced calls with no upward trend, and the enqueue stays off the request path
(~7 µs per call).

The SDK's own logger is silenced when the sink is built. Left at its default it
writes export failures to `console.error` with the raw error attached, which
would route a transport message — potentially carrying the endpoint or an auth
header — around both this module's content-free discipline and the shared
logger's redaction (measured: the injected key-shaped string appeared in the
output). The two lines above are how this lane reports its health instead.

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

### Observation sink (#523) — Python `openbrain` hooks

Read by `python/openbrain/src/openbrain/config.py` (`ObservationSettings`,
`load_observation_settings`). The capture hooks ship the same turns they
deliver to the raw lane to the fleet Langfuse server as content-ful session
traces — secret-shaped values masked client-side
(`apps/capture/redaction.py`), because Langfuse redacts nothing server-side.

| variable | default | notes |
|---|---|---|
| `OPENBRAIN_OBSERVATION_ENABLED` | `false` | opt-in per host; off means the sink declines silently |
| `OPENBRAIN_OBSERVATION_ENDPOINT` | — | Langfuse host; the `/api/public/ingestion` suffix the #372 lane uses is accepted and stripped |
| `OPENBRAIN_OBSERVATION_PUBLIC_KEY` | — | Langfuse `pk-lf-...` |
| `OPENBRAIN_OBSERVATION_SECRET_KEY` | — | Langfuse `sk-lf-...`, held as a `SecretStr` |
| `OPENBRAIN_OBSERVATION_HMAC_SECRET` | — | reserved for the #372 content-free lane; declared so the provisioned variable is not rejected as a typo, read by nothing yet |

**Deploy coupling:** the deployed `openbrain-hook-env` wrapper (see
`docs/420-cutover-rollback.md`) passes hooks ONLY the variables the installed
package declares. The wrapper may add the `OPENBRAIN_OBSERVATION_*`
pass-throughs only at or after the moment the installed package includes
`ObservationSettings` — passing them to an older install makes
`unknown_prefixed_variables` reject the whole environment, which the hooks
swallow into a silent zero capture.

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
