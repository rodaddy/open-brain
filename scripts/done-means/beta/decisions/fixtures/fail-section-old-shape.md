# Fixture — a non-ledger table first, an OLD five-column ledger under "## Ledger"

The schema failure must name the LEDGER table's line, not the first table's.

## What the old signal got wrong

| Flagged | What it actually was |
|---|---|
| #296, #298 | Unstarted work whose parent closed. Not nearly-done. |
| #400's children | Parked by design. Deliberately open. |

## Ledger

| # | Date | Item | State | Resolution (with rejected options) |
|---|------|------|-------|------------------------------------|
| 1 | 2026-08-01 | Storage backend | resolved | postgres on CT 210; sqlite rejected (single-writer). |
| 2 | 2026-08-12 | Index refresh cadence | open | Surfaces at first ingest dispatch. |
