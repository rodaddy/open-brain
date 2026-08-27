# ratchet-bound

Status: WRITTEN 2026-08-27. Not merged, not running. Amended 2026-08-27 by the
open-brain pilot fix (both entry shapes, vacuous-green guard).

## What it proves

`_DOCS/lane-contract.md` declares a graduation valve in the HTML comment of its
`## Tightenings` section — "Bounded at 15 live entries: overflow graduates into
a done-means check or a GOTCHAS.md entry" — and nothing enforced it. This check
does: it counts live vs graduated ratchet entries, holds the live count at or
under the declared bound, and requires provenance on every entry.

Pure `bash` + `awk`. No TypeScript, no Node, no dependencies. `#!/usr/bin/env
bash`, `set -u`, bash-3.2 clean (no associative arrays, no `mapfile`, no
`${var,,}`, no `[[ =~ ]]`) so it runs on the cc-* Linux boxes as well as macOS.

## Usage

```
./check.sh <lane-contract.md> [--bound N]
```

## Exit grammar

| exit | meaning |
| --- | --- |
| `0` | pass |
| `1` | the thing under test failed — missing section, missing provenance, or live count over bound |
| `3` | harness error — no argument, unreadable file, non-integer `--bound` |

Exit 0 having examined nothing is not a pass: no argument and an unreadable
path both exit 3, and so does a section with content in it that yields zero
recognized entries. A `## Tightenings` section that exists and is genuinely
empty IS a pass (an empty ratchet is a ratchet) and prints `live=0`.

## Rules enforced

1. **Section located** from `## Tightenings` to the next line starting `## ` or
   EOF. Absent: prints `ABSENT: ## Tightenings in <path>` and exits 1.
2. **Bound source**, in precedence order: `--bound N`, else a
   `Bounded at N live entries` phrase inside the section (matched across a line
   wrap), else `15`. Always printed as `bound source: <arg|comment|default>`.
3. **Entry** = either of two shapes, both recognized in the same file:
   - a top-level bullet whose line starts `- **` followed by a `YYYY-MM-DD`
     date, or
   - a level-3 heading `### YYYY-MM-DD`, with any free text after the date
     (`### 2026-08-18 (round 32) — harvest of ...`).

   An entry's body runs from its opening line to the next entry **of either
   shape** or the end of the section; `graduated:` and `provenance:` are
   searched across that whole body. Nested bullets inside a heading entry are
   body, not entries — they do not open with a date. The summary line reports
   which shape(s) were found as `shape=bullet|heading|mixed|none`.
4. **Graduated** = entry text contains `graduated:`. Graduated entries do not
   count against the bound; everything else is live.
5. **Provenance** = entry text contains `provenance:`, required on live and
   graduated entries alike. Each miss prints
   `FAIL provenance: <first 60 chars of the entry>`.
6. **Bound** — `live > bound` prints `FAIL bound: <live> live > <bound>`.
   A one-line summary
   `live=<n> graduated=<n> bound=<n> source=<...> shape=<...>` prints on every
   run, pass or fail.
7. **Vacuous-green guard** — if the section holds at least one content line (any
   non-blank line that is not an HTML comment and not the heading itself) and
   ZERO entries were recognized, the check prints
   `HARNESS: 0 entries recognized in a non-empty ## Tightenings section (<n> content lines); unknown entry shape`
   and exits 3. This is a harness error, not a policy failure: the check cannot
   see the entries, so it cannot say whether the bound holds. A section of only
   blank lines and comments still passes with `live=0`.

## Inputs

`fixtures/` — one file per clause:

| fixture | expected |
| --- | --- |
| `pass-3-live.md` | 0 — three live entries under the comment bound |
| `pass-16-graduated.md` | 0 — 16 entries, 4 carrying `graduated:`, 12 live |
| `pass-empty.md` | 0 — section present, zero entries, prints `live=0` |
| `fail-16-live.md` | 1 — 16 live at the default/comment bound of 15 |
| `fail-missing-provenance.md` | 1 — one entry with no `provenance:` |
| `fail-no-section.md` | 1 — no `## Tightenings` heading at all |
| `pass-heading-3-live.md` | 0 — heading shape, three live entries with provenance |
| `pass-mixed.md` | 0 — both shapes in one section, under bound, one graduated |
| `fail-heading-16-live.md` | 1 — heading shape, 16 live over the bound |
| `fail-unknown-shape.md` | 3 — prose section, no recognizable entry, vacuous-green guard |

## How to run RED

The failing fixtures ARE the RED run; `RED.md` is the captured transcript,
recorded before the README was written. To reproduce:

```
./check.sh fixtures/fail-16-live.md;            echo "exit=$?"
./check.sh fixtures/fail-missing-provenance.md; echo "exit=$?"
./check.sh fixtures/fail-no-section.md;         echo "exit=$?"
./check.sh fixtures/fail-heading-16-live.md;    echo "exit=$?"
./check.sh fixtures/fail-unknown-shape.md;      echo "exit=$?"   # 3, vacuous green
./check.sh fixtures/pass-3-live.md --bound 2;   echo "exit=$?"   # --bound forces RED
./check.sh;                                     echo "exit=$?"   # 3
```

## Known limits

- Fenced lines never contribute to an entry body, so a fenced example
  containing `graduated:` or `provenance:` cannot change an entry's
  classification. It previously bought a free slot under the bound (RED.md,
  2026-08-27). Fence markers still count as section content for the
  vacuous-green guard.
- HTML comment state is tracked across lines, so a multi-line comment does not
  count as content. A section of only blank lines and comments passes.
- CRLF input is handled: the awk strips a trailing `\r` before every match.
  Before that fix a CRLF contract reported its `## Tightenings` section
  ABSENT (RED.md, 2026-08-27).
- Markdown-shape, not semantics. It cannot tell a real provenance reference
  from the literal string `provenance:` in prose, nor verify that a
  `graduated:` entry's named done-means check exists.
- Only the two documented shapes count. An entry indented under another bullet,
  a `####` heading, or one that omits the date opener is invisible to the count.
  That is still an undercount on the bound, but it is no longer a silent one:
  when it drives the recognized count to zero in a section that has content, the
  vacuous-green guard turns the miss into exit 3 instead of a false pass.
- A `### YYYY-MM-DD` heading is treated as an entry wherever it appears in the
  section, so a nested example or a quoted transcript carrying that shape would
  be counted. Level-2 `## ` headings still end the section regardless of shape.
- A `## Tightenings` heading with trailing text on the same line is not matched,
  and that still yields `ABSENT` + exit 1 rather than the guard.
- First-60-chars truncation in the provenance message is by BYTE, so a line
  with multibyte em-dashes shows slightly fewer than 60 visible characters.
- The bound phrase is read from anywhere in the section body, including a
  quoted example. Pass `--bound` when that matters.
- Token estimates anywhere in this lane use `ceil(chars / 4)`.
