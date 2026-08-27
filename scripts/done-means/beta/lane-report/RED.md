# RED transcript — lane-report validator

Real output, copied verbatim. Run from this directory on 2026-08-27,
macOS, `/opt/homebrew/opt/node@24/bin/node`.

Every failing fixture was run and its nonzero exit captured before the
README was written. Exit shown is `$?` of `./check.sh`.

## Clause 1 — field-set

```
$ ./check.sh fixtures/fail-clause1-missing-field.txt
FAIL field-set: expected [deliverable, claim-states, verified, deviations, lessons] in order, found [deliverable, claim-states, verified, deviations]
lane report invalid: 1 failure(s)
--- exit 1
```

Reordered fields, same clause:

```
$ ./check.sh .probe2.txt      # claim-states before deliverable
FAIL field-set: expected [deliverable, claim-states, verified, deviations, lessons] in order, found [claim-states, deliverable, verified, deviations, lessons]
lane report invalid: 1 failure(s)
--- exit 1
```

## Clause 2 — empty-value

```
$ ./check.sh fixtures/fail-clause2-empty-value.txt
FAIL empty-value: deliverable: empty value at line 1
lane report invalid: 1 failure(s)
--- exit 1
```

## Clause 3 — trailing-content

```
$ ./check.sh fixtures/fail-clause3-trailing-content.txt
FAIL trailing-content: line 7: PS: also I want to add that the work went great and here is a summary.
lane report invalid: 1 failure(s)
--- exit 1
```

## Clause 4 — claim-states

```
$ ./check.sh fixtures/fail-clause4-bad-state.txt
FAIL claim-states: no "<artifact>: <STATE>" pair with STATE in {RUNNING MERGED WRITTEN PROPOSED}
FAIL claim-states: disallowed state word(s): DONE
lane report invalid: 2 failure(s)
--- exit 1
```

Two failures here is correct: `thing.sh: DONE` has no valid pair AND
carries a banned word. A report with a valid pair plus one stray banned
word isolates to the second failure only:

```
$ ./check.sh .probe.txt       # "a.sh: WRITTEN, b.sh: DEPLOYED"
FAIL claim-states: disallowed state word(s): DEPLOYED
lane report invalid: 1 failure(s)
--- exit 1
```

## Clause 5 — verified

```
$ ./check.sh fixtures/fail-clause5-no-exit.txt
FAIL verified: no "<cmd> -> <result>" line whose result contains "exit <digits>"
lane report invalid: 1 failure(s)
--- exit 1
```

## Clause 6 — none-or-text

```
$ ./check.sh fixtures/fail-clause6-blank-deviations.txt
FAIL empty-value: deviations: empty value at line 4
FAIL none-or-text: deviations: must be "none" or free text, found whitespace only
lane report invalid: 2 failure(s)
--- exit 1
```

A whitespace-only value trips clause 2 and clause 6 together by
construction; clause 6 is the one that names the `none`-or-text rule.

## Passing fixture — exit 0

```
$ ./check.sh fixtures/pass.txt
lane report valid: 5 fields, all clauses passed
--- exit 0
```

## Harness errors — exit 3

Zero bytes:

```
$ ./check.sh fixtures/empty.txt
HARNESS: report file is zero bytes: fixtures/empty.txt
--- exit 3
```

No argument:

```
$ ./check.sh
HARNESS: usage: check.sh <report-file>
--- exit 3
```

Unreadable / absent file:

```
$ ./check.sh fixtures/nope.txt
HARNESS: cannot read report file: .../fixtures/nope.txt
--- exit 3
```

## Note on the first run

The first RED attempt returned `126 permission denied` for every fixture:
the file was created without the exec bit. `chmod +x check.sh` fixed it and
the run above is the corrected one. Recorded because a 126 is neither a
pass nor one of the three legal exits — it is the harness not running at all.
