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
| Quarantine threshold | 5 consecutive failed replay attempts per unit (configurable: `JsonlSpool(quarantine_threshold=...)`) | The unit's original redacted lines move atomically to the `<spool>.quarantine.jsonl` sidecar behind a content-free envelope (spool keys, retry count, first/last failure unix times, error class name only — never message bodies); the unit is never retried automatically and one `QUARANTINED` receipt lands in the triggering drain report. Foreign-namespace parked units (#314) never count toward quarantine | `spool.py` `DEFAULT_QUARANTINE_THRESHOLD`, `replay_with_report` (#296) |
| Quarantine sidecar size | uncapped (operator-managed) | The `<spool>.quarantine.jsonl` sidecar has no line/byte cap by design: inflow is gated upstream by the main-spool caps, and each entry costs `quarantine_threshold` consecutive replay failures, so growth is slow and bounded by what the main spool could ever hold. Rotation guidance: after triaging an entry, archive or delete it from the sidecar (the envelope line together with its record lines); restored units re-enter the main spool and are subject to its caps. Re-quarantine of an already-present unit key replaces its entry in place (fresh lines/counts), so retries never grow the sidecar | `spool.py` `_append_quarantined_units` (#296, PR #317 review) |
| Retry-count persistence | per-unit consecutive failures + last replay success time | Survives process restarts via the `<spool>.retry-state.json` sidecar; crash-tolerant metadata only — a lost or corrupted sidecar loses retry counters, never spool records. Sidecar values are untrusted at parse: non-finite floats (NaN/Infinity) degrade to absent, and counters are clamped to a sane non-negative bound | `spool.py` `_load_retry_state`, `_commit_replay_pass` (#296) |
| Queue observability | content-free | `SpoolStatus`: pending count, oldest/newest timestamps, per-operation counts, corrupted-line count — no payloads; #296 adds `quarantined_count`, per-unit `retry_counts` (keyed by the unit's first record key), and `last_success_at` | `spool.py` `SpoolStatus` |

Write outcomes (`ReceiptStatus`, `runtime.py`): `SAVED` (direct write
succeeded) → `SPOOLED` (durable locally, replayed automatically on the next
healthy operation) → `FALLBACK` (delivered via a configured fallback route) →
`FAILED`/`LOST` (loudly reported in the receipt, never silent; `LOST` includes
spool-saturated). `DIRECT` is the recall-success status, not a write status.
Recovery is automatic: #309 auto-drain fires on every healthy direct recall
and saved write; #314 replays units under their parked exact scope with
namespace provenance. #296 extends the ladder with drain outcomes: a spooled
record that replays successfully gets a `REPLAYED` receipt (durable, linked by
its `idempotency_key` as `spool_key`), and a unit that crosses the quarantine
threshold gets one `QUARANTINED` receipt (durable — its redacted lines still
exist in the quarantine sidecar and can be restored-and-replayed by an
operator). Every drain produces a content-free `DrainReport` (counts +
receipts) exposed on `RuntimeOutput.drain` of the triggering operation and on
`FirstClassMemoryRuntime.last_drain_report`. Replay delivery is
at-least-once: a crash between dispatch success and the spool rewrite
re-delivers the same `idempotency_key` on the next drain.

The TypeScript client peer (`clients/ts/`, #312) enforces the same
distilled-content, spool-cap, redaction, quarantine, retry-state, and
cross-process exclusion limits (`clients/ts/src/spool.ts`,
`clients/ts/src/validation.ts`). The CLI JSON input limit remains Python-only;
see `clients/ts/README.md` for the intentional runtime differences.

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
  `SpoolStatus` and receipts — #296 landed drain reports and quarantine
  observability; alerting thresholds on top of them remain deferred.
- Receipt retention policy and backup storage/duration envelopes — owned by
  the backup/restore program (#298).
- Replay throughput limits beyond serialized-drain — no observed need at
  current fleet size; revisit if drain latency ever shows up in receipts.
