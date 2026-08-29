# L5 cut plan — move every src/ file into server/ (issue 864)

**Status: WRITTEN 2026-08-29, no lane merged yet.**

Authority: `_plans/server-hardening-ladder.md` L5 (lines 291-330) and L6 (lines
332-360). L5's own done-means is "zero imports from `src/` in non-test
`server/` code"; Rico's 2026-08-29 ruling widens it — everything moves out of
`src/`, and `src/` retires at L6.

## Measurement (42944000)

| Quantity | Value |
|---|---|
| src/ files runtime-reachable from `server/main.ts` | 67 |
| lines in those 67 | 30675 |
| src/ files NOT runtime-reachable | 91 |
| — of those, imported only by `scripts/` entrypoints | 12 |
| — retired entrypoint trio (`src/index.ts`, `src/transport.ts`, `src/server.ts`) | retires at L6 |
| direct modules / import sites, including type-only | 25 / 38 |
| direct modules / import sites, runtime only | 23 / 29 |
| oxlint findings across the 67 | 191 |

Re-measure with `bun scripts/src-runtime-closure.ts --count`. The number falls
by exactly the files a lane moves and never rises (rule M3).

## Clusters and home directories

| # | Files | Home | Note |
|---|---|---|---|
| C1a | `src/chunk-write.ts` | `server/capture/` | leaf |
| C1a | `src/decomposition.ts` | `server/domain/` | leaf |
| C1a | `src/secret-patterns.ts` | `server/security/` | leaf |
| C1a | `src/nats-subjects.ts` | `server/config/` | leaf |
| C1a | `src/tools/table-constants.ts` | `server/db/` | leaf |
| C1b | `src/promotion-nomination.ts`, `src/promotion-service.ts`, `src/sharing.ts`, `src/tiering.ts` | `server/domain/` | promotion |
| C3 | `src/embedding.ts`, `src/chunking.ts`, `src/embedding-canonical.ts`, `src/embedding-targets.ts` | `server/embedding/` | head decision; the charter names no embedding home. UNVERIFIED against `_plans/463-server-rewrite-charter.md` |
| C2 | `src/audit-log.ts`, `src/logger.ts`, `src/rotating-file.ts` | `server/logging/` | MERGE with the existing logger; judgment lane |
| C4 | `src/operator-doctor.ts` | `server/application/` | doctor |
| C4 | `src/contract.ts`, `src/contract-schemas.ts` | `server/contracts/` | |
| C4 | `src/nats-runtime.ts`, `src/qmd-path.ts`, `src/db/pool.ts`, `src/observability/*` | per-file | pool and observability are twins — diff before moving |
| C5 | `src/rest-api.ts`, `src/rest-promotion.ts` | `server/transport/` | REST |
| C5 | `src/namespace-policy.ts`, `src/permissions.ts`, `src/shared-namespace.ts`, `src/read-policy.ts`, `src/table-projections.ts`, `src/extraction.ts` | `server/auth/` or `server/domain/` | three have `server/auth` twins: RETARGET after a diff read |
| C5 | `src/tools/search-brain.ts`, `fts-config`, `source-refs` | see note | reached ONLY by `src/rest-api.ts`, while `server/tools/search-brain.ts` is the registered MCP tool. DANGEROUS drifted twin: retarget REST search onto the server/ implementation after a behavior diff |
| C6 | `src/nats-bridge.ts`, `src/auth.ts`, `src/background-tracing.ts` | `server/application/` | NATS bridge |
| C6 | `src/tools/agent-context-pack.ts` + its seven `agent-context-pack-*.ts`, `src/realtime/recovery-wal.ts`, `src/realtime/working-set.ts`, `src/prior-context-suppression.ts` | see note | reached only through `nats-bridge`, while `server/tools/agent-context-pack.ts` is the registered tool. Same DANGEROUS twin shape as C5 |
| C7 | `src/maintenance-bootstrap.ts`, `src/maintenance-queue.ts`, `src/maintenance-sweep.ts` | `server/maintenance/` | |
| C7 | `src/distill-handler.ts`, `src/distill-window.ts`, `src/distiller.ts`, `src/dream-light.ts`, `src/dream-rem.ts`, `src/candidate-dedupe.ts`, `src/graph-derivation.ts`, `src/graph-derivation-handler.ts`, `src/embedding-repair.ts`, `src/embedding-repair-handler.ts`, `src/tools/ingest-raw-turn.ts` (twin) | `server/domain/dream/` | authority `docs/dream-design.md`; largest cluster |

## Order

| Wave | Clusters | Why |
|---|---|---|
| 1 | C1a, C1b, C3 — in parallel now | leaves and self-contained groups, no twins |
| 2 | C2, C4 | C2 is a merge, C4 has twins needing a diff read |
| 3 | C5, C6 | only after their twin diff reads settle the retarget |
| 4 | C7 | largest, and depends on the domain homes wave 1-2 establish |

Every lane follows drag rule M3: a moved file's imports of other `src/` files
are rewritten to `../../src/<x>.ts` and those files are NOT pulled along. The
closure after a lane equals the closure before minus exactly the files it moved.

## Expected closure after each wave

| After | Closure |
|---|---|
| start | 67 |
| wave 1 (C1a 5, C1b 4, C3 4) | 54 |
| wave 2 (C2 3, C4 ~7) | 44 |
| wave 3 (C5 ~11, C6 ~12) | 21 |
| wave 4 (C7 ~14, plus stragglers) | 0 |

Per-cluster line counts come from the census in the measurement table; a lane
reports its own before/after closure in its commit body (rule M6).

## L6 preconditions (from the ladder, lines 332-360)

1. Runtime closure of `src/` at 0.
2. `package.json` start flipped from `src/index.ts` to `server/main.ts`.
3. `src/index.ts`, `src/transport.ts`, `src/server.ts` retired.
4. `scripts/` entrypoints repointed off `src/`.

Only then does L6 (Docker image, k3s deploy against the CNPG database, `src/`
deleted) open.
