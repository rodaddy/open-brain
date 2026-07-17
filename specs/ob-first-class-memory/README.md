# Open Brain First-Class Local Runtime

Canonical issue: https://github.com/rodaddy/open-brain/issues/293

## Purpose

Provide the smallest package-owned Python API that thin, visible runtime adapters can use to make `openbrain-memory` the primary local lifecycle path while preserving an injectable `mcp2cli` fallback.

## Source of truth

The explicit task acceptance criteria, issue #293, existing `python/openbrain-memory` code/tests, and repo instructions govern this run. Existing client and `AgentMemory` protocol semantics are reused rather than reimplemented.

## Packet index

- `EXECUTION_WORKFLOW.md` — implementation and review loop
- `TASKS.md` — ordered deliverables and acceptance checks
- `AGENTS.md` — bounded implementation/review briefs
- `PROGRESS.md` — live status and evidence
- `VALIDATION.md` — command ladder and acceptance matrix
- `DECISIONS.md` — material design and deviation record

## In scope

- Typed runtime scope/config from explicit arguments and environment
- Exact-scope context-pack recall
- Distilled capture, checkpoint, and wrap operations
- Honest structured receipts
- Bounded JSON module/console entry point
- Optional injectable `mcp2cli` fallback
- Existing package redaction and size enforcement
- Fake transport/subprocess tests
- Required package exports, version, and package docs

## Package-hardening evidence

- A failed fresh-lane `session_start` queues the lane prerequisite and requested
  capture/checkpoint/wrap as one atomic replay-ordered spool batch, or reports the
  requested write `lost` without adding an orphan prerequisite.
- Wrap metadata performs one secret scan per persisted string; aggregate size
  checks remain, and every string still fails closed before any write.
- Public runtime API/types remain in `runtime.py`; fixed mcp2cli routing and
  ordered-spool internals live in focused private modules. `runtime.py` is below
  the repository's 750-line hard warning.
- Package version remains `0.1.8`; this hardening slice does not change the public
  package contract or require a version bump.

## Out of scope

- Runtime-home files or hooks
- Server TypeScript or protocol changes
- Lockfiles outside `python/openbrain-memory`
- GitHub mutations
- Raw transcript ingestion or storage
- Deployment and live runtime rollout
