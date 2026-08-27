# Fixture — clause 6: a Retires value with no done-means change in the repo

Checked against the clone at
/Volumes/ThunderBolt/_tmp/development/_scratch/graph-mode-beta, where no path
under scripts/done-means/ changed against origin/main.

| # | Date | Item | State | Resolution | Rejected | Falsifier | Supersedes | Retires |
|---|------|------|-------|------------|----------|-----------|------------|---------|
| 1 | 2026-08-27 | Retire the column-count check | RATIFIED | The nine-column doctor subsumes it. | keep both (double maintenance). | The doctor stops parsing a real ledger. |  | scripts/done-means/ledger-columns.sh |
