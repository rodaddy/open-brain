# Validation

## Policy

Fast regression coverage uses local fake boundaries. Final Open Brain acceptance additionally uses a disposable loopback server, an isolated PostgreSQL 18 database restored from a read-only core01 logical dump, fixture-only auth/embedding, and an isolated mcp2cli HOME. Inactive provider invocation is validated on the separate Development branch and may be cited here only as cross-repository evidence. Never print copied content or credential values or mutate production. Hosted deployment and active runtime registration remain separate gates.

## Command ladder

1. `uv sync`
2. `uv run pytest -q <targeted runtime test files>`
3. `uv run ruff format --check src tests`
4. `uv run ruff check src tests`
5. `uv run mypy src/openbrain_memory`
6. `uv run pytest -q`
7. `uv build`
8. `bunx tsc --noEmit` and full `bun test` with isolated `DB_NAME`, `DB_NAME_TEST`, and `OPENBRAIN_TEST_DATABASE_URL`
9. `bun run scripts/assert-db-tests-ran.ts <junit.xml>`
10. Loopback HTTP/MCP, package CLI, isolated mcp2cli, and spool/replay canaries
11. Separate Development branch: inactive Claude/Codex/Pi provider canaries (cross-repository evidence, not an Open Brain changed path)

## Matrix

- Config/scope precedence and validation — unit tests
- Existing-client auth header and exact context-pack scope — fake HTTP transport
- Receipt truthfulness and recall fail-open — fake memory/client objects
- Spool versus lost write — fake transport/spool boundary
- Failed lane start ordering — atomic JSONL batch proves prerequisite then requested
  write, while batch failure proves no orphan prerequisite mutation
- Bounded spool retention — group metadata survives parsing and replay rewrites;
  later FIFO eviction removes a complete ordered batch rather than half of it
- Replay dependency safety — a failed grouped prerequisite blocks its remaining
  writes; malformed group metadata fails closed and legacy ungrouped JSONL remains
  compatible
- Fallback invocation shape/redaction — fake subprocess runner
- Bounded JSON CLI — direct main plus subprocess/module tests
- Package compatibility — full suite and build
- Restored production-shape compatibility — structural/count-only validation, migrations, pgvector/halfvec checks
- Server exact-scope persistence — real PostgreSQL attachment plus conflicting-scope rejection
- Durable context-pack hydration — explicitly requested section, exact seven-coordinate predicates, bounded distilled events, generic mismatch denial
- Direct package lifecycle — real HTTP recall/capture/checkpoint/wrap and exact-scope readback
- Fallback lifecycle — isolated local mcp2cli HOME/config with direct URL forced unavailable
- Offline durability — grouped JSONL spool, file mode, replay order, empty-after-replay, and truthful lost exit
- Runtime continuity (separate Development branch) — inactive Claude/Codex/Pi writes and startup recall through the same lane, with strict 3,000-character envelopes
- Activation safety (separate Development branch) — active runtime configuration fingerprints unchanged before/after

## Evidence

Record exact command, exit status, and unabridged summary in `PROGRESS.md`. Any skip requires a reason and residual risk.

## Final acceptance

All commands pass; Open Brain tests and local canaries prove the repository-owned behavior; changed paths stay inside the package/spec surface plus the server context-pack/scope owner, public contract/rollout docs, and shared NATS caller. Provider fixes and inactive provider canaries remain on the separately owned Development branch.
