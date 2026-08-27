# ratchet-bound

Status: WRITTEN 2026-08-27. Not merged, not running.

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
path both exit 3. A `## Tightenings` section that exists and is empty IS a pass
(an empty ratchet is a ratchet) and prints `live=0`.

## Rules enforced

1. **Section located** from `## Tightenings` to the next line starting `## ` or
   EOF. Absent: prints `ABSENT: ## Tightenings in <path>` and exits 1.
2. **Bound source**, in precedence order: `--bound N`, else a
   `Bounded at N live entries` phrase inside the section (matched across a line
   wrap), else `15`. Always printed as `bound source: <arg|comment|default>`.
3. **Entry** = a top-level bullet whose line starts `- **` followed by a
   `YYYY-MM-DD` date. An entry's text is its bullet line plus every following
   line until the next entry or the end of the section.
4. **Graduated** = entry text contains `graduated:`. Graduated entries do not
   count against the bound; everything else is live.
5. **Provenance** = entry text contains `provenance:`, required on live and
   graduated entries alike. Each miss prints
   `FAIL provenance: <first 60 chars of the entry>`.
6. **Bound** — `live > bound` prints `FAIL bound: <live> live > <bound>`.
   A one-line summary `live=<n> graduated=<n> bound=<n> source=<...>` prints on
   every run, pass or fail.

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

## How to run RED

The failing fixtures ARE the RED run; `RED.md` is the captured transcript,
recorded before the README was written. To reproduce:

```
./check.sh fixtures/fail-16-live.md;            echo "exit=$?"
./check.sh fixtures/fail-missing-provenance.md; echo "exit=$?"
./check.sh fixtures/fail-no-section.md;         echo "exit=$?"
./check.sh fixtures/pass-3-live.md --bound 2;   echo "exit=$?"   # --bound forces RED
./check.sh;                                     echo "exit=$?"   # 3
```

## Known limits

- Markdown-shape, not semantics. It cannot tell a real provenance reference
  from the literal string `provenance:` in prose, nor verify that a
  `graduated:` entry's named done-means check exists.
- Only top-level `- **YYYY-MM-DD` bullets count. An entry indented under
  another bullet, or one that omits the bold-date opener, is invisible to the
  count — an undercount, so it fails open on the bound.
- A `## Tightenings` heading with trailing text on the same line is not matched.
- First-60-chars truncation in the provenance message is by BYTE, so a line
  with multibyte em-dashes shows slightly fewer than 60 visible characters.
- The bound phrase is read from anywhere in the section body, including a
  quoted example. Pass `--bound` when that matters.
- Token estimates anywhere in this lane use `ceil(chars / 4)`.
