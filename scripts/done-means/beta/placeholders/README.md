# placeholders — unresolved-scaffold check

Status: WRITTEN 2026-08-27 (graph-mode beta lane). Not merged, not running.

## What it proves

A Graph Mode artifact that still carries an unresolved scaffold placeholder is
NOT done. This check makes "I scaffolded it" a **failing** state rather than an
empty passing one: a run's `README.md`, `decisions.md`, or `lane-contract.md`
that was copied from a template and never filled in exits `1`, naming every
slot still holding template text.

The check is for **INSTANTIATED artifacts**. A TEMPLATE is *expected to fail*
this check — that is the template doing its job, and it is why `--allow` exists
(below) rather than a blanket template exemption.

## Usage

```bash
./check.sh [--allow <literal>]... <file>...
```

Every hit prints as `<path>:<line>: <token>`, one per line, to stdout. A
summary line goes to stderr. The check exits `1` if there is at least one hit.

`--allow <literal>` may be repeated. It exempts one exact token for that run,
so a file that legitimately *documents* the token list can be checked without
tripping on its own contents:

```bash
./check.sh --allow '<slug>' --allow '<repo>' docs/template-guide.md
```

For mustache, `--allow '{{...}}'` exempts every `{{...}}` match; `--allow
'{{name}}'` exempts only that one.

## Exit grammar

| exit | meaning |
| --- | --- |
| `0` | files were examined and no placeholder was found |
| `1` | at least one unresolved placeholder |
| `3` | harness error — nothing was examined |

Exit `0` having examined nothing is not a pass. No file arguments is exit `3`
with `HARNESS ERROR: no files to examine`; a listed file that does not exist is
exit `3` naming that file, checked before any file is read, so a typo cannot
silently shrink the examined set. A missing `awk` is also exit `3`.

## Placeholder tokens

Kept in `check.sh`. Case-sensitive substring match unless noted:

`REPLACE_` (prefix) · `<scope>` · `<slug>` · `<repo>` · `<owner>` ·
`<lane-name>` · `<YYYY-MM-DD>` · `<date>` ·
`TODO-FILL` · `FILL ME` · `FILLME` · any `{{...}}` mustache

`TBD` and `XXX` are matched **whole-word** and case-sensitively, so
`SUBTBDWORD` and `MAXXXIMUM` do not hit. Every other token is a plain
case-sensitive substring. `<path>` and `<lane>` were dropped on 2026-08-27:
the open-brain pilot showed both are ordinary notation in standing contracts
(`Done-means: <path>`, `_archive/<lane>/`), so they flagged prose that is
instantiated. Pass them with `--allow` inverted, i.e. add them back per run
with a local wrapper, if a repo scaffolds with them.

## Fenced code blocks are NOT exempt

A placeholder inside a ``` fence is still unresolved. A command a reader is
meant to paste that reads `./check.sh <repo>` has not been instantiated; the
reader cannot run it. The check makes no attempt to track fence state.

## Inputs

Plain text/Markdown files given as arguments. Directories are not walked —
pass files, e.g. via `fd -e md . docs -x ./check.sh`. Paths containing
whitespace are not supported (the file list is newline-split with globbing
disabled; a literal newline in a filename would break it).

## How to run RED

```bash
./check.sh fixtures/fail-scaffold-README.md   # exit 1, four hits
./check.sh fixtures/fail-mustache-only.md     # exit 1, one hit
./check.sh fixtures/pass-instantiated-README.md  # exit 0
./check.sh                                    # exit 3, no files
./check.sh fixtures/does-not-exist.md         # exit 3, missing file
```

Real transcripts with actual output are in `RED.md`.

## Known limits

- Substring matching has no notion of context: a token quoted in prose to
  *discuss* it counts as a hit. That is deliberate (a template must fail), and
  `--allow` is the escape hatch for the documenting file.
- Filenames containing spaces or newlines are unsupported (see Inputs).
- The token list is fixed in the script; there is no `--deny` to extend it at
  runtime. Adding a token is a script edit.
- Binary files are not detected or skipped.

## Estimating tokens

Anywhere this lane estimates token counts, the formula is `ceil(chars / 4)`.

## Runtime

`#!/usr/bin/env bash`, `set -u`, bash-3.2 clean (no associative arrays, no
`mapfile`, no `${var,,}`, no `[[ =~ ]]`) because this repo is also checked out
on the cc-* Linux boxes. Pure bash + `awk`; no TypeScript, no dependencies.
