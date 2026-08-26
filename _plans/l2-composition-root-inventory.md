# L2 composition-root inventory

Status: WRITTEN 2026-08-26, measured by a read-only Codex lane against origin/main 96978a8 (`server/` identical on chore/oxlint-enforcement). Feeds `_plans/server-hardening-ladder.md` L2.

```text
RESULTS

A.
server/observability/langfuse-tracing.ts:599 OPENBRAIN_TRACING_ENDPOINT/PUBLIC_KEY/SECRET_KEY/ENABLED/MASKING_ENABLED -- whole-env default; trim, enabled only with flag `1` and all coordinates, masking defaults on -- NO -- `readMcpTracingConfig`
server/tools/shared-namespace.ts:37 SHARED_NAMESPACE_CANONICAL/OPENBRAIN_SHARED_NAMESPACE/SHARED_NAMESPACE_PHYSICAL/SHARED_NAMESPACE_LEGACY/OPENBRAIN_LEGACY_SHARED_NAMESPACE -- trim; first non-empty else caller default -- SHARED_NAMESPACE_CANONICAL; others NO -- `envString` via `sharedNamespaceConfig`
server/tools/shared-namespace.ts:45 OPENBRAIN_LEGACY_SHARED_FALLBACK -- trim; true for `1/true/yes/on`, default false -- NO -- `envBoolean` via `sharedNamespaceConfig`
server/tools/shared-namespace.ts:52 OPENBRAIN_SHARED_FALLBACK_MIN_RESULTS -- base-10 positive integer, fallback 5 -- NO -- `envPositiveInteger` via `sharedNamespaceConfig`
server/tools/realtime-stores.ts:46 OPENBRAIN_RECOVERY_WAL_PATH -- `?? null`, no trim/parse -- NO -- `recoveryWalStoreFor`
server/tools/search-all.ts:119 QMD_PATH -- whole-env default; trim blank to undefined -- NO -- `resolveQmdPath`, called by `registerSearchAllTool`
server/tools/search-engine.ts:148 OPENBRAIN_SEARCH_EMBEDDING_TIMEOUT_MS -- preferred value; base-10 integer >=1 else 3000 -- NO -- `searchEmbeddingTimeoutMs`
server/tools/search-engine.ts:149 SEARCH_EMBEDDING_TIMEOUT_MS -- legacy fallback; same parse/default -- NO -- `searchEmbeddingTimeoutMs`
server/tools/fts-config.ts:111 OPENBRAIN_FTS_CONFIG -- whole-env default; trim, allowlisted language, fallback english -- NO -- `corpusFtsConfig`
server/tools/fts-config.ts:128 OPENBRAIN_FTS_CONFIG -- whole-env default; request override else corpus default -- NO -- `requestFtsConfig`
server/tools/operator-doctor.ts:62 OPENBRAIN_TRANSPORT and OPENBRAIN_NATS_* -- whole-env default; trim/lowercase, HTTP/auth/fallback defaults and local-URL guard -- NO -- `readNatsRuntimeBoundary`
Scan-only non-read hits: `server/application/nats.ts:19` and `server/config/nats.ts:6` are comments.

B.
main.ts:210 -- config: `loadServerConfig()` calls `parseServerConfig` at `server/config.ts:350`; skipped when `options.config` is supplied.
main.ts:211 -- logger: `createLogger(config.logging)`.
main.ts:218-222 -- nonempty-token guard, then pool: `createDatabase(config.database, logger)`.
main.ts:228 -- tracing: `createTracingRuntime()`; no config passed, so it rereads tracing env before migrations/NATS.
main.ts:232-241 -- migrations from `config.database.migrationsDirectory`, unless skipped by option.
main.ts:243-268 -- NATS boundary, health, token map, and bridge from `config.nats`.
main.ts:74-77,170,247,287,348 -- embedder is not constructed; imported `generateEmbedding*` functions are passed through, with module-level env state already loaded.
main.ts:278-282 -- capture-health runtime receives raw `process.env`.
main.ts:284-360 -- auth, REST surface, application, MCP factory, and routes are composed.
main.ts:362-371 -- port/bind host are resolved, then the HTTP listener opens.
Direct env departures: `:153` WAL path, `:279` capture env, `:313` `ALLOWED_ORIGINS`, `:362` `PORT`, `:364` `OPEN_BRAIN_BIND_HOST`; audit at `:159` also defaults to `src/audit-log.ts` env parsing.
src/embedding.ts:6-10,35-36 -- import-time embedding configuration -- imported by `server/main.ts:74-77`, `src/maintenance-bootstrap.ts:41`, `server/tools/ingest-conversation-facts.ts:37`, and `src/operator-doctor.ts:7-13`.
src/logger.ts:26,115-125,175-189,201-205,583 -- module logger/config/file-sink singleton -- imported directly by `server/observability/langfuse-tracing.ts:100` and indirectly by source modules.
server/tools/realtime-stores.ts:26-27,34-46 -- lazy module-scoped fallback stores, not import-time; main injects stores at `main.ts:150-155`.

C.
server/config.ts:115-123 -- database fields.
server/config.ts:124-127 -- logging/service fields.
server/config.ts:128-135 -- transport/session fields.
server/config.ts:136-137 -- embedding fields.
server/config.ts:138 -- shared-namespace field.
server/config.ts:139-144 -- auth-token fields.
server/config.ts:145-146 -- catchall optional strings, including NATS/maintenance keys not explicitly schema fields.
Yes, beyond main: production call is `server/config.ts:350`; direct test calls are in `server/config.test.ts`, `server/application/{shadow-application.test.ts,sdk-protocol.pg.test.ts}`, and `server/main.pg.test.ts`. `main.ts` calls `loadServerConfig`, not `parseServerConfig` directly.

D.
Import-time blockers: `src/embedding.ts` and `src/logger.ts` above.
Runtime source blockers: `src/audit-log.ts:134-156`, `src/operator-doctor.ts:331,433-435,637,649-686`, `src/qmd-path.ts:14-22`, `src/nats-runtime.ts:493-529`, `src/shared-namespace.ts:14,21,27,44+`, `src/promotion-service.ts:235`, `src/drop-folder-collector.ts:97,145`, and `src/maintenance-bootstrap.ts:232-246`.
Env-mutating tests needing exemption or rewiring include `server/application/sdk-protocol.pg.test.ts:395-396`, `server/config.test.ts:234-247`, `src/embedding.test.ts`, `src/operator-doctor.test.ts`, namespace-policy tests, search timeout tests, FTS tests, and promotion tests.

verified: `rg -n 'process\.env' server --type ts | rg -v '\.test\.ts'` -> 22 textual hits across 11 files; 11 executable reads outside config.ts/main.ts.
verified: `rg -n 'parseServerConfig' server src` -> 27 textual references; production definition/call only at config.ts:314/350; remaining direct calls are tests.
verified: `rg -n 'process\.env' src --type ts | rg -v '\.test\.ts'` -> 81 legacy-source textual hits.
verified: inventory was read-only; no edit, commit, or test command issued.

```
