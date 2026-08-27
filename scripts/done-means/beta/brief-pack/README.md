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
        [--controller-contract <path>]  (default: repo _DOCS/controller-contract.md)
        [--out <path>]
```

`--task -` reads the task from stdin. Output goes to stdout, and additionally to
`--out` when given and only when under budget.

## Exit grammar

| exit | meaning |
| --- | --- |
| `0` | under budget; brief on stdout (and `--out`) |
| `1` | OVER BUDGET — report and per-section token table on stderr, **nothing written to `--out`** |
| `3` | harness error — required input missing/unreadable, empty task, no node 24 binary, or the lane contract has no `## Tightenings` section (prints `ABSENT`) |

Exit 0 having examined nothing is not possible: an empty `--task` is exit 3.

## Token estimate

Tokens are estimated as **`ceil(chars/4)`** everywhere in this tool — the budget
check, the header line, and the per-section table. No tokenizer dependency; the
estimator is declared rather than remembered.

## Output sections, in order

1. `# Lane brief` + `budget: <used>/<N> tokens (ceil chars/4)`
2. `## Task` — verbatim task text
3. `## Done-means` — path, the exact `bash <path>` invocation, and the check's
   leading comment block (contiguous `#` lines after the shebang) verbatim
4. `## Standing rules` — pointer to the contract path, then its `## Ground rules`
   section verbatim
5. `## Tightenings (ranked)` — top `--max-tightenings`, each verbatim
6. `## Decisions (ranked)` — only with `--decisions`; `RATIFIED` rows only
7. `## Loop policy` — only with `--loop-policy`; verbatim
8. `## Report format` — the `## Lane report schema` block from the controller contract
9. `## Excluded (available on request)` — **every** Tightening and RATIFIED
   decision that did not make the cut, one per line as `- <date> <first 80 chars>`

## Ranking

Task text and entry text are lowercased and split on non-alphanumerics; words
shorter than 4 characters and a small stopword list are dropped. Score = number
of **distinct** shared words. Ties break newer-date-first, then original order.
Decisions rank on `Item + Resolution`.

## Inputs

- **Lane contract** — markdown. Needs `## Tightenings` (else exit 3) and
  ideally `## Ground rules`. Tightening entries are `- **YYYY-MM-DD` bullets
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
```

Transcripts in `RED.md`.

## Known limits

- The header's own token count is resolved by two passes; if the digit count of
  `used` changes between them the reported number can be off by one token. The
  budget comparison uses the second-pass value.
- Section parsing is heading-literal: `## Tightenings` must match exactly, and a
  section ends at the next line beginning `## `.
- Ranking is bag-of-words with no stemming; "entrypoint" and "entrypoints" do
  not match each other.
- Markdown tables are split on `|` — a `|` inside a cell will misparse the row.
- The tool reads inputs and writes only `--out`. It does not validate that the
  done-means script is executable or that it runs.
