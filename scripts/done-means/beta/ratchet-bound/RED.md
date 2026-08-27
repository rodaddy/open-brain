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
