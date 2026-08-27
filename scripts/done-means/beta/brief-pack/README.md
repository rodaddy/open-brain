# brief-pack

Status: WRITTEN 2026-08-27. Not merged, not running.

Assembles a **bounded** lane brief from the inputs a dispatch already has: the
task, the lane contract, the lane's done-means check, and optionally a decision
ledger and a loop policy. The point is the ContextPack discipline —
**ranked inclusion, explicit exclusion, fail-closed budget.** Over budget it
refuses and writes nothing; it never truncates a section to fit, because a
silently shortened brief looks identical to a complete one.

## Usage

```
pack.sh --task <file|-> --lane-contract <path> --done-means <path>
        [--decisions <path>] [--loop-policy <path>]
        [--budget-tokens N]   (default 8000)
        [--max-tightenings N] (default 8)
        [--max-decisions N]   (default 5)
        [--controller-contract <path>]
            (default: controller-contract.md beside the lane contract,
             else the repo _DOCS/controller-contract.md)
        [--report-heading <exact heading text>]
        [--out <path>]
```

`--task -` reads the task from stdin. Output goes to stdout, and additionally to
`--out` when given and only when under budget.

## Exit grammar

| exit | meaning |
| --- | --- |
| `0` | under budget; brief on stdout (and `--out`) |
| `1` | OVER BUDGET — report and per-section token table on stderr, **nothing written to `--out`** |
| `3` | harness error — required input missing/unreadable, empty task, no node 24 binary, the lane contract has no `## Tightenings` section, no controller contract could be resolved, or the controller contract has no report-format heading (the last two print `ABSENT`) |

Exit 0 having examined nothing is not possible for the INPUTS: an empty
`--task` is exit 3, and so is a `## Tightenings` section with content but no
recognised entries. It IS possible for the OUTPUT: a contract whose
Tightenings section is genuinely empty packs a brief listing `(none)` at
exit 0, because an empty ratchet is a real state rather than a parse
failure. The known-limits entry below is the authority on which is which.

## Token estimate

Tokens are estimated as **`ceil(chars/4)`** everywhere in this tool — the budget
check, the header line, and the per-section table. No tokenizer dependency; the
estimator is declared rather than remembered.

## Output sections, in order

1. `# Lane brief` + `budget: <used>/<N> tokens (ceil chars/4) | report-format: <heading>`
   — the heading names which section of the controller contract was used, so a
   brief carries proof of which spelling it matched
2. `## Task` — verbatim task text
3. `## Done-means` — path, the exact `bash <path>` invocation, and the check's
   leading comment block (contiguous `#` lines after the shebang) verbatim
4. `## Standing rules` — pointer to the contract path, then its `## Ground rules`
   section verbatim
5. `## Tightenings (ranked)` — top `--max-tightenings`, each verbatim
6. `## Decisions (ranked)` — only with `--decisions`; `RATIFIED` rows only
7. `## Loop policy` — only with `--loop-policy`; verbatim
8. `## Report format` — the report-format block from the controller contract
   (see *Report-format discovery* below)
9. `## Excluded (available on request)` — **every** Tightening and RATIFIED
   decision that did not make the cut, one per line as `- <date> <first 80 chars>`

## Report-format discovery

Repos spell this section differently — Development uses `## Lane report schema`,
open-brain uses `## Required lane report format` — so the heading is **found,
not assumed**: the first level-2 heading whose text matches `/report/i` wins.
Both spellings match. The chosen heading is printed on the budget line.

If no level-2 heading matches, pack exits `3` with
`ABSENT: no level-2 heading matching /report/i in <path>`. Override with
`--report-heading '## Exact Heading'` (a leading `## ` is added if omitted),
which bypasses the search entirely and is the escape hatch for a contract whose
section does not contain the word "report".

## Resolving the controller contract

With no `--controller-contract`, candidates are tried in order:

1. `controller-contract.md` in the **same directory as `--lane-contract`** —
   the repo-shaped case; open-brain keeps both in `docs/`
2. `_DOCS/controller-contract.md` relative to this tool — the Development layout

First readable one wins. If neither exists, exit `3` naming both paths. An
explicit `--controller-contract` skips the search and is an error if unreadable.

## Ranking

Task text and entry text are lowercased and split on non-alphanumerics; words
shorter than 4 characters and a small stopword list are dropped. Score = number
of **distinct** shared words. Ties break newer-date-first, then original order.
Decisions rank on `Item + Resolution`.

## Inputs

- **Lane contract** — markdown. Needs `## Tightenings` (else exit 3) and
  ideally `## Ground rules`. Its directory is also the first place a
  controller contract is looked for. Tightening entries are `- **YYYY-MM-DD` bullets
  plus their continuation lines.
- **Done-means** — any bash script; only the shebang-following comment block is read.
- **Decisions** — a nine-column markdown table
  (`# | Date | Item | State | Resolution | Rejected | Falsifier | Supersedes | Retires`).
  Non-`RATIFIED` rows are ignored entirely and never appear in `Excluded`.

## Runtime

`pack.sh` is `#!/usr/bin/env bash`, bash-3.2 clean, `set -u`. It resolves node in
order: `$NODE_BIN`, `/opt/homebrew/opt/node@24/bin/node`, `command -v node`;
exit 3 if none. Logic is a single dependency-free `lib/brief-pack.ts` run
directly by Node 24 native type stripping — no enum, no namespace, no
decorators, no parameter properties, no `package.json`.

## How to run RED

```
# over budget, proves no --out file is created
pack.sh --task fixtures/task.txt --lane-contract fixtures/lane-contract.fixture.md \
        --done-means fixtures/done-means.fixture.sh --budget-tokens 300 --out fixtures/x.md

# harness error: required input missing
pack.sh --task fixtures/task.txt --lane-contract fixtures/lane-contract.fixture.md

# harness error: contract without a Tightenings section
pack.sh --task fixtures/task.txt --lane-contract fixtures/no-tightenings.fixture.md \
        --done-means fixtures/done-means.fixture.sh

# harness error: controller contract with no /report/i heading
pack.sh --task fixtures/task.txt --lane-contract fixtures/lane-contract.fixture.md \
        --done-means fixtures/done-means.fixture.sh \
        --controller-contract fixtures/ctrl-no-report.fixture.md

# harness error: unknown flag, by name (a typo used to be ignored at exit 0)
pack.sh --task fixtures/task.txt --lane-contract fixtures/lane-contract.fixture.md \
        --done-means fixtures/done-means.fixture.sh --budget-token 800

# harness error: a cap of 0 used to pack "(none)" at exit 0
pack.sh --task fixtures/task.txt --lane-contract fixtures/lane-contract.fixture.md \
        --done-means fixtures/done-means.fixture.sh --max-tightenings 0

# harness error: a negative cap used to drop exactly one entry, silently
pack.sh --task fixtures/task.txt --lane-contract fixtures/lane-contract.fixture.md \
        --done-means fixtures/done-means.fixture.sh --max-tightenings -1

# pass: --max-decisions 0 stays legal, a brief with no Decisions is a real shape
pack.sh --task fixtures/task.txt --lane-contract fixtures/lane-contract.fixture.md \
        --done-means fixtures/done-means.fixture.sh --max-decisions 0

# pass: the open-brain spelling "## Required lane report format"
pack.sh --task fixtures/task.txt --lane-contract fixtures/lane-contract.fixture.md \
        --done-means fixtures/done-means.fixture.sh \
        --controller-contract fixtures/ctrl-required-format.fixture.md

# pass: no flag, controller contract found beside the lane contract
pack.sh --task fixtures/task.txt \
        --lane-contract fixtures/derived-dir/lane-contract.md \
        --done-means fixtures/done-means.fixture.sh

# pass: heading-shaped Tightenings (### YYYY-MM-DD blocks) are ranked, not (none)
pack.sh --task fixtures/task.txt \
        --lane-contract fixtures/lane-contract-heading.fixture.md \
        --done-means fixtures/done-means.fixture.sh
```

Transcripts in `RED.md`.

## Known limits

- An unrecognised flag is exit 3, by name. It used to be stored under its own
  wrong key and never read, so a typo shipped a brief built entirely from
  defaults at exit 0 — worst on `--budget-token`, where the operator believes
  they capped the brief and did not (RED.md case 18).
- `--max-tightenings` must be >= 1 and `--max-decisions` >= 0; a non-integer or
  out-of-range value is exit 3. `--max-tightenings 0` used to pack `(none)` at
  exit 0, and `-1` was quieter still, because `slice(0, -1)` drops one element
  rather than erroring, so the brief shipped 11 of 12 entries and read as a pass
  (RED.md case 18). `--max-decisions 0` remains legal: a brief with no Decisions
  section is a real shape.
- A `## Tightenings` section with content but ZERO recognised entries is exit 3,
  not a brief listing `(none)`. Before that guard a contract whose rules used
  neither supported shape packed a brief with no standing rules at exit 0
  (RED.md case 17). A genuinely empty section still packs at exit 0.
- Tightenings entries open on `- **YYYY-MM-DD` OR `### YYYY-MM-DD`; a heading
  block with everything under it is one entry, the unit ratchet-bound counts.
  Whether a heading-shaped round should instead rank per rule bullet is an
  open pilot decision (RED.md case 15).
- The header's own token count is resolved by two passes; if the digit count of
  `used` changes between them the reported number can be off by one token. The
  budget comparison uses the second-pass value.
- Section parsing is heading-literal: `## Tightenings` must match exactly, and a
  section ends at the next line beginning `## `. Only the report-format heading
  is discovered rather than fixed.
- `/report/i` takes the FIRST match. A contract with an unrelated earlier
  heading containing "report" (e.g. `## Reporting cadence`) picks the wrong
  section; `--report-heading` is the override.
- Ranking is bag-of-words with no stemming; "entrypoint" and "entrypoints" do
  not match each other.
- Markdown tables are split on `|` — a `|` inside a cell will misparse the row.
- The tool reads inputs and writes only `--out`. It does not validate that the
  done-means script is executable or that it runs.
