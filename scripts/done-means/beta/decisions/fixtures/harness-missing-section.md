# Fixture — used with --section pointing at a heading that does not exist (exit 3)

Shape copied from the real `open-brain/docs/issue-graph.md`, which is what the
2026-08-27 pilot fix was cut for: the doctor used to judge the FIRST table in
the file and report a schema failure against prose, while the ledger sat
further down under its own heading.

## What the old signal got wrong

| Flagged | What it actually was |
|---|---|
| #296, #298 | Unstarted work whose parent closed. Not nearly-done. |
| #400's children | Parked by design. Deliberately open. |

## Ledger

| # | Date | Item | State | Resolution | Rejected | Falsifier | Supersedes | Retires |
|---|------|------|-------|------------|----------|-----------|------------|---------|
| 1 | 2026-08-01 | Storage backend | SUPERSEDED | sqlite on the local disk. | postgres (no operator); files (no queries). | A second writer appears. |  |  |
| 2 | 2026-08-10 | Storage backend | RATIFIED | postgres on CT 210. | sqlite (single-writer, row 1); duckdb (no concurrent writes). | Write volume stays under 1/day for a quarter. | 1 |  |
| 3 | 2026-08-12 | Index refresh cadence | OPEN | Surfaces at first ingest dispatch. |  |  |  |  |

## After the ledger

| Skill | What this adopts |
|---|---|
| `wayfinder` | The map/child model and the frontier query. |
