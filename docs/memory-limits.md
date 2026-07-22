# First-Class Memory: Capacity, Backpressure, and Degradation Limits

Single reference for the limits that are enforced in code today, what happens
at each limit, and which envelope items are deliberately deferred. Sources are
cited per limit; if this page and the code disagree, the code wins and this
page must be fixed in the same PR.

Design rule (from #300 and the PR #305 incident): **capacity limits surface as
backpressure or an observable receipt — never as silent loss of acknowledged
data.** The one hard acceptance criterion — never silently drop an
acknowledged checkpoint — is regression-tested
(`python/openbrain-memory/tests/test_spool.py`, saturation tests fail on the
old FIFO-eviction behavior).

## Python client (openbrain-memory)

| Limit | Value | At-limit behavior | Source |
|---|---|---|---|
| Distilled content size | 16 KiB (UTF-8 bytes) | `ValueError` before any transport call; nothing persisted | `_runtime_validation.py` `MAX_DISTILLED_CONTENT_BYTES` |
| CLI JSON input | 64 KiB | Input rejected, error receipt, no partial parse | `cli.py` `MAX_JSON_INPUT_BYTES` |
| Spool line cap | 1000 records | `SpoolFullError` (a `ValueError` subclass); spool file byte-for-byte unchanged; caller receipt degrades (write reported non-durable) instead of silently evicting | `spool.py` `JsonlSpool(max_lines=1000)` |
| Spool byte cap | 1,000,000 bytes | Same `SpoolFullError` backpressure at saturation; a single batch that can never fit raises plain `ValueError` | `spool.py` `JsonlSpool(max_bytes=1_000_000)` |
| Spool payload redaction | always | Payloads pass `redact_value` before disk persistence | `spool.py` `_record_line` |
| Replay concurrency | 1 (serialized) | Drain runs under the runtime operation lock on healthy operations only; failed/foreign/poison units are retained in place, never dropped | `runtime.py` `_drain_spool` (#309, #314) |
| Queue observability | content-free | `SpoolStatus`: pending count, oldest/newest timestamps, per-operation counts, corrupted-line count — no payloads | `spool.py` `SpoolStatus` |

Write outcomes (`ReceiptStatus`, `runtime.py`): `SAVED` (direct write
succeeded) → `SPOOLED` (durable locally, replayed automatically on the next
healthy operation) → `FALLBACK` (delivered via a configured fallback route) →
`FAILED`/`LOST` (loudly reported in the receipt, never silent; `LOST` includes
spool-saturated). `DIRECT` is the recall-success status, not a write status.
Recovery is automatic: #309 auto-drain fires on every healthy direct recall
and saved write; #314 replays units under their parked exact scope with
namespace provenance.

## Server (Bun/TypeScript)

| Limit | Value | At-limit behavior | Source |
|---|---|---|---|
| Audit retention | configurable 1–366 days, default 30 | Out-of-range or non-numeric env values silently fall back to the default (30) — never clamped, never rejected; same fallback semantics for all audit config bounds | `src/audit-log.ts` `readBoundedInt`, `MAX_RETENTION_DAYS` |
| Audit write timeout | default 1000 ms, configurable 50–5000 ms | Write abandoned at the configured timeout; out-of-range env falls back to 1000 ms; audit is fail-open by documented design on LAN-local infra (facts-only rows, no payloads) | `src/audit-log.ts` `DEFAULT_WRITE_TIMEOUT_MS`, `MAX_WRITE_TIMEOUT_MS` |
| Audit in-flight writes | 4 | Audit writes are skipped while 4 are in flight **or whenever the DB pool has any waiters** — drops can occur below the cap under pool pressure (fail-open, intentional) | `src/audit-log.ts` `MAX_IN_FLIGHT_AUDIT_WRITES` |
| Recovery WAL TTL | 24 h | Expired entries dropped from recovery view | `src/realtime/recovery-wal.ts` `DEFAULT_RECOVERY_WAL_BUDGET.ttl_ms` |
| Recovery WAL sessions | 128 | Bounded; oldest-session eviction within the recovery (non-authoritative) view only | `recovery-wal.ts` `max_sessions` |
| Recovery WAL items | 50/session, 2048 global | Bounded as above | `recovery-wal.ts` `max_items_per_session`, `max_global_items` |
| Recovery WAL content | 8000 content / 2000 metadata chars | Oversize item **rejected at ingest** (`content_too_large` / `metadata_too_large`) — nothing stored | `recovery-wal.ts` append validation |
| Recovery WAL preview | 1000 chars | Truncated (only the preview truncates; content/metadata reject) | `recovery-wal.ts` `max_preview_chars` |

The recovery WAL is a bounded convenience view over durable lane data — its
evictions never delete authoritative rows, so its caps are not a durability
surface.

## Deliberately deferred (safe because nothing at these envelopes can lose acknowledged data)

- Concurrent multi-runtime load-test suite (Claude+Codex+Python on one lane) —
  P2/P3 program work; correctness under concurrency is covered by the
  operation lock, exact-scope proofs, and per-tool server tests, not by a
  load harness.
- Saturation alerting thresholds / unified degraded-state signal beyond
  `SpoolStatus` and receipts — revisit with #296's drain receipts.
- Receipt retention policy and backup storage/duration envelopes — owned by
  the backup/restore program (#298).
- Replay throughput limits beyond serialized-drain — no observed need at
  current fleet size; revisit if drain latency ever shows up in receipts.
