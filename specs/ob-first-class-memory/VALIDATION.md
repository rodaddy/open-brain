# Validation

## Policy

Use local fake boundaries only. No live service, deployment, remote mutation, or credential-bearing canary is required for this package foundation.

## Command ladder

1. `uv sync`
2. `uv run pytest -q <targeted runtime test files>`
3. `uv run ruff format --check src tests`
4. `uv run ruff check src tests`
5. `uv run mypy src/openbrain_memory`
6. `uv run pytest -q`
7. `uv build`

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

## Evidence

Record exact command, exit status, and unabridged summary in `PROGRESS.md`. Any skip requires a reason and residual risk.

## Final acceptance

All commands pass; tests prove each requested observable behavior; changed paths stay inside the allowed write set.
