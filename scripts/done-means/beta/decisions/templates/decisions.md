# <Program> — decisions ledger (graph-mode v1.3-beta)

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
| 1 | 2026-08-27 | Ledger doctor runtime | RATIFIED | Doctor parses in a single Node 24 type-stripped `.ts` under `lib/`, driven by a bash-3.2 wrapper. | bun (dying runtime, ledger 13); pure awk (nine-column parsing plus conflict grouping is unreadable in awk); a npm-installed parser (no deps allowed in done-means checks). | A cc-* box ships a node older than 24, or native type stripping is removed from the pinned runtime. |  | scripts/done-means/ledger-columns.sh |
