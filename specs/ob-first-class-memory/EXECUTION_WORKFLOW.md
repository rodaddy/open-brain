# Execution Workflow

## Rules

- Treat this packet, issue #293, and current package code/tests as source of truth.
- Lock scope before implementation and record material deviations in `DECISIONS.md`.
- Convert manually debugged behavioral failures into regressions when practical.
- Reuse `OpenBrainClient` and `AgentMemory`; do not duplicate server/protocol semantics.

## Loop

1. Scope the exact package boundary and observable behavior.
2. Add the smallest typed implementation and public exports.
3. Add fake-boundary tests for each acceptance criterion.
4. Run targeted tests and fix failures.
5. Run the full package validation ladder.
6. Update `PROGRESS.md`, `VALIDATION.md`, and `DECISIONS.md`.

## Preflight gate

Before code edits: repo instructions read; branch/status checked; package APIs/tests inspected; scope lock recorded; validation commands identified.

## Completion rule

Implementation evidence is ready for controller evaluation only after required package tests, Ruff, mypy, and build pass, packet state is current, and no unapproved files changed.
