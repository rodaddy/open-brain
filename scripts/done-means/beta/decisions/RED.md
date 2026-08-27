# RED — real transcript

Captured 2026-08-27 in the clone at /Volumes/ThunderBolt/_tmp/development/_scratch/graph-mode-beta,
branch feat/graph-mode-v1.3-beta, cwd = this directory. Output copied verbatim.

```
$ ./check.sh fixtures/fail-clause2-conflict.md
FAIL conflict row 1,2: 2 live RATIFIED rows share Item "Storage backend" and none is superseded
ledger fixtures/fail-clause2-conflict.md: 1 failure(s) across 2 rows
exit=1
```

```
$ ./check.sh fixtures/fail-clause3-falsifier.md
FAIL falsifier row 1: RATIFIED row "Queue runtime" has an empty Falsifier
ledger fixtures/fail-clause3-falsifier.md: 1 failure(s) across 1 rows
exit=1
```

```
$ ./check.sh fixtures/fail-clause4-rejected.md
FAIL rejected row 1: RATIFIED row "Queue runtime" has an empty Rejected
ledger fixtures/fail-clause4-rejected.md: 1 failure(s) across 1 rows
exit=1
```

```
$ ./check.sh fixtures/fail-clause5-supersedes.md
FAIL supersedes row 1: references row 7, which does not exist
ledger fixtures/fail-clause5-supersedes.md: 1 failure(s) across 1 rows
exit=1
```

```
$ ./check.sh fixtures/fail-clause6-retire.md
FAIL retire-without-check row 1: Retires="scripts/done-means/ledger-columns.sh" but no changed path is under scripts/done-means/ nor equal to that path (23 changed paths examined)
ledger fixtures/fail-clause6-retire.md: 1 failure(s) across 1 rows
exit=1
```

```
$ ./check.sh fixtures/fail-clause7-state.md
FAIL state row 1: "DECIDED" is not one of OPEN, RATIFIED, HELD, REVERSED, SUPERSEDED
ledger fixtures/fail-clause7-state.md: 1 failure(s) across 1 rows
exit=1
```

```
$ ./check.sh fixtures/pass-3rows.md
ok: fixtures/pass-3rows.md — 3 rows, 0 failures
exit=0
```

```
$ ./check.sh fixtures/pass-clause6-retire.md
ok: fixtures/pass-clause6-retire.md — 1 rows, 0 failures
exit=0
```

```
$ ./check.sh fixtures/harness-empty.md
HARNESS ERROR: no markdown table found in fixtures/harness-empty.md
exit=3
```

```
$ ./check.sh
HARNESS ERROR: no ledger path given
exit=3
```

```
$ ./check.sh fixtures/nope.md
HARNESS ERROR: ledger unreadable: fixtures/nope.md
exit=3
```

```
$ ./check.sh fixtures/fail-clause6-retire.md --diff-base origin/nonexistent
HARNESS ERROR: diff base does not resolve in /Volumes/ThunderBolt/_tmp/Development/_scratch/graph-mode-beta: origin/nonexistent
exit=3
```

## The real 5-column ledger (clause 1, no crash)

```
$ ./check.sh ../../../../../mcp-cutover/decisions.md
FAIL schema row 6: header is [# | Date | Item | State | Resolution (with rejected options)] but v1.3-beta requires the nine columns [# | Date | Item | State | Resolution | Rejected | Falsifier | Supersedes | Retires]; this ledger needs MIGRATION to the v1.3-beta 9-column format before the doctor can judge it
exit=1
```

## 2026-08-27 pilot fix

Open-brain pilot receipt 9 found the doctor judging the FIRST markdown table in
`open-brain/docs/issue-graph.md` — the "Flagged | What it actually was" prose
table at line 52 — and reporting a schema failure against it, while the real
ledger sits at line 279 under `## Ledger`. Table selection is now ordered
(`--section`, then a `#` first header cell, then first-in-file), the selected
table is printed as the first output line, and the schema failure names the
table it judged.

Same clone, same branch, cwd = this directory. Output copied verbatim.

### Every pre-existing fixture, re-run — verdicts and messages unchanged

Only the new `table:` line is added, and the clause-1 message now names the
table. Exit codes are identical to the transcript above.

```
$ ./check.sh fixtures/fail-clause2-conflict.md
table: line 3 via hash-column
FAIL conflict row 1,2: 2 live RATIFIED rows share Item "Storage backend" and none is superseded
ledger fixtures/fail-clause2-conflict.md: 1 failure(s) across 2 rows
exit=1
```

```
$ ./check.sh fixtures/fail-clause3-falsifier.md
table: line 3 via hash-column
FAIL falsifier row 1: RATIFIED row "Queue runtime" has an empty Falsifier
ledger fixtures/fail-clause3-falsifier.md: 1 failure(s) across 1 rows
exit=1
```

```
$ ./check.sh fixtures/fail-clause4-rejected.md
table: line 3 via hash-column
FAIL rejected row 1: RATIFIED row "Queue runtime" has an empty Rejected
ledger fixtures/fail-clause4-rejected.md: 1 failure(s) across 1 rows
exit=1
```

```
$ ./check.sh fixtures/fail-clause5-supersedes.md
table: line 3 via hash-column
FAIL supersedes row 1: references row 7, which does not exist
ledger fixtures/fail-clause5-supersedes.md: 1 failure(s) across 1 rows
exit=1
```

```
$ ./check.sh fixtures/fail-clause6-retire.md
table: line 7 via hash-column
FAIL retire-without-check row 1: Retires="scripts/done-means/ledger-columns.sh" but no changed path is under scripts/done-means/ nor equal to that path (100 changed paths examined)
ledger fixtures/fail-clause6-retire.md: 1 failure(s) across 1 rows
exit=1
```

The changed-path count moved from 23 to 100 because this lane added files to the
clone. The clause verdict is what the fixture pins, and it is unchanged.

```
$ ./check.sh fixtures/fail-clause7-state.md
table: line 3 via hash-column
FAIL state row 1: "DECIDED" is not one of OPEN, RATIFIED, HELD, REVERSED, SUPERSEDED
ledger fixtures/fail-clause7-state.md: 1 failure(s) across 1 rows
exit=1
```

```
$ ./check.sh fixtures/pass-3rows.md
table: line 3 via hash-column
ok: fixtures/pass-3rows.md — 3 rows, 0 failures
exit=0
```

```
$ ./check.sh fixtures/pass-clause6-retire.md
table: line 9 via hash-column
ok: fixtures/pass-clause6-retire.md — 1 rows, 0 failures
exit=0
```

```
$ ./check.sh fixtures/harness-empty.md
HARNESS ERROR: no markdown table found in fixtures/harness-empty.md
exit=3
```

```
$ ./check.sh
HARNESS ERROR: no ledger path given
exit=3
```

```
$ ./check.sh fixtures/nope.md
HARNESS ERROR: ledger unreadable: fixtures/nope.md
exit=3
```

```
$ ./check.sh fixtures/fail-clause6-retire.md --diff-base origin/nonexistent
HARNESS ERROR: diff base does not resolve in /Volumes/ThunderBolt/_tmp/Development/_scratch/graph-mode-beta: origin/nonexistent
exit=3
```

```
$ ./check.sh ../../../../../mcp-cutover/decisions.md
table: line 6 via hash-column
FAIL schema row 6: judged the table at line 6 (selected via hash-column) with header [# | Date | Item | State | Resolution (with rejected options)] but v1.3-beta requires the nine columns [# | Date | Item | State | Resolution | Rejected | Falsifier | Supersedes | Retires]; this ledger needs MIGRATION to the v1.3-beta 9-column format before the doctor can judge it
exit=1
```

### New fixtures — the pilot shape

A non-ledger table first, a nine-column ledger under `## Ledger`. Selected by
the `#` first-cell rule at line 17, skipping the prose table at line 9:

```
$ ./check.sh fixtures/pass-section-second-table.md
table: line 17 via hash-column
ok: fixtures/pass-section-second-table.md — 3 rows, 0 failures
exit=0
```

```
$ ./check.sh fixtures/pass-section-second-table.md --section '## Ledger'
table: line 17 via section
ok: fixtures/pass-section-second-table.md — 3 rows, 0 failures
exit=0
```

Both rules land on the same table. Note the third table further down (`Skill |
What this adopts`) is not reached by either.

The same file with the ledger in the OLD five-column shape. The schema failure
names line 14 — the LEDGER table — not line 9, the prose table above it:

```
$ ./check.sh fixtures/fail-section-old-shape.md
table: line 14 via hash-column
FAIL schema row 14: judged the table at line 14 (selected via hash-column) with header [# | Date | Item | State | Resolution (with rejected options)] but v1.3-beta requires the nine columns [# | Date | Item | State | Resolution | Rejected | Falsifier | Supersedes | Retires]; this ledger needs MIGRATION to the v1.3-beta 9-column format before the doctor can judge it
exit=1
```

```
$ ./check.sh fixtures/fail-section-old-shape.md --section '## Ledger'
table: line 14 via section
FAIL schema row 14: judged the table at line 14 (selected via section) with header [# | Date | Item | State | Resolution (with rejected options)] but v1.3-beta requires the nine columns [# | Date | Item | State | Resolution | Rejected | Falsifier | Supersedes | Retires]; this ledger needs MIGRATION to the v1.3-beta 9-column format before the doctor can judge it
exit=1
```

`--section` naming a heading the file does not contain is a harness error, never
a pass:

```
$ ./check.sh fixtures/harness-missing-section.md --section '## Decisions'
HARNESS ERROR: no heading ## Decisions
exit=3
```

### The real pilot file

`/Volumes/ThunderBolt/Development/open-brain/docs/issue-graph.md`, read-only.
Before this fix the doctor selected the prose table at line 52 and reported the
schema failure against it. It now selects line 279 under `## Ledger` by either
rule:

```
$ ./check.sh /Volumes/ThunderBolt/Development/open-brain/docs/issue-graph.md
table: line 279 via hash-column
FAIL schema row 279: judged the table at line 279 (selected via hash-column) with header [# | Item | State | Resolution] but v1.3-beta requires the nine columns [# | Date | Item | State | Resolution | Rejected | Falsifier | Supersedes | Retires]; this ledger needs MIGRATION to the v1.3-beta 9-column format before the doctor can judge it
exit=1
```

```
$ ./check.sh /Volumes/ThunderBolt/Development/open-brain/docs/issue-graph.md --section '## Ledger'
table: line 279 via section
FAIL schema row 279: judged the table at line 279 (selected via section) with header [# | Item | State | Resolution] but v1.3-beta requires the nine columns [# | Date | Item | State | Resolution | Rejected | Falsifier | Supersedes | Retires]; this ledger needs MIGRATION to the v1.3-beta 9-column format before the doctor can judge it
exit=1
```

Both still exit 1, and that is the CORRECT verdict now rather than an accident:
the real ledger is a four-column `# | Item | State | Resolution` table and does
need migration. What changed is that the doctor is reporting on the ledger
instead of on a prose table, so the message is actionable and the line number
points at the thing to fix. The old output was a true-shaped statement about the
wrong object — which is exactly the failure mode that makes a check untrusted.
