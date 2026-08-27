# Fixture — clause 6 satisfied by an exact Retires path present in the repo diff

The Retires value names a path that `git status --porcelain` reports as changed
in the beta clone, so the ruling has evidence and the row passes. The other
satisfying shape (any changed path under `scripts/done-means/`) is documented in
README.md; producing it requires touching a done-means file, which this lane
does not do.

| # | Date | Item | State | Resolution | Rejected | Falsifier | Supersedes | Retires |
|---|------|------|-------|------------|----------|-----------|------------|---------|
| 1 | 2026-08-27 | Retire the v1.2 graph-mode setup workflow | RATIFIED | The v1.3-beta setup workflow replaces it. | keep both (two setup paths drift); delete without a replacement (leaves setup unowned). | The v1.3-beta setup workflow fails on a real repo conversion. |  | _ob/skills/graph-mode/workflows/setup.md |
