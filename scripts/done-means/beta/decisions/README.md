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

    ./check.sh <decisions.md> [--repo <path>] [--diff-base <ref>] [--section <heading>]

`--section` names the exact heading line whose table is the ledger (see Table
selection below). `--repo` defaults to the git root containing the ledger (`git rev-parse
--show-toplevel`). `--diff-base` defaults to `origin/main`. Git is only
consulted when at least one row has a non-empty `Retires`; a ledger with no
`Retires` values needs no repo and no ref.

Node is resolved in this order, exit 3 if none: `$NODE_BIN` if set and
executable, then `/opt/homebrew/opt/node@24/bin/node`, then `node` on `PATH`.

## Table selection

A decisions ledger frequently is not the first table in its file — the real
`open-brain/docs/issue-graph.md` opens with a prose table at line 52 and keeps
its ledger at line 279 under `## Ledger`. The doctor picks a table in this
order:

1. `--section "<heading text>"` — the first table under that exact heading line,
   searching to the next heading of the same or higher level. If the file has no
   such heading, exit 3 `HARNESS ERROR: no heading <text>`; if the heading exists
   but holds no table, exit 3 as well. Never a silent fall-through to another
   table: an explicit target that misses is a harness error, not a pass.
2. Otherwise, the first table anywhere whose header row's first cell is `#`.
   Every v1.3-beta ledger has one, and prose tables essentially never do.
3. Otherwise, the first table in the file.

The first line of output is always which table was judged and how it was found:

    table: line <n> via <section|hash-column|first>

That line exists because the pilot failure was invisible: the doctor reported a
schema failure that was correct about the object it looked at and wrong about
the object that mattered, and nothing in the output said which one it had read.
The clause-1 message now also names the table's line and header for the same
reason.

## Exit grammar

| exit | meaning |
| --- | --- |
| 0 | pass |
| 1 | a clause failed — one `FAIL <clause> row <#>: <detail>` line per failure |
| 3 | harness error — could not look. Never a pass. |

`--section` naming a heading the file does not contain is exit 3, not exit 1:
the doctor was told where to look, could not, and has judged nothing.

Exit 0 having examined nothing is not a pass: a file with no markdown table, or
a table with a valid header and zero data rows, exits 3.

## Clauses

1. `schema` — the header must be exactly `# | Date | Item | State | Resolution |
   Rejected | Falsifier | Supersedes | Retires`. A mismatch fails alone, exit 1,
   with a message naming the migration need, INCLUDING the line number and
   header of the table it judged, so a wrong-table pick is visible in the
   failure itself (an old 5-column ledger does not crash the doctor — see
   RED.md, `mcp-cutover/decisions.md`).
2. `conflict` — two or more RATIFIED rows with the same Item (trimmed,
   case-insensitive) where none is referenced by another row's `Supersedes`.
3. `falsifier` — RATIFIED with an empty Falsifier.
4. `rejected` — RATIFIED with an empty Rejected.
5. `supersedes` — a Supersedes referencing a row number that does not exist,
   or referencing the row's OWN number. A self-reference is also excluded when
   building the superseded set, so it cannot exempt a row from clause 2 (that
   was a false green — see RED.md, 2026-08-27).
6. `retire-without-check` — a row with non-empty Retires must find, among
   `git -C <repo> diff --name-only <diff-base>...HEAD` plus `git -C <repo>
   status --porcelain` paths, either the exact path named in Retires or a path
   ending with that path's basename. It used to accept ANY path under
   `scripts/done-means/`, which let one unrelated touch launder every Retires
   row in the ledger (RED.md, 2026-08-27). Git missing, ledger outside a repo, or an
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

Table selection (2026-08-27 pilot fix):

    ./check.sh fixtures/pass-section-second-table.md                      # exit 0
    ./check.sh fixtures/pass-section-second-table.md --section '## Ledger' # exit 0
    ./check.sh fixtures/fail-section-old-shape.md                         # exit 1
    ./check.sh fixtures/fail-section-old-shape.md --section '## Ledger'    # exit 1
    ./check.sh fixtures/harness-missing-section.md --section '## Decisions' # exit 3

`pass-section-second-table.md` and `fail-section-old-shape.md` both put a prose
table ABOVE the ledger, reproducing the real `issue-graph.md` shape. The failing
one must name the LEDGER table's line (14), never the prose table's (9).

## Clause 6 fixtures, and how the passing case is produced

`fail-clause6-retire.md` retires `scripts/done-means/ledger-columns.sh` and is
checked against this clone, where no path under `scripts/done-means/` has
changed against `origin/main` — so it fails. This lane deliberately does not
modify `scripts/done-means/`.

`pass-clause6-retire.md` takes the other satisfying shape: its Retires names an
exact path the host repo reports as changed. That path is the fixture
directory's OWN sibling (`decisions/fixtures/fail-clause6-retire.md`), which
makes the passing case reproducible in any repo with no mutation.

It used to retire `_ob/skills/graph-mode/workflows/setup.md`, which is dirty
only in the Development clone. Copied byte-faithful into the open-brain and
software-factory pilots, that fixture failed against an unchanged checker
(2026-08-27). Clause 6 reads the HOST repo's dirty set, so a fixture that
retires anything outside its own directory is testing the repo it landed in,
not the clause.

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

- Tables inside fenced code blocks (``` or ~~~) are skipped by every selection
  path, INCLUDING the `--section` heading search, so neither a fenced table nor
  a fenced heading can win. Guarding only the table lookup left the heading
  hole (RED.md, 2026-08-27). A file that documents the format in an example is
  not graded as a ledger. A file whose ONLY table is fenced exits 3, not 0 (RED.md,
  2026-08-27).
- The doctor judges ONE table per run — the one named by the selection order
  above. A file with two `#`-first-cell tables has its second one unexamined;
  `--section` is the way to aim at it.
- `--section` matches the heading line EXACTLY after trimming, so `## Ledger`
  does not match `## Ledger (v2)`. This is deliberate: a fuzzy match that picks
  a neighbouring heading reintroduces the wrong-table failure it exists to fix.
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
