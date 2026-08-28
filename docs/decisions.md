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
| 3 | 2026-08-27 | brief-pack default rounds for #878 conversion briefs | OPEN | pack.sh refused every session-9 conversion brief at the default eight Tightenings rounds (10855 tokens against 8000); the head used --max-tightenings 2 for conversions and 4 for #916 and recorded it on #878 as a deviation. Rico rules: ratify the knob at 2, or graduate more rounds so the default fits. |  |  |  |  |
| 4 | 2026-08-27 | lane-report/check.sh flags CI as a state word | OPEN | the 026 phase-2 report (#933) failed claim-states on the token CI in a verified line; the report was accepted with the false positive recorded in scripts/done-means/beta-receipts.md; rebase-lane reports use a RESULTS block and fail trailing-content by design of the git lane script. Rico rules: canon fix to the checker word list, and whether rebase lanes adopt the five-field format. |  |  |  |  |
| 5 | 2026-08-27 | backup drill runs on every isolated run | OPEN | #878 removed the OPENBRAIN_BACKUP_DRILL toggle from scripts/__tests__/backup-restore-live.test.ts (pull request #944 (pushed, not merged)): the pg_dump/pg_restore drill now runs in every bun run test:isolated and every pre-push, 8 tests in about 5 seconds, and requires pg_dump/pg_restore on PATH (a missing client tool fails loudly instead of skipping). Rico rules: keep it always-on, or restore a separate drill toggle that is not a database variable. |  |  |  |  |
| 6 | 2026-08-28 | ratchet-bound is red at live=16: which round graduates | OPEN | Round 41 (session 11 harvest) took docs/lane-contract.md to sixteen live Tightenings rounds against the default rule value of 15; ratchet-bound/check.sh exits 1 (beta-receipts session-11 row 2, head-corrected). The oldest live rounds are 27, 28, 29 (2026-08-09/10). Rico rules: graduate round 27 (its four bullets already have SME entries per the graduation convention at docs/lane-contract.md:757-983), or raise the rule value with --bound, or leave the ratchet red as a standing signal. |  |  |  |  |
