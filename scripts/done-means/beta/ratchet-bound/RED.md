# RED transcript — ratchet-bound

Captured 2026-08-27 on macOS (Darwin 27.0.0), zsh, from this directory.
Real output, copied verbatim. Failing fixtures first.

## `./check.sh fixtures/fail-16-live.md`

```
bound source: comment (bound=15)
FAIL bound: 16 live > 15
live=16 graduated=0 bound=15 source=comment
exit=1
```

## `./check.sh fixtures/fail-missing-provenance.md`

```
FAIL provenance: - **2026-08-02 — Someone forgot to cite where this came fr
bound source: comment (bound=15)
live=2 graduated=0 bound=15 source=comment
exit=1
```

## `./check.sh fixtures/fail-no-section.md`

```
ABSENT: ## Tightenings in fixtures/fail-no-section.md
exit=1
```

## `./check.sh fixtures/pass-3-live.md --bound 2` — `--bound` forces RED on a passing file

```
bound source: arg (bound=2)
FAIL bound: 3 live > 2
live=3 graduated=0 bound=2 source=arg
exit=1
```

## Passing fixtures

### `./check.sh fixtures/pass-3-live.md`

```
bound source: comment (bound=15)
live=3 graduated=0 bound=15 source=comment
exit=0
```

### `./check.sh fixtures/pass-16-graduated.md`

```
bound source: comment (bound=15)
live=12 graduated=4 bound=15 source=comment
exit=0
```

### `./check.sh fixtures/pass-empty.md`

```
bound source: comment (bound=15)
live=0 graduated=0 bound=15 source=comment
exit=0
```

## Exit 3 — harness errors

### `./check.sh` (no argument)

```
HARNESS: usage: check.sh <lane-contract.md> [--bound N]
exit=3
```

### `./check.sh fixtures/nope.md` (unreadable file)

```
HARNESS: unreadable file: fixtures/nope.md
exit=3
```

### `./check.sh fixtures/pass-3-live.md --bound abc` (non-integer bound)

```
HARNESS: --bound must be a non-negative integer, got 'abc'
exit=3
```

## Against the REAL file (read-only; not edited)

`_DOCS/lane-contract.md` on branch `feat/graph-mode-v1.3-beta` carries one
Tightenings entry, and it has provenance. The repo passes its own ratchet today.

```
$ ./check.sh /Volumes/ThunderBolt/_tmp/development/_scratch/graph-mode-beta/_DOCS/lane-contract.md
bound source: comment (bound=15)
live=1 graduated=0 bound=15 source=comment
exit=0
```

## 2026-08-27 pilot fix

The open-brain pilot found the check recognized only `- **YYYY-MM-DD` bullets.
`open-brain/docs/lane-contract.md` carries its entries as `### YYYY-MM-DD
(round N)` headings, so the check saw nothing and exited 0. Captured on macOS
(Darwin 27.0.0), zsh, from this directory.

### The defect, before the fix

`./check.sh /Volumes/ThunderBolt/Development/open-brain/docs/lane-contract.md`

```
bound source: default (bound=15)
live=0 graduated=0 bound=15 source=default
exit=0
```

A pass over a section holding 39 entries and 1310 content lines. Exit 0 having
examined nothing — the failure mode the exit grammar exists to prevent.

### New fixture — `./check.sh fixtures/fail-heading-16-live.md`

```
bound source: comment (bound=15)
FAIL bound: 16 live > 15
live=16 graduated=0 bound=15 source=comment shape=heading
exit=1
```

### New fixture — `./check.sh fixtures/fail-unknown-shape.md` (vacuous-green guard)

```
HARNESS: 0 entries recognized in a non-empty ## Tightenings section (6 content lines); unknown entry shape
exit=3
```

### New fixture — `./check.sh fixtures/pass-heading-3-live.md --bound 2` — forces RED

```
bound source: arg (bound=2)
FAIL bound: 3 live > 2
live=3 graduated=0 bound=2 source=arg shape=heading
exit=1
```

### New passing fixtures

`./check.sh fixtures/pass-heading-3-live.md`

```
bound source: comment (bound=15)
live=3 graduated=0 bound=15 source=comment shape=heading
exit=0
```

`./check.sh fixtures/pass-mixed.md`

```
bound source: comment (bound=15)
live=3 graduated=1 bound=15 source=comment shape=mixed
exit=0
```

### Pre-existing fixtures, unchanged behavior

Same exits and same counts as the transcripts above; every summary line gained
the new `shape=` field and nothing else.

```
fixtures/fail-16-live.md            -> exit 1  live=16 graduated=0 ... shape=bullet
fixtures/fail-missing-provenance.md -> exit 1  live=2  graduated=0 ... shape=bullet
fixtures/fail-no-section.md         -> exit 1  ABSENT: ## Tightenings
fixtures/pass-16-graduated.md       -> exit 0  live=12 graduated=4 ... shape=bullet
fixtures/pass-3-live.md             -> exit 0  live=3  graduated=0 ... shape=bullet
fixtures/pass-empty.md              -> exit 0  live=0  graduated=0 ... shape=none
```

`pass-empty.md` still passes at `live=0`: its section holds only blank lines and
an HTML comment, so the vacuous-green guard correctly does not fire. An empty
ratchet is still a ratchet.

### Against the REAL open-brain file, after the fix

`open-brain/docs/lane-contract.md`, read-only, not edited. Run from this
directory:

```
$ ./check.sh /Volumes/ThunderBolt/Development/open-brain/docs/lane-contract.md
FAIL provenance: ### 2026-08-18 (round 32) — harvest of the live-observer c
FAIL provenance: ### 2026-08-17 (round 31) — harvest of the #724 wave (PRs
FAIL provenance: ### 2026-08-10 (round 30) — harvest of the #716 issue-arti
FAIL provenance: ### 2026-08-10 (round 29) — harvest of the #709 hook-feeds
FAIL provenance: ### 2026-08-10 (round 29) — harvest of the #712 pre-push W
FAIL provenance: ### 2026-08-09 (round 28) — harvest of the #705/#706 gate-
... 33 more FAIL provenance lines, 39 in total ...
bound source: default (bound=15)
FAIL bound: 39 live > 15
live=39 graduated=0 bound=15 source=default shape=heading
exit=1
```

Reported as observed, not corrected. Three facts for the pilot to rule on:

1. **39 live against a bound of 15.** The graduation valve has never run.
2. **All 39 entries lack `provenance:`.** The entries cite PR and issue numbers
   in their prose ("harvest of the #724 wave", "PR #737") but never with the
   literal `provenance:` key the check requires. This is a real disagreement
   between the check's grammar and the file's convention, and it is the pilot's
   call which one moves — not this lane's.
3. **`source=default`.** The section states its own bound in prose ("Bounded at
   15 live entries" is absent; the section opens with "Newest first"), so the
   check fell back to the built-in 15 rather than reading a declared valve.

## 2026-08-27 adversarial review — CRLF blinded the check entirely

A review lane's fixture `a1-crlf-16-live.md` is a valid lane contract with a
`## Tightenings` section and 16 live entries, saved with CRLF line endings.
Every anchored awk match failed against the trailing `\r`, so the section was
never entered and the check reported the section MISSING:

```
$ ./check.sh fixtures/fail-crlf-16-live.md
ABSENT: ## Tightenings in fixtures/fail-crlf-16-live.md
exit: 1
```

That is worse than an undercount. It is exit 1 for the wrong reason, and the
same input on a repo whose contract had no bound problem would have read as a
missing-section failure nobody could explain. `sub(/\r$/, "", line)` at the
awk entry point fixes it; every clause reads `line`, so one strip covers all.

```
$ ./check.sh fixtures/fail-crlf-16-live.md
FAIL bound: 16 live > 15
live=16 graduated=0 bound=15 source=default shape=bullet
exit: 1
```

Now failing on the real reason. All ten pre-existing fixtures hold their exit
codes (1/1/1/1/3/0/0/0/0/0). Kept as `fixtures/fail-crlf-16-live.md`.

## 2026-08-27 adversarial review — a fenced example bought bound headroom

The worst class: exit 0 on a contract that is over its bound.

An entry body accumulated every line, fenced ones included, and `flush_entry`
then searched that whole text for `graduated:`. So an entry that DOCUMENTS how
to graduate, inside a code fence, reclassified itself as graduated and freed a
slot under the bound:

```
$ ./check.sh fixtures/fail-16-live.md   # with one entry carrying a fenced example
live=15 graduated=1 bound=15 source=default shape=bullet
exit: 0
```

Sixteen real live entries, reported as fifteen, passing a bound of fifteen.
Fenced lines are now excluded from entry text entirely (they still count as
content for the vacuous-green guard, which is about the section, not the
classification):

```
live=16 graduated=0 bound=15 source=default shape=bullet
FAIL bound: 16 live > 15
exit: 1
```

## 2026-08-27 adversarial review — a multi-line comment tripped the guard

README rule 7 says a section of only blank lines and comments passes. Only the
opening `<!--` and closing `-->` lines were excluded from the content count, so
the BODY of a multi-line comment counted and the vacuous-green guard fired on a
section that was legitimately empty:

```
$ ./check.sh fixtures/pass-empty.md   # variant carrying a 3-line comment
HARNESS: 0 entries recognized in a non-empty ## Tightenings section (1 content lines)
exit: 3
```

Comment state is now tracked across lines. Both forms pass at exit 0, and the
guard still fires on real content in an unrecognised shape (exit 3).

Regression after both fixes: eleven fixtures hold (1/1/1/1/1/3/0/0/0/0/0). Both
REAL pilot contracts report unchanged counts — 45 live heading-shaped, and 10
live bullet-shaped.
