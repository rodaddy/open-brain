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

## 2026-08-27 adversarial review — prose satisfied `verified:`, and `:` was a value

Two false greens, both exit 0 on reports that assert nothing.

**Clause 5 accepted a sentence.** It required only that the text after `->`
CONTAIN `exit <digits>` and that something precede the arrow, so an entirely
fictional line passed:

```
$ ./check.sh fixtures/fail-clause5-prose-exit.txt
lane report valid: 5 fields, all clauses passed
exit: 0
```

The offending value is `verified:      I thought about it -> the docs say a
good run should exit 0 someday`. The result must now OPEN with the exit code
(`/^\s*exit\s+[0-9]+/`). This remains SHAPE only — the README's standing limit
that the clause cannot know a command ran is unchanged — but a sentence is no
longer a receipt.

**Clause 2 counted punctuation as content.** `nonEmpty` was `trim() !== ""`,
so a bare `:` filled a field:

```
$ ./check.sh fixtures/fail-clause2-colon-value.txt
lane report valid: 5 fields, all clauses passed
exit: 0
```

deliverable, deviations and lessons were each `:`. A value now needs at least
one alphanumeric character. Both fixtures exit 1.

Regression: all eight pre-existing fixtures hold (3/1/1/1/1/1/1/0). CRLF input
was already handled and is now pinned by `fixtures/pass-crlf.txt` (exit 0).
Checked against the two REAL pilot lane reports on disk, both still exit 0, so
the tightening does not reject legitimate lane output.

## 2026-08-27 adversarial review — three more, one a repaired fix that still leaked

**F4, the morning fix was incomplete.** Requiring the result to OPEN with the
exit code stopped the original prose case but not this one:

```
verified:      I thought about it -> exit 0 someday, i never ran it
exit: 0
```

It opens with `exit 0` and then admits it never ran. What may follow the code
is a short factual tail; a hedging clause now fails the line.

**F5, title case slipped the banned-word scan.** The scan matched all-caps runs
only, so `claim-states: a: WRITTEN, feature is Done and Deployed` passed while
`DONE` failed. Title-case completion words are now rejected by name, pointing
at the four-state grammar.

**F6, indented content rode along after the report.** Clause 3 exempted
indented lines as continuations, so a three-space-indented narrative paragraph
after `lessons: none` was absorbed silently. Anything after the lessons value
is trailing content now, indented or not.

Eleven fixtures hold. Both REAL pilot lane reports still exit 0, so the three
tightenings do not reject legitimate lane output.
