# Decisions ledger — format and doctor (graph-mode v1.3-beta)

Status: WRITTEN 2026-08-27. Not merged, not running.

## What it proves

That a program's decisions ledger is judgeable rather than decorative: it has
the v1.3-beta nine-column schema, every RATIFIED row carries its rejected
options and the evidence that would overturn it, no two live RATIFIED rows
contradict each other on the same Item, every Supersedes points at a real row,
every State is in the enum, and a ruling that claims to retire a mechanism is
accompanied by an actual change to the checks.

## Files

- `templates/decisions.md` — the ledger format, one fully-filled example row.
- `check.sh` — the doctor (bash-3.2 wrapper: arg parsing, node resolution, git evidence).
- `lib/decisions-doctor.ts` — the parser and all seven clauses. Single file, no
  dependencies, run directly by Node 24 native type stripping.
- `fixtures/` — one passing ledger, one failing ledger per clause, one no-table file.
- `RED.md` — the real transcript of every run below.

## Usage

    ./check.sh <decisions.md> [--repo <path>] [--diff-base <ref>]

`--repo` defaults to the git root containing the ledger (`git rev-parse
--show-toplevel`). `--diff-base` defaults to `origin/main`. Git is only
consulted when at least one row has a non-empty `Retires`; a ledger with no
`Retires` values needs no repo and no ref.

Node is resolved in this order, exit 3 if none: `$NODE_BIN` if set and
executable, then `/opt/homebrew/opt/node@24/bin/node`, then `node` on `PATH`.

## Exit grammar

| exit | meaning |
| --- | --- |
| 0 | pass |
| 1 | a clause failed — one `FAIL <clause> row <#>: <detail>` line per failure |
| 3 | harness error — could not look. Never a pass. |

Exit 0 having examined nothing is not a pass: a file with no markdown table, or
a table with a valid header and zero data rows, exits 3.

## Clauses

1. `schema` — the header must be exactly `# | Date | Item | State | Resolution |
   Rejected | Falsifier | Supersedes | Retires`. A mismatch fails alone, exit 1,
   with a message naming the migration need (an old 5-column ledger does not
   crash the doctor — see RED.md, `mcp-cutover/decisions.md`).
2. `conflict` — two or more RATIFIED rows with the same Item (trimmed,
   case-insensitive) where none is referenced by another row's `Supersedes`.
3. `falsifier` — RATIFIED with an empty Falsifier.
4. `rejected` — RATIFIED with an empty Rejected.
5. `supersedes` — a Supersedes referencing a row number that does not exist.
6. `retire-without-check` — a row with non-empty Retires must find, among
   `git -C <repo> diff --name-only <diff-base>...HEAD` plus `git -C <repo>
   status --porcelain` paths, at least one path under `scripts/done-means/` or
   the exact path named in Retires. Git missing, ledger outside a repo, or an
   unresolvable ref is `HARNESS ERROR` and exit 3 — never a pass.
7. `state` — State outside `OPEN, RATIFIED, HELD, REVERSED, SUPERSEDED`.

Clauses 2-7 accumulate: one run reports every failure it found, then a count.
Clause 1 short-circuits, because the column positions the other clauses read
are exactly what it says are wrong.

## How to run RED

From this directory, against the checked-in fixtures:

    ./check.sh fixtures/fail-clause2-conflict.md      # exit 1
    ./check.sh fixtures/fail-clause3-falsifier.md     # exit 1
    ./check.sh fixtures/fail-clause4-rejected.md      # exit 1
    ./check.sh fixtures/fail-clause5-supersedes.md    # exit 1
    ./check.sh fixtures/fail-clause6-retire.md        # exit 1
    ./check.sh fixtures/fail-clause7-state.md         # exit 1
    ./check.sh fixtures/pass-3rows.md                 # exit 0
    ./check.sh fixtures/pass-clause6-retire.md        # exit 0
    ./check.sh fixtures/harness-empty.md              # exit 3
    ./check.sh                                        # exit 3

## Clause 6 fixtures, and how the passing case is produced

`fail-clause6-retire.md` retires `scripts/done-means/ledger-columns.sh` and is
checked against this clone, where no path under `scripts/done-means/` has
changed against `origin/main` — so it fails. This lane deliberately does not
modify `scripts/done-means/`.

`pass-clause6-retire.md` takes the other satisfying shape: its Retires names an
exact path that this clone currently reports as changed. That makes the passing
case reproducible with no mutation.

To exercise the `scripts/done-means/` shape instead, do it in a scratch COPY,
never in this clone:

    cp -R <this clone> {temp_workspace}/development/_scratch/ledger-clause6
    cd {temp_workspace}/development/_scratch/ledger-clause6
    printf '# touched\n' >> scripts/done-means/exemplar-battery.sh
    _ob/skills/graph-mode/beta/decisions/check.sh \
      _ob/skills/graph-mode/beta/decisions/fixtures/fail-clause6-retire.md

The dirty `scripts/done-means/` path then satisfies the clause and the same
fixture exits 0. Not run in this lane: the lane may not commit, and the
scratch-copy path needed a `git init` plus a commit to give `--diff-base`
something to resolve. The clone-dirty variant above is what was actually run.

## Estimating tokens

Anywhere this skill estimates token counts, the estimate is
`ceil(chars / 4)`. It is an estimate, not a tokenizer.

## Known limits

- The doctor reads the FIRST markdown table in the file. A ledger with a second
  table below it is not examined.
- Row numbers are taken from column 1 as written. A duplicated row number makes
  `Supersedes` resolution ambiguous; the doctor accepts the first match and
  does not flag the duplicate.
- Clause 2 compares Item strings only. Two rows that contradict each other
  under different Item wordings are invisible to it.
- Dirty paths come from `git status --porcelain --untracked-files=all`, so
  a file inside an untracked directory is listed by its own path. Plain
  `--porcelain` collapses the directory and would hide an exact `Retires`
  match (caught in the lane's own RED run, 2026-08-27).
- Cell contents may not contain a literal `|`, even escaped — the splitter is
  positional.
