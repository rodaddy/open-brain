# open-brain — decisions ledger (graph-mode v1.3-beta)

Forward ledger. Rulings from 2026-08-27 onward go here. The legacy ledger is
the `## Ledger` table in `docs/issue-graph.md`; it stays as history and is not
migrated. `docs/decisions/` holds long-form rationale records and is unchanged
by this file.

Validate with:
`/opt/homebrew/bin/bash /Volumes/ThunderBolt/Development/_ob/skills/graph-mode/beta/decisions/check.sh docs/decisions.md`

One row per decision. Columns, in order:

- **#** — row number, monotonic, never reused.
- **Date** — ISO date the decision reached its current State.
- **Item** — the thing decided, short and stable. Two live RATIFIED rows with
  the same Item are a conflict the doctor fails on.
- **State** — one of `OPEN`, `RATIFIED`, `HELD`, `REVERSED`, `SUPERSEDED`.
- **Resolution** — what was decided.
- **Rejected** — the options NOT taken, each with its reason. Required on RATIFIED.
- **Falsifier** — the evidence that would change our mind. Required on RATIFIED.
- **Supersedes** — a prior row number, or empty.
- **Retires** — a mechanism this ruling retires: a path under
  `scripts/done-means/` or a named hook/rule. Empty when it retires nothing.

Rows are append-only; a reversal is a new row with Supersedes set.

| # | Date | Item | State | Resolution | Rejected | Falsifier | Supersedes | Retires |
|---|------|------|-------|------------|----------|-----------|------------|---------|
| 1 | 2026-08-27 | Graph Mode v1.3-beta opt-in | RATIFIED | pilot per Rico 2026-08-27 | wait for ratification (no receipts would ever exist) | pilot exit criteria in the amendment unmet after two runs |  |  |
| 2 | 2026-08-27 | Beta executables run from canon, not a vendored copy | RATIFIED | run from /Volumes/ThunderBolt/Development/_ob/skills/graph-mode/beta/ (Rico 2026-08-27) | byte-faithful copy with PROVENANCE.md (needed a hand resync per canon fix) | a canon fix that an opted-in repo cannot pick up without a repo change |  |  |
