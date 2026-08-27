# Fixture — clause 2: two live RATIFIED rows on the same Item

| # | Date | Item | State | Resolution | Rejected | Falsifier | Supersedes | Retires |
|---|------|------|-------|------------|----------|-----------|------------|---------|
| 1 | 2026-08-01 | Storage backend | RATIFIED | sqlite on the local disk. | postgres (no operator). | A second writer appears. |  |  |
| 2 | 2026-08-10 | storage backend  | RATIFIED | postgres on CT 210. | sqlite (single-writer). | Write volume stays under 1/day. |  |  |
