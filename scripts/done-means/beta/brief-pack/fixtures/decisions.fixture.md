# Decision ledger — fixture

| # | Date | Item | State | Resolution | Rejected | Falsifier | Supersedes | Retires |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| #1 | 2026-08-24 | Shell dialect | RATIFIED | All entrypoints are bash-3.2 clean; no bash-4 syntax. | bash 4 baseline | A cc-* box fails to parse an entrypoint | - | - |
| #2 | 2026-08-23 | Node runtime | RATIFIED | Node 24 keg absolute path for system-invoked entrypoints. | bare node on PATH | A launchd job resolves a stale node | - | #0 |
| #3 | 2026-08-22 | Token estimator | RATIFIED | Token budgets use ceil(chars/4), stated in the README. | tiktoken dependency | A README omits the estimator | - | - |
| #4 | 2026-08-21 | Budget behaviour | RATIFIED | Over budget refuses and writes nothing; never truncate. | truncate-to-fit | An output file exists after an over-budget run | - | - |
| #5 | 2026-08-20 | Board fields | RATIFIED | Status field is set at merge, not at dispatch. | set at dispatch | An item sits Done with an open PR | - | - |
| #6 | 2026-08-19 | Deletes | RATIFIED | Agents move to _archive; removal is Rico's own hand. | scoped rm carve-out | An agent runs a recursive delete | - | - |
| #7 | 2026-08-18 | Colour palette | PROPOSED | Use the neutral placeholder palette. | - | - | - | - |
