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
