# Fixture — clause 6 satisfied by an exact Retires path present in the repo diff

The Retires value names THIS FIXTURE DIRECTORY'S own sibling, so the evidence
clause 6 looks for is the fixture set itself. Clause 6 reads the HOST repo's
dirty set, which makes any other choice repo-dependent: this fixture used to
retire `_ob/skills/graph-mode/workflows/setup.md` and passed only in the
Development clone, where that file happened to be dirty. Copied into the
open-brain and software-factory pilots it failed against an unchanged checker
(2026-08-27) — exactly the uncomparable receipt the pilot exists to prevent.

A newly added fixture directory is dirty in every repo that receives it, so the
passing case now reproduces anywhere with no mutation. The other satisfying
shape (any changed path under `scripts/done-means/`) is documented in README.md;
producing it requires touching a done-means file, which this lane does not do.

| # | Date | Item | State | Resolution | Rejected | Falsifier | Supersedes | Retires |
|---|------|------|-------|------------|----------|-----------|------------|---------|
| 1 | 2026-08-27 | Retire the clause-6 failing fixture once clause 6 ships | RATIFIED | The RED transcript in RED.md preserves the failing case. | keep it forever (a fixture nothing runs rots); delete the transcript too (loses the RED evidence). | Clause 6 regresses and the failing fixture is the only thing that would have caught it. |  | decisions/fixtures/fail-clause6-retire.md |
