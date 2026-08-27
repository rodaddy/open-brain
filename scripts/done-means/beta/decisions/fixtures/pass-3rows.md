# Fixture — passing ledger (3 rows, one SUPERSEDED chain, no Retires)

| # | Date | Item | State | Resolution | Rejected | Falsifier | Supersedes | Retires |
|---|------|------|-------|------------|----------|-----------|------------|---------|
| 1 | 2026-08-01 | Storage backend | SUPERSEDED | sqlite on the local disk. | postgres (no operator); files (no queries). | A second writer appears. |  |  |
| 2 | 2026-08-10 | Storage backend | RATIFIED | postgres on CT 210. | sqlite (single-writer, row 1); duckdb (no concurrent writes). | Write volume stays under 1/day for a quarter. | 1 |  |
| 3 | 2026-08-12 | Index refresh cadence | OPEN | Surfaces at first ingest dispatch. |  |  |  |  |
