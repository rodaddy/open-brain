# RED.md — real transcripts

Status: WRITTEN 2026-08-27. Copied verbatim from the terminal; not paraphrased.
Run from `_ob/skills/graph-mode/beta/placeholders/`. `exit:` lines are the
real `$?` of the preceding command.

## 1. FAIL — scaffolded README, four different tokens

```
$ ./check.sh fixtures/fail-scaffold-README.md
fixtures/fail-scaffold-README.md:1: <slug>
fixtures/fail-scaffold-README.md:3: <YYYY-MM-DD>
fixtures/fail-scaffold-README.md:5: TODO-FILL
fixtures/fail-scaffold-README.md:10: <path>
FAIL: 4 unresolved placeholder hit(s)
exit: 1
```

## 2. FAIL — file with only a mustache

```
$ ./check.sh fixtures/fail-mustache-only.md
fixtures/fail-mustache-only.md:1: {{name}}
FAIL: 1 unresolved placeholder hit(s)
exit: 1
```

## 3. PASS — clean instantiated README

```
$ ./check.sh fixtures/pass-instantiated-README.md
PASS: no unresolved placeholders
exit: 0
```

## 4. HARNESS ERROR — no file arguments

```
$ ./check.sh
HARNESS ERROR: no files to examine
exit: 3
```

## 5. HARNESS ERROR — listed file does not exist

```
$ ./check.sh fixtures/does-not-exist.md
HARNESS ERROR: file does not exist: fixtures/does-not-exist.md
exit: 3
```

## 6. --allow exempts a token for that run

Two of the four hits from case 1 are exempted; the other two still fail.

```
$ ./check.sh --allow '<slug>' --allow '<path>' fixtures/fail-scaffold-README.md
fixtures/fail-scaffold-README.md:3: <YYYY-MM-DD>
fixtures/fail-scaffold-README.md:5: TODO-FILL
FAIL: 2 unresolved placeholder hit(s)
exit: 1
```

A file documenting the mustache form passes with the wildcard literal:

```
$ ./check.sh --allow '{{...}}' fixtures/fail-mustache-only.md
PASS: no unresolved placeholders
exit: 0
```

## 7. Multiple files — hits aggregate, one nonzero exit

```
$ ./check.sh fixtures/fail-scaffold-README.md fixtures/fail-mustache-only.md
fixtures/fail-scaffold-README.md:1: <slug>
fixtures/fail-scaffold-README.md:3: <YYYY-MM-DD>
fixtures/fail-scaffold-README.md:5: TODO-FILL
fixtures/fail-scaffold-README.md:10: <path>
fixtures/fail-mustache-only.md:1: {{name}}
FAIL: 5 unresolved placeholder hit(s)
exit: 1
```

## 8. Whole-word TBD / XXX (scratch fixture, since archived)

Input lines: `a TBD here` / `SUBTBDWORD should not hit` / `XXX alone` /
`MAXXXIMUM no hit` / `nothing to see`. Only the standalone words hit.

```
$ ./check.sh fixtures/wordcheck.tmp.md
fixtures/wordcheck.tmp.md:1: TBD
fixtures/wordcheck.tmp.md:3: XXX
FAIL: 2 unresolved placeholder hit(s)
exit: 1
```

## 2026-08-27 pilot fix

`<path>` and `<lane>` dropped from the default list after the pilot in the
first repo: all five hits on its 1396-line lane contract were notation in
prose (`Done-means: <path>`, `_archive/<lane>/`). Fixture line 10 now uses
`<repo>` so the count stays at four.

```
$ ./check.sh fixtures/fail-scaffold-README.md
fixtures/fail-scaffold-README.md:1: <slug>
fixtures/fail-scaffold-README.md:3: <YYYY-MM-DD>
fixtures/fail-scaffold-README.md:5: TODO-FILL
fixtures/fail-scaffold-README.md:10: <repo>
FAIL: 4 unresolved placeholder hit(s)
exit: 1
$ ./check.sh <pilot clone>/docs/lane-contract.md
PASS: no unresolved placeholders
exit: 0
```

## 2026-08-27 adversarial review — the token removal let a real scaffold through

The morning fix dropped the angle-bracket path and lane tokens from the
default list because all five hits on a 1396-line standing contract were prose
notation. The review found the cost: an INSTANTIATED run README that still
carries them now passes clean.

```
$ ./check.sh fixtures/fail-strict-run-readme.md
PASS: no unresolved placeholders
exit: 0
```

The fixture is a run README whose `Repo root:`, `Lane:` and `Done-means:`
fields hold the raw tokens where real values belong. That is exactly the
unresolved scaffold this check exists to catch.

Re-adding them to the default list would restore the false positives on
standing contracts, so the fix is a `--strict` flag that adds the two tokens
back for run artifacts:

```
$ ./check.sh --strict fixtures/fail-strict-run-readme.md
fixtures/fail-strict-run-readme.md:3: <path>
fixtures/fail-strict-run-readme.md:4: <lane>
fixtures/fail-strict-run-readme.md:5: <path>
FAIL: 3 unresolved placeholder hit(s)
exit: 1
```

Why it stays opt-in, shown against a real contract: the same flag on the first
pilot's lane contract exits 1 on prose notation, while the default exits 0.
Run artifacts get `--strict`; standing contracts do not.

Three pre-existing fixtures unchanged (1/1/0).
