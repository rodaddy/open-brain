# RED transcript — brief-pack

Captured 2026-08-27 from
`_ob/skills/graph-mode/beta/brief-pack` in the clone at
`/Volumes/ThunderBolt/_tmp/development/_scratch/graph-mode-beta`, branch
`feat/graph-mode-v1.3-beta`. Output copied from the terminal, not paraphrased.
Failing cases were run before the passing case.

## 1. FAIL — over budget (exit 1, no `--out` file written)

```
$ bash pack.sh --task fixtures/task.txt \
    --lane-contract fixtures/lane-contract.fixture.md \
    --done-means fixtures/done-means.fixture.sh \
    --decisions fixtures/decisions.fixture.md \
    --loop-policy fixtures/loop-policy.fixture.md \
    --budget-tokens 300 --out fixtures/should-not-exist.md
OVER BUDGET: 972 > 300
section                          tokens
Task                             55
Done-means                       86
Standing rules                   69
Tightenings (ranked)             357
Decisions (ranked)               99
Loop policy                      64
Report format                    105
Excluded (available on request)  123
header                           13
EXIT=1
```

Proof the file was not written (same command line, immediately after):

```
$ ls fixtures/should-not-exist.md
ls: cannot access 'fixtures/should-not-exist.md': No such file or directory
```

Nothing appeared on stdout — the entire report went to stderr.

## 2. HARNESS ERROR — required input missing (exit 3)

```
$ bash pack.sh --task fixtures/task.txt \
    --lane-contract fixtures/lane-contract.fixture.md
HARNESS ERROR: missing required --done-means
EXIT=3
```

## 3. HARNESS ERROR — lane contract has no `## Tightenings` (exit 3, ABSENT)

```
$ bash pack.sh --task fixtures/task.txt \
    --lane-contract fixtures/no-tightenings.fixture.md \
    --done-means fixtures/done-means.fixture.sh
ABSENT: no "## Tightenings" section in fixtures/no-tightenings.fixture.md
EXIT=3
```

## 4. HARNESS ERROR — empty task, i.e. examined nothing (exit 3, not 0)

```
$ printf '' | bash pack.sh --task - \
    --lane-contract fixtures/lane-contract.fixture.md \
    --done-means fixtures/done-means.fixture.sh
HARNESS ERROR: --task is empty
EXIT=3
```

## 5. PASS — default budget (exit 0, non-empty Excluded section)

```
$ bash pack.sh --task fixtures/task.txt \
    --lane-contract fixtures/lane-contract.fixture.md \
    --done-means fixtures/done-means.fixture.sh \
    --decisions fixtures/decisions.fixture.md \
    --loop-policy fixtures/loop-policy.fixture.md \
    --out fixtures/out.brief.md
# Lane brief

budget: 972/8000 tokens (ceil chars/4)

## Task

Add a done-means check that proves every bash entrypoint in scripts/ is
bash-3.2 clean, and wire the node 24 runtime resolution into the wrapper so a
launchd job does not fall back to a stale PATH node binary.

## Done-means

path: fixtures/done-means.fixture.sh
invocation: `bash fixtures/done-means.fixture.sh`

... (full brief in fixtures/out.brief.md) ...

## Tightenings (ranked)

- **2026-08-23 — A bash entrypoint written on a Mac breaks on the cc-* boxes.**
  (provenance: lane report L-04.) Associative arrays and `mapfile` are bash 4; every entrypoint is bash-3.2 clean or it is broken on Linux.

- **2026-08-22 — Bare `node` off PATH resolves to nothing under launchd.**
  (provenance: PR #331.) System-invoked entrypoints exec the absolute node@24 keg path, never a bare name.

- **2026-08-24 — A skill's executables that live outside the repo drift silently.**
  (provenance: PR #329.) Executables a skill owns live in that skill's `scripts/`; runtime homes get copies, never originals.

- **2026-08-21 — A check that exits 0 having examined nothing reads as a pass.**
  (provenance: issue #302.) Empty input is exit 3, never exit 0.

- **2026-08-18 — A green that was never red proves nothing.**
  (provenance: controller contract.) Capture the RED transcript before the fix.

- **2026-08-17 — Staging with `git add -A` sweeps another session's files.**
  (provenance: ArmPros incident.) Stage by explicit path and diff --cached before commit.

- **2026-08-20 — Truncating a brief to fit a budget hides the omission.**
  (provenance: lane report L-11.) Fail closed and list what was excluded; never silently drop.

- **2026-08-19 — `git worktree remove` is the only correct teardown.**
  (provenance: audit 07-30.) A plain `rm -rf` strands the .git/worktrees registration.

## Decisions (ranked)

- #2 Node runtime: Node 24 keg absolute path for system-invoked entrypoints.
- #1 Shell dialect: All entrypoints are bash-3.2 clean; no bash-4 syntax.
- #3 Token estimator: Token budgets use ceil(chars/4), stated in the README.
- #4 Budget behaviour: Over budget refuses and writes nothing; never truncate.
- #5 Board fields: Status field is set at merge, not at dispatch.

## Excluded (available on request)

- 2026-08-16 - **2026-08-16 — A localhost bind on 7141 shadows the librarian daemon.**   (pro
- 2026-08-15 - **2026-08-15 — Secrets leak through fixtures more often than through code.**  
- 2026-08-14 - **2026-08-14 — Token estimates diverge between tokenizers.**   (provenance: la
- 2026-08-13 - **2026-08-13 — A TypeScript enum cannot be type-stripped.**   (provenance: STA
- 2026-08-19 #6 Deletes: Agents move to _archive; removal is Rico's own hand.
EXIT=0
```

The task mentions bash-3.2 and node/launchd; the two entries about exactly those
rank first and second, ahead of the newest entry (2026-08-24). Four Tightenings
and the one non-matching RATIFIED decision (`#6 Deletes`) are listed as excluded
rather than dropped. The `PROPOSED` row `#7 Colour palette` is absent from both
lists, as designed.

## 6. PASS — the REAL repo files

Two-line task, real `_DOCS/lane-contract.md` (which carries exactly one
Tightening) and real `scripts/done-means/exemplar-battery.sh`:

```
$ printf 'Harden the exemplar battery so a missing uv exits 3 rather than 1.\nAdd a fixture proving the python exemplar RED path.\n' > fixtures/real-task.txt
$ bash pack.sh --task fixtures/real-task.txt \
    --lane-contract ../../../../../_DOCS/lane-contract.md \
    --done-means ../../../../../scripts/done-means/exemplar-battery.sh \
    > fixtures/real.out.md 2> fixtures/real.err
EXIT=0
$ wc -c fixtures/real.out.md
    3636 fixtures/real.out.md
$ cat fixtures/real.err
(empty)
```

**Recorded token count against the real files: 907 / 8000** (`budget: 907/8000
tokens (ceil chars/4)`, line 3 of `fixtures/real.out.md`). Excluded section is
`(none)` — the real contract's single Tightening fits inside `--max-tightenings 8`.
This run also exercised the default `--controller-contract` path resolution,
which pulled the `## Lane report schema` block out of the real
`_DOCS/controller-contract.md`.
