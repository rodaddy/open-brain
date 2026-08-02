# #463 — Bun/TypeScript server rewrite charter

**LAW-0 state: WRITTEN.** Charter and non-serving scaffold only. Cutover is **NOT STARTED** (`server/state.ts:1-6`; `server/README.md:1-8`).

## 0. Governing route

- The rewrite preserves behavior and imposes owned module boundaries; it is not a product redesign. The current server remains the application that owns all judgment (`docs/architecture.md:34-50`).
- `src/` is the same application being rewritten, and coupling a replacement to the old `src/contract.ts` shape is explicitly called out as wrong (`_plans/python-port-sequence.md:438-439`).
- The final server cutover remains sequenced after the Python applications named by map issue #443 and issue #463. This charter and scaffold are the parallel-safe work authorized before that gate; no startup command references `server/` (`package.json:7-15`; `server/README.md:1-8`).
- Canon/decision authority outranks observations. A rewrite implementation may flag contradiction but may not silently reinterpret canon (`docs/code-brain-design.md:125-160`).
- The decision README indexes nine records (`docs/decisions/README.md:31-43`). The live directory also contains five newer records not yet in that index: capture, dual-write, grading pass-through, Light counting, and operator rejection (`docs/decisions/capture-never-drops-a-turn.md:1`, `docs/decisions/dual-write-to-playground.md:1`, `docs/decisions/let-everything-pass-grading.md:1`, `docs/decisions/light-counts-but-does-not-gate.md:1`, `docs/decisions/operator-rejection-outcomes.md:1`). This charter treats all 14 live records as authority where relevant.

## 1. Current server inventory

### 1.1 Census and entrypoints

The current production census is **140 non-test TypeScript modules / 50,357 lines** under `src/`; the file-by-file receipt is Appendix A. The earlier architecture census was 142 non-test files / 50,452 lines on 2026-07-30, so this charter uses the live tree rather than the stale count (`docs/architecture.md:55-70`; Appendix A).

The running topology is:

1. `package.json` starts `src/index.ts`, or `scripts/run-two-worker.ts` for the core01 worker front (`package.json:7-14`).
2. `src/index.ts` owns Express creation, CORS/JSON middleware, `/health`, operator-doctor REST, REST routers, MCP routes, migration boot, auth token loading, NATS startup, maintenance startup, listener binding, and shutdown (`src/index.ts:1-39`, `src/index.ts:58-252`, `src/index.ts:255-437`).
3. Each MCP session gets a fresh `McpServer`, then every tool is registered into it (`src/index.ts:214-221`; `src/server.ts:28-37`; `src/tools/index.ts:81-156`).
4. The two-worker launcher starts workers on private ports, keeps session affinity, and exposes an aggregate `/health` with a `workers` array (`scripts/run-two-worker.ts:35-67`, `scripts/run-two-worker.ts:91-150`).

### 1.2 Concrete spaghetti

These are measured ownership failures, not aesthetic complaints:

- **Composition owns behavior.** `src/index.ts` is both application bootstrap and HTTP behavior: it builds health payloads, performs permission checks, maps errors, builds MCP sessions, runs migrations, starts NATS/maintenance, and shuts dependencies down (`src/index.ts:58-252`, `src/index.ts:255-437`).
- **SQL is not owned by a repository boundary.** Direct `pool.query` / `client.query` / `tx.query` calls occur across 68 production modules; Appendix A records 226 call sites. The intended database chokepoint currently owns only pool construction and health (`src/db/pool.ts:1-88`), while tool/domain modules execute SQL directly (Appendix A).
- **Security policy is spread.** Token parsing/delegation lives in `src/auth.ts:6-148`; role/table permissions in `src/permissions.ts:3-73`; namespace write policy in `src/namespace-policy.ts:1-173`; shared fallback policy in `src/shared-namespace.ts:1-123`; read policy in `src/read-policy.ts:1-84`; transport separately rechecks session identity in `src/transport.ts:190-213`. Appendix A records auth/namespace references throughout tool and domain files.
- **Configuration is spread.** Production modules read `process.env` directly in 18 files, including the application entrypoint and transport (`src/index.ts:41-56`, `src/index.ts:255-354`; `src/transport.ts:30-37`, `src/transport.ts:64-75`). This conflicts with the one validated config module rule (`_DOCS/STANDARDS-typescript.md:183-191`).
- **Logging is cross-cutting rather than injected.** 74 production modules directly reference the shared logger; the target standard calls for one configured root plus operation context (`_DOCS/STANDARDS-typescript.md:167-180`; Appendix A).
- **Tool registration is centralized but tool ownership is not.** `src/tools/index.ts` imports the entire tool fleet and registers 63 tool names (`src/tools/index.ts:1-68`, `src/tools/index.ts:81-156`). Individual tool files commonly own schema, permission checks, SQL, mapping, and response construction together (Appendix A).
- **Large multi-concern modules are ordinary.** Examples: `candidate-review.ts` 1,813 lines, `search-brain.ts` 1,688, `contract-schemas.ts` 1,578, `agent-context-pack.ts` 1,459 and five registered tools, `append-session-event.ts` 1,385, `drop-folder-collector.ts` 1,122, and `contract.ts` 936 (Appendix A). The repo standard is 500 code lines per file (`_DOCS/STANDARDS-typescript.md:125-165`).
- **Contract knowledge is duplicated by shape.** Public schema descriptions live in `src/contract-schemas.ts:1-1578`, the manifest assembler in `src/contract.ts:1-936`, and runtime Zod schemas inside individual tool registrations (Appendix A). `get_contract` is explicitly the agent's whole capability surface, so drift here is behavioral breakage (`docs/decisions/contract-is-the-agent-surface.md:24-61`).
- **SDK-private behavior is patched in the server factory.** `src/server.ts` replaces `McpServer.validateToolInput` through a private property and throws if the SDK shape changes (`src/server.ts:4-26`). That compatibility seam must remain explicit, not disappear into bootstrap.

### 1.3 Tool registration ownership

`src/tools/index.ts:97-155` is the registration ledger. Appendix A names every registration site. Files that register more than one tool are:

- `src/tools/agent-context-pack.ts:943-1448` — `working_set_append`, `recovery_wal_append`, `recovery_wal_mark`, `agent_reflex_pointers`, `agent_context_pack`.
- `src/tools/repo-facts.ts:495-783` — `upsert_repo_fact`, `list_repo_facts`.
- `src/tools/source-registry.ts:175-367` — `register_source`, `list_sources`, `update_source`, `remove_source`, `source_ingestion_eligibility`.

Every other registered MCP tool has one registration site in its named file (Appendix A).

### 1.4 Auth, namespace, and SQL predicates

Frozen security behavior currently lives at these boundaries:

- Bearer parsing, constant-time token comparison, role-token mapping, delegated `X-Namespace` / `X-Agent-Id`, and token-vs-header namespace provenance: `src/auth.ts:6-24`, `src/auth.ts:26-94`, `src/auth.ts:96-148`.
- Role/table read-write-delete matrix: `src/permissions.ts:3-73`.
- Namespace write policy and promoter identity: `src/namespace-policy.ts:1-173`.
- Canonical `shared-kb` and explicit-only legacy `collab` behavior: `src/shared-namespace.ts:1-123`; `docs/memory-contract.md:65-75`; `docs/decisions/shared-kb-canonical-namespace.md:20-120`.
- Session identity binding compares token client, role, effective client, namespace source, and agent ID before reusing a transport: `src/transport.ts:190-213`, `src/transport.ts:229-249`, `src/transport.ts:327-370`.
- Table projection allowlists live separately in `src/table-projections.ts:1-14`; this is one of the few already-single-owner modules.
- Namespace predicates are also repeated in tool SQL. The exact per-file spread is Appendix A. Rewrite repositories must accept an auth-derived scope object rather than a caller-supplied namespace string. The security boundary remains server-side (`docs/memory-contract.md:65-75`; `AGENTS.md:228-237`).

### 1.5 Transport/session and core01 worker model

- The HTTP MCP transport stores sessions in a process-local map (`src/transport.ts:41-56`).
- Idle TTL resets after each request; in-flight requests cannot be expired by the idle timer (`src/transport.ts:91-166`). Regression coverage pins that invariant (`src/transport.test.ts:4-40`).
- `DEFAULT_MAX_SESSIONS = 100` is per process/worker and can be configured by `OPEN_BRAIN_MAX_SESSIONS` (`src/transport.ts:30-37`, `src/transport.ts:64-88`). Admission includes pending initializes, and overload returns 429 plus retry metadata (`src/transport.ts:78-89`, `src/transport.ts:251-319`).
- The core01 front starts two worker processes by default and aggregates their `/health` bodies into `workers` (`scripts/run-two-worker.ts:11-17`, `scripts/run-two-worker.ts:35-63`, `scripts/run-two-worker.ts:130-147`). Therefore the observed core01 capacity is approximately two independent 100-session maps, not one shared 200-session pool. The exact effective capacity under custom env is **UNVERIFIED** until the deployed env is read.
- The single-process `/health` shape includes status, server identity, DB, embedding, NATS, and timestamp (`src/index.ts:85-135`). Server tests pin healthy/degraded status and identity behavior (`src/server.test.ts:101-180`). The two-worker front adds `workers` and must preserve each nested worker body (`scripts/run-two-worker.ts:68-89`, `scripts/run-two-worker.ts:130-147`).

### 1.6 Dead code

No production module is proven dead by a runtime or build receipt in this charter. Files with no obvious in-`src/` importer may be script entrypoints, public imports, or test seams; deleting them from static reachability alone would violate the behavior-freeze rule. **UNVERIFIED:** a later phase should run an export/reachability audit across `src/`, `scripts/`, package entrypoints, and tests, then prove each deletion by red contract tests before removal.

One historical dead identity is documented, not active code: the old `n8n` role was 100% unused and was renamed to `ob-admin`; the current role is live policy (`src/permissions.ts:31-40`).

## 2. Frozen rewrite contract

The strangler may change ownership and implementation only. These surfaces stay frozen until an independently approved contract change.

| Frozen surface | Current authority | Pinning receipts |
|---|---|---|
| MCP tool names, input schemas, output shapes, annotations, rejection envelopes | `get_contract` is the complete agent capability surface (`docs/decisions/contract-is-the-agent-surface.md:24-61`, `docs/decisions/contract-is-the-agent-surface.md:75-151`) | Manifest/hash behavior `src/contract.test.ts:7-849`; public tool response `src/tools/__tests__/get-contract.test.ts:102-376`; protocol calls `src/tools/__tests__/protocol.test.ts:56-455`; per-tool tests in `src/tools/__tests__/` (Appendix A) |
| Cross-runtime declaration and memory lifecycle fixtures | Runtime-neutral fixture set (`contracts/README.md:1-24`) | TS gate `contracts/check-parity.ts:1-302`; Python replay `python/openbrain-memory/tests/test_contract_fixtures.py:36-68`, `python/openbrain-memory/tests/test_contract_fixtures.py:112-146`; manifest `contracts/memory/parity-manifest.json:1-86` |
| Python HTTP/MCP call shape and headers | Python client is the only Python write path (`docs/architecture.md:76-96`) | Initialize/auth/session headers `python/openbrain-memory/tests/test_client.py:1486-1599`; JSON-RPC `tools/call` shape `python/openbrain-memory/tests/test_client.py:1624-1662`; wrapper inventory `python/openbrain-memory/tests/test_client.py:1664-1959` |
| Python `AgentMemory` provider/facade semantics | Session lifecycle and write lanes (`docs/architecture.md:81-96`) | Session/event payloads `python/openbrain-memory/tests/test_agent.py:159-195`; lifecycle actions `python/openbrain-memory/tests/test_agent.py:197-294`; representative server contract calls `python/openbrain-memory/tests/test_agent.py:329-367` |
| Hook consumers | Live adapter and lifecycle provider call through `openbrain-memory`; no alternate Python write door (`docs/architecture.md:41-50`, `docs/architecture.md:98-139`) | Hook/application tests under `python/openbrain/tests/test_capture_*` (**UNVERIFIED as a complete list**); runtime call/receipt tests `python/openbrain-memory/tests/test_runtime.py:403-642`; repo design-gate hook wiring `.claude/settings.json:5-42` |
| `/health` single-worker and aggregate surfaces | Express worker health plus two-worker aggregate (`src/index.ts:85-135`; `scripts/run-two-worker.ts:68-89`, `scripts/run-two-worker.ts:130-147`) | `src/server.test.ts:101-180` and remaining `GET /health` cases in `src/server.test.ts:181-702`; Python client 503/degraded parsing `python/openbrain-memory/tests/test_client.py:274-312` |
| Streamable HTTP session lifecycle and identity binding | Process-local session map, TTL/in-flight rule, auth binding (`src/transport.ts:41-56`, `src/transport.ts:91-166`, `src/transport.ts:190-213`) | `src/transport.test.ts:4-40`; server MCP integration cases `src/server.test.ts:360-702`; Python retry/reinitialize cases `python/openbrain-memory/tests/test_client.py:2082-2517` |
| Database schema | Existing SQL migrations and `_migrations` ledger | Migration runner records each filename once inside a transaction (`src/db/migrate.ts:18-68`); migration tests under `src/db/migrations/*.test.ts`; real-Postgres assertion gate `scripts/assert-db-tests-ran.ts:1-150` |

### Migration rule

Migrations remain append-only: add the next migration file; never rewrite an already-ledgered file. The runner sorts SQL files, skips filenames present in `_migrations`, and records a new filename only after its transaction succeeds (`src/db/migrate.ts:18-68`). The current tree contains migrations through `045_rem_judgement.sql` (Appendix A lists the TypeScript migration runner/tests; the SQL directory is the schema authority).

### Downstream classification

The present scaffold changes no public contract and serves nothing, so hosted deploy, rtech-mcps, mcp2cli regeneration, Hermes runtime changes, and live agent canaries are **not applicable to this PR** (`server/state.ts:1-6`; `docs/downstream-rollout.md:8-22`). Any later phase that changes a schema, transport behavior, client-facing output, auth/namespace semantics, or migration-visible behavior re-enters the full downstream gate (`docs/downstream-rollout.md:8-20`, `docs/downstream-rollout.md:24-159`).

## 3. Target architecture — delta from current ownership

The new parallel root is `server/`, not `src2/`. `server/` names the application boundary permanently; `src2/` would encode a temporary migration state and force a second structural rename at cutover (`server/README.md:1-12`).

The directory skeleton is WRITTEN, but the internal hierarchy below is **UNVERIFIED as a final implementation layout** until each phase proves it against the frozen tests. It is the smallest delta that centralizes ownership already required by repo decisions:

| Boundary | Owns | Delta from current tree | Existing authority |
|---|---|---|---|
| `server/application/` | composition, startup and shutdown order | Removes behavior from `src/index.ts`; depends on typed ports | Current bootstrap mixes every lifecycle (`src/index.ts:255-437`); scaffold declaration `server/application/index.ts:1-7` |
| `server/config/` | all env parsing and startup validation | Replaces 18 scattered `process.env` readers with injected config | One config module rule (`_DOCS/STANDARDS-typescript.md:183-191`); scaffold `server/config/index.ts:1-7` |
| `server/contracts/` | frozen public declaration and later schema catalog | Makes contract identity independent of bootstrap/tool SQL | Contract is agent surface (`docs/decisions/contract-is-the-agent-surface.md:24-61`); scaffold declaration `server/contracts/declaration.ts:1-9` |
| `server/security/` | token auth, roles, namespace/read policy | Composes current five policy modules behind one auth-derived scope | Namespace security boundary (`docs/memory-contract.md:65-75`); scaffold `server/security/index.ts:1-7` |
| `server/db/` | pool lifecycle, transactions, repositories, append-only migrations | Moves SQL out of 68 modules; repositories receive auth-derived scope | Existing pool chokepoint (`src/db/pool.ts:1-88`), migration ledger (`src/db/migrate.ts:18-68`); scaffold `server/db/index.ts:1-7` |
| `server/domain/` | memory, sessions, promotion, DREAM rules | Extracts pure behavior from tool/SQL files without changing decisions | Server owns judgment (`docs/architecture.md:34-50`); R3 precedence (`docs/code-brain-design.md:125-160`); DREAM design remains authority (`docs/dream-design.md:1-643`); scaffold `server/domain/index.ts:1-7` |
| `server/tools/` | MCP schemas, names, registration, handler orchestration | Tool adapters become thin: validate, authorize, call domain/repository, map response | Frozen tool surface above; scaffold `server/tools/index.ts:1-7` |
| `server/transport/` | HTTP routes, MCP session lifecycle, health, worker front | Pulls transport behavior from `src/index.ts`, `src/transport.ts`, and `scripts/run-two-worker.ts` behind explicit ports | Current behavior receipts in §1.5; scaffold `server/transport/index.ts:1-7` |
| `server/observability/` | logger setup, correlation, safe error shape | Keeps direct logger imports out of domain/repositories | TypeScript observability standard (`_DOCS/STANDARDS-typescript.md:167-180`, `_DOCS/STANDARDS-typescript.md:198-209`); scaffold `server/observability/index.ts:1-7` |

### Dependency direction

**PROPOSED / UNVERIFIED:** `transport -> tools -> domain -> repository ports`; `application` composes concrete `config`, `security`, `db`, `observability`, and transport adapters. Domain code must not import Express, MCP SDK, `pg`, or `process.env`. Repositories must not decide authorization. Tools must not contain raw SQL. This direction is a delta enforcing the already-decided single ownership above; no prior decision record specifies the exact import graph.

### Authority handling

R3 authority is domain behavior, not transport metadata decoration. `canon > decided > observed` remains precedence, and observed contradictions become operator-visible evidence rather than automatic overrides (`docs/code-brain-design.md:125-160`). Promotion/canon logic must continue to follow the ratified decisions under `docs/decisions/`, including explicit lifecycle actions and shared namespace rules (`docs/decisions/shared-kb-canonical-namespace.md:20-139`; `docs/decisions/contract-is-the-agent-surface.md:75-151`).

## 4. Phasing and verification gates

### Phase 0 — charter and scaffold (this PR; parallel-safe)

**WRITTEN:** `server/` ownership declarations, no runtime imports from package startup, and a two-provider contract declaration harness (`server/README.md:1-32`; `contracts/server-contract-providers.ts:1-35`; `contracts/check-parity.ts:1-302`).

Gate:

- `bun contracts/check-parity.ts` names **2 server providers** and passes.
- `bun test contracts/server-contract-providers.test.ts` proves the candidate remains `scaffold-only` and `servesTraffic: false` (`contracts/server-contract-providers.test.ts:1-27`).
- `bunx tsc --noEmit` and full `bun test` pass.
- `git diff -- src/` is empty.

### Phase 1 — shared test adapters and pure domain seams (parallel with Python tail)

Build test-only adapters that run selected current `src/` handlers and new pure domain functions from the same input/output fixtures. Start with decisions that are already fully specified: capture admission, namespace policy, authority precedence, and contract declaration (`docs/decisions/capture-never-drops-a-turn.md:12-102`; `docs/code-brain-design.md:125-160`).

Gate: each new domain module is red/green against the same fixture as current behavior; no route or package entrypoint imports it; full existing suite remains green. No old module is retired.

### Phase 2 — repositories and security scope (parallel with Python tail)

Introduce repositories behind typed ports one aggregate at a time. Move SQL only after a parity test proves returned values, mutation effects, transaction behavior, and namespace isolation against real Postgres. Security produces an auth-derived scope object; repository methods require it for ID-based reads/mutations (`docs/memory-contract.md:65-75`).

Gate: focused fake tests plus live `OPENBRAIN_TEST_DATABASE_URL` tests; `scripts/assert-db-tests-ran.ts` proves the DB suites actually executed; no migration rewrite; no serving route imports the new repository.

### Phase 3 — MCP tool strangler (parallel-safe until routing changes)

For one tool at a time, implement the new tool schema/handler using the frozen contract and run it through the same in-memory MCP protocol tests as the current registration. The candidate registry remains separate from `src/tools/index.ts`.

Gate per tool: identical name/schema/annotations, identical success and stable error envelopes, identical permission/namespace behavior, identical DB-visible effects, and Python wrapper fake-transport tests unchanged. `get_contract` hash remains identical. Current registration remains active.

### Phase 4 — transport and health shadow implementation (waits for stable lower layers; no cutover)

Implement the single-worker HTTP/MCP session model and two-worker aggregate behind test factories. Reuse the frozen behavior: fresh server per session, auth-bound session identity, in-flight-safe TTL, 429 retry metadata, single-worker health, and aggregate `workers` health (`src/index.ts:214-221`; `src/transport.ts:41-88`, `src/transport.ts:91-166`, `src/transport.ts:190-213`; `scripts/run-two-worker.ts:130-147`).

Gate: run `src/server.test.ts`, `src/transport.test.ts`, Python client session/retry tests, and new implementation instances against the same assertions. The candidate binds only ephemeral test ports; production start scripts remain unchanged.

### Phase 5 — full candidate assembly (waits until the Python tail is complete)

Compose all new boundaries into a candidate entrypoint that is still not the package default. Run contract, protocol, real-Postgres, health, session concurrency, NATS, maintenance, Python package, and hook-consumer gates against both implementations.

Gate: candidate passes the complete frozen suite; contract hash is identical; database migrations are append-only and idempotent; downstream gate is classified from the actual diff. No `src/` deletion yet.

### Phase 6 — cutover and retirement (last)

Only after map issue #443's remaining Python work is landed and Phase 5 is green: switch `package.json`/deployment entrypoints, run local dogfood and core01 canaries, then retire old `src/` modules in reviewable slices. The strangler rule is absolute: a current module is removed only after the candidate behavior has passed the same contract tests and the serving entrypoint has been proven RUNNING.

Gate: local and hosted `/health`, representative MCP calls, session affinity under the two-worker front, DB-backed suites proved executed, Python client/provider and hook canaries, and every applicable downstream step in `docs/downstream-rollout.md:24-159`. Rollback is the prior package/deploy entrypoint until old files are actually retired.

## 5. Scaffold receipt

- Root: `server/` — permanent application name, not migration-version name (`server/README.md:1-12`).
- State: WRITTEN, scaffold only, serves nothing (`server/state.ts:1-6`; `server/README.md:1-8`).
- Typecheck inclusion: `tsconfig.json:23-29`.
- Dual-provider parity registry: current `src/` plus `server-rewrite-scaffold` (`contracts/server-contract-providers.ts:1-35`).
- Parity checker loops every provider against the same reviewed fixture (`contracts/check-parity.ts:123-129`, `contracts/check-parity.ts:224-241`).
- Scaffold-state tests prevent declaration parity from being reported as a serving implementation (`contracts/server-contract-providers.test.ts:1-27`). A deliberate `servesTraffic: true` mutation produced one failing test before restoration.
- A deliberate candidate schema-hash mutation made `contracts/check-parity.ts` fail specifically on `server-rewrite-scaffold` before restoration.
- No production start script references `server/` (`package.json:7-15`).

## Appendix A — every production module under `src/`

This generated census excludes `*.test.ts` and `__tests__/`. "Local dependency edges" are static relative imports. SQL/auth counts are triage signals, not semantic proof; the cited whole-file range is the receipt to inspect before moving behavior.

| Module | Lines | Local dependency edges | MCP tools registered | SQL call sites | Auth/namespace references |
|---|---:|---|---|---:|---:|
| `src/agent-memory.ts:1-666` | 666 | `./disclosure-bundle.ts`<br>`./sharing.ts` | — | 0 | 6 |
| `src/audit-log.ts:1-565` | 565 | `./types.ts`<br>`./logger.ts` | — | 1 | 10 |
| `src/auth.ts:1-148` | 148 | `./types.ts`<br>`./logger.ts` | — | 0 | 27 |
| `src/candidate-dedupe.ts:1-397` | 397 | `./maintenance-queue.ts` | — | 7 | 14 |
| `src/candidate-review.ts:1-1813` | 1813 | `./grading-reasons.ts`<br>`./logger.ts`<br>`./observability/index.ts` | — | 7 | 82 |
| `src/chunk-write.ts:1-155` | 155 | `./chunking.ts`<br>`./embedding.ts`<br>`./logger.ts` | — | 1 | 5 |
| `src/chunking.ts:1-91` | 91 | `./logger.ts` | — | 0 | 0 |
| `src/contract-schemas.ts:1-1578` | 1578 | `./tools/repo-facts.ts`<br>`./source-refs.ts` | — | 0 | 50 |
| `src/contract.ts:1-936` | 936 | `./contract-schemas.ts` | — | 0 | 18 |
| `src/db/migrate.ts:1-69` | 69 | `../logger.ts` | — | 7 | 0 |
| `src/db/pool.ts:1-88` | 88 | `../logger.ts`<br>`../observability/index.ts`<br>`../types.ts` | — | 1 | 1 |
| `src/decomposition.ts:1-109` | 109 | `./types.ts`<br>`./chunking.ts` | — | 0 | 4 |
| `src/disclosure-bundle.ts:1-365` | 365 | — | — | 0 | 3 |
| `src/distill-exchange-run.ts:1-464` | 464 | `./distill-exchange.ts`<br>`./distill-window.ts`<br>`./distill-handler.ts`<br>`./maintenance-queue.ts` | — | 5 | 26 |
| `src/distill-exchange.ts:1-930` | 930 | `./embedding.ts`<br>`./tools/ingest-raw-turn.ts`<br>`./distill-window.ts`<br>`./distiller.ts` | — | 0 | 18 |
| `src/distill-handler.ts:1-423` | 423 | `./embedding.ts`<br>`./distill-window.ts`<br>`./distiller.ts`<br>`./maintenance-queue.ts` | — | 5 | 15 |
| `src/distill-window.ts:1-285` | 285 | `./dream-light.ts` | — | 0 | 15 |
| `src/distiller.ts:1-482` | 482 | `./embedding.ts`<br>`./tools/ingest-raw-turn.ts`<br>`./distill-window.ts` | — | 0 | 6 |
| `src/dream-deep.ts:1-423` | 423 | `./maintenance-queue.ts`<br>`./candidate-dedupe.ts` | — | 0 | 15 |
| `src/dream-light.ts:1-497` | 497 | `./tools/ingest-raw-turn.ts` | — | 5 | 26 |
| `src/dream-rem.ts:1-634` | 634 | `./maintenance-queue.ts`<br>`./maintenance-queue.ts`<br>`./candidate-dedupe.ts` | — | 2 | 23 |
| `src/drop-folder-collector.ts:1-1122` | 1122 | `./types.ts`<br>`./logger.ts`<br>`./observability/index.ts`<br>`./namespace-policy.ts`<br>`./shared-namespace.ts`<br>`./embedding.ts`<br>`./extraction.ts`<br>`./source-registry.ts` | — | 4 | 50 |
| `src/embedding-canonical.ts:1-228` | 228 | — | — | 0 | 0 |
| `src/embedding-repair-handler.ts:1-237` | 237 | `./embedding.ts`<br>`./embedding-repair.ts`<br>`./embedding-targets.ts`<br>`./maintenance-queue.ts` | — | 0 | 6 |
| `src/embedding-repair.ts:1-724` | 724 | `./embedding.ts`<br>`./embedding-targets.ts`<br>`./logger.ts`<br>`./embedding-canonical.ts` | — | 0 | 39 |
| `src/embedding-targets.ts:1-335` | 335 | `./embedding.ts`<br>`./embedding-canonical.ts` | — | 0 | 30 |
| `src/embedding.ts:1-612` | 612 | `./chunking.ts`<br>`./logger.ts` | — | 0 | 0 |
| `src/extraction.ts:1-361` | 361 | `./logger.ts` | — | 0 | 7 |
| `src/grading-page.ts:1-1611` | 1611 | `./grading-reasons.ts` | — | 0 | 2 |
| `src/grading-reasons.ts:1-270` | 270 | `./candidate-review.ts` | — | 0 | 0 |
| `src/grading-server.ts:1-494` | 494 | `./candidate-review.ts`<br>`./grading-page.ts` | — | 0 | 31 |
| `src/graph-derivation-handler.ts:1-584` | 584 | `./logger.ts`<br>`./namespace-policy.ts`<br>`./shared-namespace.ts`<br>`./types.ts`<br>`./extraction.ts`<br>`./graph-derivation.ts`<br>`./source-registry.ts`<br>`./maintenance-queue.ts` | — | 5 | 41 |
| `src/graph-derivation.ts:1-570` | 570 | `./logger.ts`<br>`./namespace-policy.ts`<br>`./types.ts` | — | 6 | 67 |
| `src/index.ts:1-437` | 437 | `./db/pool.ts`<br>`./auth.ts`<br>`./server.ts`<br>`./transport.ts`<br>`./tools/index.ts`<br>`./embedding.ts`<br>`./db/migrate.ts`<br>`./logger.ts`<br>`./middleware/request-logger.ts`<br>`./rest-api.ts`<br>`./rest-promotion.ts`<br>`./nats-runtime.ts`<br>`./nats-bridge.ts`<br>`./tools/index.ts`<br>`./types.ts`<br>`./operator-doctor.ts`<br>`./maintenance-bootstrap.ts`<br>`./maintenance-queue.ts`<br>`./local-clone-mode.ts` | — | 0 | 14 |
| `src/local-clone-mode.ts:1-235` | 235 | — | — | 0 | 2 |
| `src/logger.ts:1-592` | 592 | `./secret-patterns.ts`<br>`./rotating-file.ts` | — | 0 | 1 |
| `src/maintenance-bootstrap.ts:1-284` | 284 | `./embedding.ts`<br>`./embedding-repair.ts`<br>`./types.ts`<br>`./maintenance-queue.ts`<br>`./embedding-repair-handler.ts`<br>`./graph-derivation-handler.ts`<br>`./dream-light.ts`<br>`./dream-rem.ts`<br>`./distill-handler.ts` | — | 0 | 20 |
| `src/maintenance-queue.ts:1-952` | 952 | — | — | 5 | 16 |
| `src/middleware/request-logger.ts:1-101` | 101 | `../contract.ts`<br>`../logger.ts` | — | 0 | 7 |
| `src/namespace-policy.ts:1-173` | 173 | `./types.ts`<br>`./shared-namespace.ts` | — | 0 | 40 |
| `src/nats-bridge.ts:1-600` | 600 | `./types.ts`<br>`./tools/index.ts`<br>`./auth.ts`<br>`./logger.ts`<br>`./tools/agent-context-pack.ts`<br>`./nats-runtime.ts`<br>`./nats-runtime.ts`<br>`./nats-runtime.ts` | — | 0 | 41 |
| `src/nats-runtime.ts:1-582` | 582 | `./tools/agent-context-pack.ts`<br>`./nats-subjects.ts`<br>`./logger.ts` | — | 0 | 19 |
| `src/nats-subjects.ts:1-49` | 49 | — | — | 0 | 0 |
| `src/nats-worker.ts:1-75` | 75 | `./embedding.ts`<br>`./nats-bridge.ts`<br>`./nats-runtime.ts`<br>`./tools/index.ts`<br>`./types.ts` | — | 0 | 0 |
| `src/observability/context.ts:1-75` | 75 | `../logger.ts` | — | 0 | 0 |
| `src/observability/index.ts:1-44` | 44 | `./observability/index.ts`<br>`../logger.ts`<br>`./context.ts`<br>`./with-logging.ts` | — | 0 | 0 |
| `src/observability/with-logging.ts:1-249` | 249 | `../logger.ts` | — | 0 | 0 |
| `src/operator-doctor.ts:1-495` | 495 | `./contract.ts`<br>`./embedding.ts`<br>`./db/pool.ts`<br>`./audit-log.ts`<br>`./qmd-path.ts`<br>`./logger.ts`<br>`./observability/index.ts`<br>`./nats-bridge.ts`<br>`./nats-runtime.ts`<br>`./nats-runtime.ts`<br>`./types.ts` | — | 1 | 3 |
| `src/permissions.ts:1-73` | 73 | `./types.ts` | — | 0 | 17 |
| `src/prior-context-suppression.ts:1-426` | 426 | — | — | 0 | 34 |
| `src/promotion-nomination.ts:1-35` | 35 | `./types.ts` | — | 0 | 0 |
| `src/promotion-service.ts:1-281` | 281 | `./types.ts`<br>`./read-policy.ts`<br>`./namespace-policy.ts`<br>`./shared-namespace.ts` | — | 3 | 22 |
| `src/qmd-path.ts:1-23` | 23 | — | — | 0 | 0 |
| `src/read-policy.ts:1-84` | 84 | `./types.ts`<br>`./shared-namespace.ts` | — | 0 | 28 |
| `src/realtime/recovery-wal.ts:1-784` | 784 | `../logger.ts`<br>`../observability/index.ts`<br>`./working-set.ts` | — | 0 | 3 |
| `src/realtime/working-set.ts:1-425` | 425 | `../logger.ts` | — | 0 | 6 |
| `src/rem-distill-options.ts:1-183` | 183 | `./rem-terra-grader.ts` | — | 0 | 0 |
| `src/rem-prompt.ts:1-308` | 308 | — | — | 0 | 0 |
| `src/rem-terra-grader.ts:1-256` | 256 | `./dream-rem.ts`<br>`./dream-rem.ts`<br>`./rem-prompt.ts` | — | 0 | 0 |
| `src/rem-terra-transport.ts:1-167` | 167 | `./rem-terra-grader.ts` | — | 0 | 0 |
| `src/rest-api.ts:1-683` | 683 | `./permissions.ts`<br>`./namespace-policy.ts`<br>`./embedding.ts`<br>`./embedding-canonical.ts`<br>`./extraction.ts`<br>`./tools/search-brain.ts`<br>`./tools/table-constants.ts`<br>`./table-projections.ts`<br>`./read-policy.ts`<br>`./shared-namespace.ts`<br>`./types.ts`<br>`./embedding.ts` | — | 7 | 82 |
| `src/rest-promotion.ts:1-307` | 307 | `./types.ts`<br>`./tools/search-brain.ts`<br>`./embedding.ts`<br>`./promotion-service.ts`<br>`./observability/index.ts`<br>`./read-policy.ts`<br>`./namespace-policy.ts`<br>`./shared-namespace.ts`<br>`./promotion-nomination.ts` | — | 4 | 37 |
| `src/rotating-file.ts:1-246` | 246 | — | — | 0 | 0 |
| `src/secret-patterns.ts:1-187` | 187 | — | — | 0 | 0 |
| `src/server.ts:1-37` | 37 | `./validation-errors.ts` | — | 0 | 0 |
| `src/shared-namespace.ts:1-123` | 123 | `./types.ts` | — | 0 | 19 |
| `src/sharing.ts:1-390` | 390 | `./observability/index.ts`<br>`./secret-patterns.ts`<br>`./secret-patterns.ts` | — | 0 | 2 |
| `src/source-refs.ts:1-179` | 179 | `./types.ts` | — | 0 | 6 |
| `src/source-registry.ts:1-685` | 685 | `./types.ts`<br>`./namespace-policy.ts`<br>`./read-policy.ts`<br>`./shared-namespace.ts`<br>`./logger.ts` | — | 8 | 87 |
| `src/source-sync.ts:1-874` | 874 | `./logger.ts`<br>`./namespace-policy.ts`<br>`./shared-namespace.ts`<br>`./source-registry.ts`<br>`./types.ts` | — | 15 | 58 |
| `src/table-projections.ts:1-14` | 14 | `./types.ts` | — | 0 | 5 |
| `src/tiering.ts:1-384` | 384 | `./embedding.ts`<br>`./embedding.ts`<br>`./logger.ts`<br>`./observability/index.ts` | — | 3 | 27 |
| `src/tools/access-report.ts:1-191` | 191 | `../permissions.ts`<br>`../read-policy.ts`<br>`../types.ts`<br>`../logger.ts`<br>`./index.ts`<br>`./table-constants.ts` | `access_report` | 6 | 9 |
| `src/tools/adjacent-context.ts:1-227` | 227 | `../permissions.ts`<br>`../read-policy.ts`<br>`../types.ts`<br>`../logger.ts`<br>`./index.ts`<br>`./graph-ids.ts`<br>`./table-constants.ts` | `adjacent_context` | 1 | 19 |
| `src/tools/agent-context-pack-budget.ts:1-404` | 404 | — | — | 0 | 0 |
| `src/tools/agent-context-pack-durable-lane.ts:1-488` | 488 | `./index.ts`<br>`./agent-context-pack.ts`<br>`../logger.ts` | — | 2 | 6 |
| `src/tools/agent-context-pack-durable-memory.ts:1-518` | 518 | `./index.ts`<br>`../types.ts`<br>`./agent-context-pack.ts`<br>`../permissions.ts`<br>`../read-policy.ts`<br>`./table-constants.ts`<br>`./search-brain.ts`<br>`../logger.ts`<br>`../observability/index.ts`<br>`./agent-context-pack-durable-lane.ts`<br>`../prior-context-suppression.ts` | — | 0 | 23 |
| `src/tools/agent-context-pack-guidance.ts:1-308` | 308 | `../observability/index.ts`<br>`./agent-context-pack-sections.ts` | — | 0 | 8 |
| `src/tools/agent-context-pack-pointers-candidates.ts:1-292` | 292 | `./search-brain.ts`<br>`./agent-context-pack-durable-memory.ts`<br>`./agent-context-pack-sections.ts` | — | 0 | 8 |
| `src/tools/agent-context-pack-repo-facts.ts:1-266` | 266 | `./repo-facts.ts`<br>`../observability/index.ts`<br>`./agent-context-pack-sections.ts` | — | 0 | 7 |
| `src/tools/agent-context-pack-sections.ts:1-109` | 109 | — | — | 0 | 1 |
| `src/tools/agent-context-pack.ts:1-1459` | 1459 | `../permissions.ts`<br>`../namespace-policy.ts`<br>`../read-policy.ts`<br>`../types.ts`<br>`../realtime/working-set.ts`<br>`../realtime/recovery-wal.ts`<br>`./index.ts`<br>`./agent-context-pack-durable-lane.ts`<br>`./agent-context-pack-durable-memory.ts`<br>`./agent-context-pack-budget.ts`<br>`../shared-namespace.ts`<br>`./agent-context-pack-guidance.ts`<br>`./agent-context-pack-repo-facts.ts`<br>`./agent-context-pack-pointers-candidates.ts`<br>`./agent-context-pack-sections.ts` | `working_set_append`<br>`recovery_wal_append`<br>`recovery_wal_mark`<br>`agent_reflex_pointers`<br>`agent_context_pack` | 1 | 49 |
| `src/tools/append-session-event.ts:1-1385` | 1385 | `../permissions.ts`<br>`../namespace-policy.ts`<br>`../embedding.ts`<br>`../sharing.ts`<br>`../types.ts`<br>`../logger.ts`<br>`./index.ts`<br>`./table-constants.ts` | `append_session_event` | 5 | 55 |
| `src/tools/archive-entity.ts:1-97` | 97 | `../permissions.ts`<br>`../namespace-policy.ts`<br>`../types.ts`<br>`../logger.ts`<br>`./index.ts`<br>`./graph-ids.ts` | `archive_entity` | 6 | 9 |
| `src/tools/archive-entry.ts:1-89` | 89 | `../permissions.ts`<br>`../namespace-policy.ts`<br>`../types.ts`<br>`../logger.ts`<br>`./index.ts` | `archive_entry` | 1 | 5 |
| `src/tools/brain-answer.ts:1-404` | 404 | `../permissions.ts`<br>`../read-policy.ts`<br>`../types.ts`<br>`./index.ts`<br>`./search-brain.ts`<br>`../shared-namespace.ts`<br>`../observability/index.ts`<br>`../source-refs.ts` | `brain_answer` | 0 | 19 |
| `src/tools/bulk-archive.ts:1-135` | 135 | `../permissions.ts`<br>`../namespace-policy.ts`<br>`../types.ts`<br>`../logger.ts`<br>`./index.ts` | `bulk_archive` | 4 | 9 |
| `src/tools/bulk-set-tier.ts:1-137` | 137 | `../permissions.ts`<br>`../namespace-policy.ts`<br>`../types.ts`<br>`../logger.ts`<br>`./index.ts` | `bulk_set_tier` | 4 | 8 |
| `src/tools/citation-recall.ts:1-296` | 296 | `../permissions.ts`<br>`../read-policy.ts`<br>`../types.ts`<br>`./index.ts`<br>`../logger.ts` | `citation_recall` | 0 | 14 |
| `src/tools/curate-entries.ts:1-302` | 302 | `../permissions.ts`<br>`../read-policy.ts`<br>`../namespace-policy.ts`<br>`../types.ts`<br>`../logger.ts`<br>`./index.ts`<br>`./table-constants.ts` | `curate_entries` | 5 | 16 |
| `src/tools/decompose-entry.ts:1-377` | 377 | `../embedding.ts`<br>`../permissions.ts`<br>`../namespace-policy.ts`<br>`../read-policy.ts`<br>`../shared-namespace.ts`<br>`../types.ts`<br>`../decomposition.ts`<br>`./index.ts` | `decompose_entry` | 6 | 28 |
| `src/tools/demote-entry.ts:1-94` | 94 | `../namespace-policy.ts`<br>`../read-policy.ts`<br>`../types.ts`<br>`../logger.ts`<br>`./index.ts` | `demote_entry` | 2 | 7 |
| `src/tools/drop-folder-collector.ts:1-185` | 185 | `../types.ts`<br>`../logger.ts`<br>`../drop-folder-collector.ts`<br>`./index.ts` | `collect_drop_folder` | 0 | 10 |
| `src/tools/find-duplicates.ts:1-173` | 173 | `../permissions.ts`<br>`../read-policy.ts`<br>`../types.ts`<br>`../logger.ts`<br>`./index.ts`<br>`./table-constants.ts` | `find_duplicates` | 1 | 9 |
| `src/tools/find-person.ts:1-169` | 169 | `../permissions.ts`<br>`../read-policy.ts`<br>`../types.ts`<br>`./index.ts` | `find_person` | 2 | 9 |
| `src/tools/fts-config.ts:1-232` | 232 | — | — | 0 | 1 |
| `src/tools/get-contract.ts:1-49` | 49 | `../permissions.ts`<br>`../types.ts`<br>`../contract.ts`<br>`./index.ts` | `get_contract` | 0 | 3 |
| `src/tools/get-entity.ts:1-55` | 55 | `../permissions.ts`<br>`../read-policy.ts`<br>`../types.ts`<br>`./index.ts`<br>`./graph-ids.ts` | `get_entity` | 1 | 6 |
| `src/tools/get-entry.ts:1-243` | 243 | `../permissions.ts`<br>`../read-policy.ts`<br>`../types.ts`<br>`./index.ts`<br>`../table-projections.ts`<br>`../source-refs.ts`<br>`./table-constants.ts` | `get_entry` | 2 | 14 |
| `src/tools/get-stats.ts:1-332` | 332 | `../permissions.ts`<br>`../read-policy.ts`<br>`../shared-namespace.ts`<br>`../types.ts`<br>`../logger.ts`<br>`./index.ts`<br>`./table-constants.ts` | `get_stats` | 10 | 35 |
| `src/tools/graph-ids.ts:1-9` | 9 | — | — | 0 | 0 |
| `src/tools/hydrate-entities.ts:1-167` | 167 | `../permissions.ts`<br>`../namespace-policy.ts`<br>`../types.ts`<br>`../logger.ts`<br>`./index.ts`<br>`./graph-ids.ts` | `hydrate_entities` | 1 | 18 |
| `src/tools/index.ts:1-156` | 156 | `../embedding.ts`<br>`../nats-bridge.ts`<br>`../nats-runtime.ts`<br>`./log-thought.ts`<br>`./log-decision.ts`<br>`./search-brain.ts`<br>`./find-person.ts`<br>`./session-save.ts`<br>`./session-load.ts`<br>`./archive-entry.ts`<br>`./list-recent.ts`<br>`./list-stale.ts`<br>`./update-entry.ts`<br>`./rate-entry.ts`<br>`./search-all.ts`<br>`./brain-answer.ts`<br>`./upsert-person.ts`<br>`./set-tier.ts`<br>`./get-entry.ts`<br>`./decompose-entry.ts`<br>`./resolve-entry.ts`<br>`./get-stats.ts`<br>`./access-report.ts`<br>`./bulk-set-tier.ts`<br>`./find-duplicates.ts`<br>`./curate-entries.ts`<br>`./bulk-archive.ts`<br>`./list-namespaces.ts`<br>`./tier-recommendations.ts`<br>`./lane-upsert.ts`<br>`./lane-load.ts`<br>`./append-session-event.ts`<br>`./ingest-raw-turn.ts`<br>`./citation-recall.ts`<br>`./session-context.ts`<br>`./session-start.ts`<br>`./session-wrap.ts`<br>`./upsert-entity.ts`<br>`./archive-entity.ts`<br>`./get-entity.ts`<br>`./hydrate-entities.ts`<br>`./list-entities.ts`<br>`./link-entities.ts`<br>`./unlink-entities.ts`<br>`./adjacent-context.ts`<br>`./promote-entry.ts`<br>`./demote-entry.ts`<br>`./scan-namespace.ts`<br>`./tier-lane.ts`<br>`./promote-shared.ts`<br>`./get-contract.ts`<br>`./operator-doctor.ts`<br>`./repo-facts.ts`<br>`./source-registry.ts`<br>`./drop-folder-collector.ts`<br>`./ingest-conversation-facts.ts`<br>`./agent-context-pack.ts`<br>`../realtime/working-set.ts`<br>`../realtime/recovery-wal.ts`<br>`../audit-log.ts` | — | 0 | 1 |
| `src/tools/ingest-conversation-facts.ts:1-803` | 803 | `../permissions.ts`<br>`../namespace-policy.ts`<br>`../shared-namespace.ts`<br>`../embedding.ts`<br>`../sharing.ts`<br>`../source-registry.ts`<br>`../types.ts`<br>`../logger.ts`<br>`./index.ts` | `ingest_conversation_facts` | 7 | 51 |
| `src/tools/ingest-raw-turn.ts:1-410` | 410 | `../permissions.ts`<br>`../namespace-policy.ts`<br>`../embedding.ts`<br>`../sharing.ts`<br>`../types.ts`<br>`../logger.ts`<br>`./index.ts` | `ingest_raw_turn` | 1 | 34 |
| `src/tools/lane-load.ts:1-195` | 195 | `../permissions.ts`<br>`../read-policy.ts`<br>`../types.ts`<br>`./index.ts`<br>`../logger.ts` | `lane_load` | 1 | 18 |
| `src/tools/lane-upsert.ts:1-293` | 293 | `../permissions.ts`<br>`../namespace-policy.ts`<br>`../embedding.ts`<br>`../types.ts`<br>`../logger.ts`<br>`./index.ts` | `lane_upsert` | 1 | 21 |
| `src/tools/link-entities.ts:1-200` | 200 | `../permissions.ts`<br>`../namespace-policy.ts`<br>`../types.ts`<br>`../logger.ts`<br>`./index.ts`<br>`./graph-ids.ts`<br>`./table-constants.ts` | `link_entities` | 1 | 19 |
| `src/tools/list-entities.ts:1-94` | 94 | `../permissions.ts`<br>`../read-policy.ts`<br>`../types.ts`<br>`./index.ts` | `list_entities` | 1 | 17 |
| `src/tools/list-namespaces.ts:1-127` | 127 | `../permissions.ts`<br>`../read-policy.ts`<br>`../shared-namespace.ts`<br>`../types.ts`<br>`../logger.ts`<br>`./index.ts`<br>`./table-constants.ts` | `list_namespaces` | 1 | 16 |
| `src/tools/list-recent.ts:1-242` | 242 | `../permissions.ts`<br>`../read-policy.ts`<br>`../types.ts`<br>`../logger.ts`<br>`./index.ts`<br>`./table-constants.ts` | `list_recent` | 2 | 9 |
| `src/tools/list-stale.ts:1-236` | 236 | `../permissions.ts`<br>`../read-policy.ts`<br>`../types.ts`<br>`../logger.ts`<br>`./index.ts`<br>`./table-constants.ts` | `list_stale` | 2 | 9 |
| `src/tools/log-decision.ts:1-151` | 151 | `../permissions.ts`<br>`../namespace-policy.ts`<br>`../embedding.ts`<br>`../embedding-canonical.ts`<br>`../extraction.ts`<br>`../types.ts`<br>`../logger.ts`<br>`../source-refs.ts`<br>`./index.ts` | `log_decision` | 1 | 14 |
| `src/tools/log-thought.ts:1-199` | 199 | `../permissions.ts`<br>`../namespace-policy.ts`<br>`../shared-namespace.ts`<br>`../embedding.ts`<br>`../chunk-write.ts`<br>`../extraction.ts`<br>`../types.ts`<br>`../logger.ts`<br>`../source-refs.ts`<br>`./index.ts` | `log_thought` | 1 | 16 |
| `src/tools/operator-doctor.ts:1-71` | 71 | `../types.ts`<br>`../operator-doctor.ts`<br>`../nats-runtime.ts`<br>`../observability/index.ts`<br>`./index.ts` | `operator_doctor` | 0 | 3 |
| `src/tools/promote-entry.ts:1-138` | 138 | `../types.ts`<br>`../logger.ts`<br>`../observability/index.ts`<br>`../promotion-service.ts`<br>`../shared-namespace.ts`<br>`./index.ts` | `promote_entry` | 0 | 11 |
| `src/tools/promote-shared.ts:1-207` | 207 | `../namespace-policy.ts`<br>`../promotion-service.ts`<br>`../read-policy.ts`<br>`../shared-namespace.ts`<br>`../sharing.ts`<br>`../types.ts`<br>`../logger.ts`<br>`./index.ts` | `promote_shared` | 1 | 21 |
| `src/tools/rate-entry.ts:1-99` | 99 | `../permissions.ts`<br>`../namespace-policy.ts`<br>`../types.ts`<br>`../logger.ts`<br>`./index.ts` | `rate_entry` | 1 | 6 |
| `src/tools/repo-facts.ts:1-785` | 785 | `../permissions.ts`<br>`../namespace-policy.ts`<br>`../read-policy.ts`<br>`../shared-namespace.ts`<br>`../types.ts`<br>`../logger.ts`<br>`./index.ts` | `upsert_repo_fact`<br>`list_repo_facts` | 2 | 39 |
| `src/tools/resolve-entry.ts:1-276` | 276 | `../permissions.ts`<br>`../read-policy.ts`<br>`../types.ts`<br>`./index.ts` | `resolve_entry` | 1 | 39 |
| `src/tools/scan-namespace.ts:1-175` | 175 | `../read-policy.ts`<br>`../shared-namespace.ts`<br>`../promotion-nomination.ts`<br>`../types.ts`<br>`../logger.ts`<br>`./index.ts`<br>`./table-constants.ts` | `scan_namespace` | 2 | 22 |
| `src/tools/search-all.ts:1-404` | 404 | `../permissions.ts`<br>`../read-policy.ts`<br>`../types.ts`<br>`../logger.ts`<br>`./index.ts`<br>`./search-brain.ts`<br>`../shared-namespace.ts`<br>`../qmd-path.ts`<br>`../source-refs.ts` | `search_all` | 0 | 20 |
| `src/tools/search-brain.ts:1-1688` | 1688 | `../permissions.ts`<br>`../read-policy.ts`<br>`../shared-namespace.ts`<br>`../source-refs.ts`<br>`../types.ts`<br>`./index.ts`<br>`../logger.ts`<br>`../observability/index.ts`<br>`./table-constants.ts`<br>`./fts-config.ts` | `search_brain` | 9 | 93 |
| `src/tools/session-context.ts:1-249` | 249 | `../permissions.ts`<br>`../read-policy.ts`<br>`../types.ts`<br>`./index.ts`<br>`../logger.ts`<br>`./table-constants.ts` | `session_context` | 2 | 18 |
| `src/tools/session-load.ts:1-139` | 139 | `../permissions.ts`<br>`../read-policy.ts`<br>`../types.ts`<br>`./index.ts`<br>`../logger.ts` | `session_load` | 2 | 11 |
| `src/tools/session-save.ts:1-196` | 196 | `../permissions.ts`<br>`../namespace-policy.ts`<br>`../embedding.ts`<br>`../embedding-canonical.ts`<br>`../types.ts`<br>`../logger.ts`<br>`./index.ts` | `session_save` | 2 | 17 |
| `src/tools/session-start.ts:1-331` | 331 | `../permissions.ts`<br>`../namespace-policy.ts`<br>`../types.ts`<br>`../logger.ts`<br>`./index.ts` | `session_start` | 4 | 24 |
| `src/tools/session-wrap.ts:1-488` | 488 | `../permissions.ts`<br>`../namespace-policy.ts`<br>`../embedding.ts`<br>`../embedding-canonical.ts`<br>`../types.ts`<br>`../logger.ts`<br>`../source-refs.ts`<br>`./index.ts` | `session_wrap` | 3 | 26 |
| `src/tools/set-tier.ts:1-96` | 96 | `../permissions.ts`<br>`../namespace-policy.ts`<br>`../types.ts`<br>`../logger.ts`<br>`./index.ts` | `set_tier` | 1 | 6 |
| `src/tools/source-registry.ts:1-371` | 371 | `../types.ts`<br>`../logger.ts`<br>`../source-registry.ts`<br>`./index.ts` | `register_source`<br>`list_sources`<br>`update_source`<br>`remove_source`<br>`source_ingestion_eligibility` | 0 | 25 |
| `src/tools/table-constants.ts:1-135` | 135 | `../types.ts` | — | 0 | 0 |
| `src/tools/tier-lane.ts:1-159` | 159 | `../permissions.ts`<br>`../namespace-policy.ts`<br>`../shared-namespace.ts`<br>`../tiering.ts`<br>`../types.ts`<br>`../logger.ts`<br>`./index.ts` | `tier_lane` | 1 | 24 |
| `src/tools/tier-recommendations.ts:1-198` | 198 | `../permissions.ts`<br>`../read-policy.ts`<br>`../types.ts`<br>`../logger.ts`<br>`./index.ts`<br>`./table-constants.ts` | `tier_recommendations` | 2 | 7 |
| `src/tools/unlink-entities.ts:1-98` | 98 | `../permissions.ts`<br>`../namespace-policy.ts`<br>`../types.ts`<br>`../logger.ts`<br>`./index.ts`<br>`./graph-ids.ts`<br>`./table-constants.ts` | `unlink_entities` | 1 | 13 |
| `src/tools/update-entry.ts:1-408` | 408 | `../permissions.ts`<br>`../namespace-policy.ts`<br>`../embedding.ts`<br>`../embedding-canonical.ts`<br>`../types.ts`<br>`../logger.ts`<br>`./index.ts` | `update_entry` | 9 | 10 |
| `src/tools/upsert-entity.ts:1-186` | 186 | `../permissions.ts`<br>`../namespace-policy.ts`<br>`../types.ts`<br>`../logger.ts`<br>`./index.ts` | `upsert_entity` | 1 | 22 |
| `src/tools/upsert-person.ts:1-183` | 183 | `../permissions.ts`<br>`../namespace-policy.ts`<br>`../embedding.ts`<br>`../types.ts`<br>`../logger.ts`<br>`./index.ts` | `upsert_person` | 1 | 13 |
| `src/transport.ts:1-428` | 428 | `./types.ts`<br>`./logger.ts` | — | 0 | 15 |
| `src/types.ts:1-63` | 63 | — | — | 0 | 3 |
| `src/validation-errors.ts:1-125` | 125 | `./audit-log.ts` | — | 0 | 0 |
