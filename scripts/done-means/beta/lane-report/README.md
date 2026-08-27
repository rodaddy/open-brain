# lane-report — validator for the five-field lane report

Status: WRITTEN 2026-08-27. Not merged, not wired into any hook.

## What it proves

That a lane's final report conforms to the schema in
`_DOCS/controller-contract.md` (`## Lane report schema`) — the five fields,
in order, each non-empty, nothing after `lessons:`, and the three
value-shape rules that make the report evidence rather than prose.

It judges the TEXT of a report. It does not verify that the claims inside
are true: a report asserting `WRITTEN` for a file that does not exist
passes. Truth of the claims is the controller's job, per lane-contract
rule 3.

## Usage

```
./check.sh <report-file>
```

## Exit grammar

| exit | meaning |
| --- | --- |
| `0` | report conforms |
| `1` | report violates one or more clauses; each printed as `FAIL <clause>: <detail>` |
| `3` | harness error — no argument, unreadable file, zero bytes, `lib/` missing, or no usable node |

Exit 0 having examined nothing is not possible: a zero-byte file is exit 3.

## Failure clauses

One line per violation, `FAIL <clause>: <detail>`. A single fixture can
trip more than one clause; that is by design, not double-reporting.

| clause | rule |
| --- | --- |
| `field-set` | exactly `deliverable:`, `claim-states:`, `verified:`, `deviations:`, `lessons:` — at line start, in that order. Missing, extra, or reordered fails. |
| `empty-value` | every value non-empty. Indented continuation lines belong to the preceding key. |
| `trailing-content` | nothing after the `lessons:` value except blank lines. |
| `claim-states` | at least one `<artifact>: <STATE>` pair, STATE in {RUNNING, MERGED, WRITTEN, PROPOSED}. Any other all-caps word in that field (DONE, VERIFIED, COMPLETE, FIXED, DEPLOYED) fails. |
| `verified` | at least one `<cmd> -> <result>` line whose result contains `exit <digits>`. |
| `none-or-text` | `deviations:` and `lessons:` are `none` or free text; whitespace-only fails. |

## Inputs

`fixtures/` holds one passing report, one failing fixture per clause 1–6,
and `empty.txt` (zero bytes) for the exit-3 path.

## How to run RED

```
for f in fixtures/fail-*.txt; do ./check.sh "$f"; echo "exit $?"; done
./check.sh fixtures/pass.txt;  echo "exit $?"   # 0
./check.sh fixtures/empty.txt; echo "exit $?"   # 3
./check.sh;                    echo "exit $?"   # 3
```

Captured transcript with real output: `RED.md`.

## Runtime

`check.sh` is `#!/usr/bin/env bash`, bash-3.2 clean, `set -u`. Parsing is
`lib/lane-report.ts`, run directly by Node 24 native type stripping — no
build step, no dependencies, no `package.json`. The wrapper resolves node
as `${NODE_BIN:-}`, then `/opt/homebrew/opt/node@24/bin/node`, then
`command -v node`, and exits 3 if none is usable.

Token estimates anywhere in this lane use `ceil(chars / 4)`.

## Known limits

- Text conformance only; claim truth is not checked (see above).
- The banned-word scan for `claim-states` matches any all-caps run of two
  or more letters, so a legitimate all-caps token in that field (an acronym
  like `API` or `CI`) reads as a disallowed state word. The field is meant
  to hold `<artifact>: <STATE>` pairs, so this is a deliberate false
  positive rather than a miss — but it is the clause most likely to need
  loosening against real reports.
- Continuation lines are detected by leading whitespace only. A wrapped
  value flush against column 0 is read as a new key if it happens to start
  with a known key name and a colon, and as trailing content after
  `lessons:` otherwise.
- Key detection is exact-match on the five names, so a typo
  (`deliverables:`) surfaces as a missing field rather than a misspelled
  one.
- The `verified` clause checks shape, not that the command was ever run.
