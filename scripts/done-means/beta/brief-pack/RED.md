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

## 2026-08-27 pilot fix

The open-brain pilot hit two defects. Both transcripts below are the RED state
captured BEFORE the fix, then the same commands after. Same clone, same branch.

### 7. RED — real open-brain controller contract, exit 3 (defect a)

open-brain spells the section `## Required lane report format`; the tool
required the literal `## Lane report schema`, so pack never packed.

```
$ bash pack.sh --task fixtures/openbrain-task.txt \
    --lane-contract /Volumes/ThunderBolt/Development/open-brain/docs/lane-contract.md \
    --done-means /Volumes/ThunderBolt/Development/open-brain/scripts/done-means/563-bounded-recall.sh \
    --controller-contract /Volumes/ThunderBolt/Development/open-brain/docs/controller-contract.md
HARNESS ERROR: controller contract has no "## Lane report schema" section
EXIT=3
```

### 8. RED — default --controller-contract was Development-shaped (defect b)

With no flag, the default was `_DOCS/controller-contract.md` resolved relative
to the tool, not to the lane contract. open-brain keeps both contracts in
`docs/`, so the default could never find it.

### 9. GREEN — heading discovered by /report/i

```
$ bash pack.sh --task fixtures/openbrain-task.txt \
    --lane-contract /Volumes/ThunderBolt/Development/open-brain/docs/lane-contract.md \
    --done-means /Volumes/ThunderBolt/Development/open-brain/scripts/done-means/563-bounded-recall.sh \
    --controller-contract /Volumes/ThunderBolt/Development/open-brain/docs/controller-contract.md
budget: 1255/8000 tokens (ceil chars/4) | report-format: ## Required lane report format
EXIT=0
```

Under the default 8000 budget, so no OVER BUDGET table — 1255 tokens against
the real files. stderr was empty.

### 10. GREEN — default derived from the lane contract's directory

Same command with `--controller-contract` REMOVED entirely. The default now
resolves `docs/controller-contract.md` beside the lane contract:

```
$ bash pack.sh --task fixtures/openbrain-task.txt \
    --lane-contract /Volumes/ThunderBolt/Development/open-brain/docs/lane-contract.md \
    --done-means /Volumes/ThunderBolt/Development/open-brain/scripts/done-means/563-bounded-recall.sh
budget: 1255/8000 tokens (ceil chars/4) | report-format: ## Required lane report format
EXIT=0
```

Identical output to the explicit-flag run, which is the point.

### 11. GREEN — new fixture, "## Required lane report format" (exit 0)

```
$ bash pack.sh --task fixtures/task.txt \
    --lane-contract fixtures/lane-contract.fixture.md \
    --done-means fixtures/done-means.fixture.sh \
    --controller-contract fixtures/ctrl-required-format.fixture.md
budget: 764/8000 tokens (ceil chars/4) | report-format: ## Required lane report format
EXIT=0
```

### 12. RED — new fixture, no /report/i heading (exit 3 ABSENT)

```
$ bash pack.sh --task fixtures/task.txt \
    --lane-contract fixtures/lane-contract.fixture.md \
    --done-means fixtures/done-means.fixture.sh \
    --controller-contract fixtures/ctrl-no-report.fixture.md
ABSENT: no level-2 heading matching /report/i in fixtures/ctrl-no-report.fixture.md
EXIT=3
```

### 13. GREEN — new fixture, no flag, contract beside the lane contract (exit 0)

`fixtures/derived-dir/` holds `lane-contract.md` and `controller-contract.md`.

```
$ bash pack.sh --task fixtures/task.txt \
    --lane-contract fixtures/derived-dir/lane-contract.md \
    --done-means fixtures/done-means.fixture.sh
budget: 765/8000 tokens (ceil chars/4) | report-format: ## Required lane report format
EXIT=0
```

### 14. Regression — the five original fixtures, exit codes unchanged

Run after the fix; compare to cases 1-5 above.

```
1 over budget (--budget-tokens 300)     -> EXIT=1   (fixtures/should-not-exist.md still absent)
2 missing --done-means                  -> EXIT=3   HARNESS ERROR: missing required --done-means
3 no ## Tightenings                     -> EXIT=3   ABSENT: no "## Tightenings" section in ...
4 empty task via stdin                  -> EXIT=3   HARNESS ERROR: --task is empty
5 pass, default budget                  -> EXIT=0   report-format: ## Lane report schema
```

Case 5 still selects `## Lane report schema`: `/report/i` matches the original
spelling, so the fixture contract is unaffected. Its token count moved 972 ->
982 because the header line now carries the heading — the brief's content is
byte-identical otherwise.

### Note — an interim patch broke cases 1 and 5

First cut made the lane-contract-relative path the ONLY default, which sent
cases 1 and 5 (lane contract in `fixtures/`, no `controller-contract.md` there)
to `EXIT=3 HARNESS ERROR: no --controller-contract given and none at ...`. The
default is now an ordered candidate list — lane-contract directory first, then
the historical `_DOCS/controller-contract.md` — so a repo-shaped layout wins
without dropping the Development-shaped one. Caught by re-running the old
fixtures, which is why they are in the suite.

### 15. RED — heading-shaped Tightenings ranked as (none) (defect c, controller)

Same class as ratchet-bound R1: `parseEntries` only opened an entry on a
`- **YYYY-MM-DD` bullet. The first pilot's contract uses `### YYYY-MM-DD
(round N)` headings with the rules as bullets underneath, so every entry was
invisible and the brief shipped `## Tightenings (ranked)` / `(none)` with
exit 0 (case 9 above, 1255 tokens). Green having examined nothing.

Fix: an entry opens on either shape, and a heading block (its bullets
included) is ONE entry, the same unit ratchet-bound counts.

```
$ bash pack.sh --task fixtures/task.txt \
    --lane-contract fixtures/lane-contract-heading.fixture.md \
    --done-means fixtures/done-means.fixture.sh | rg -n 'budget:|^### '
3:budget: 483/8000 tokens (ceil chars/4) | report-format: ## Lane report schema
34:### 2026-08-17 (round 31) — harvest of the clone-path wave
41:### 2026-08-18 (round 32) — harvest of the live-observer lane
49:### 2026-08-16 (round 30) — harvest of the index lane
EXIT=0
```

### 16. The real first-pilot contract now refuses OVER BUDGET (exit 1)

With the 39 heading entries visible, the default top-8 ranking overflows:

```
$ bash pack.sh --task fixtures/openbrain-task.txt \
    --lane-contract <first pilot>/docs/lane-contract.md \
    --done-means <first pilot>/scripts/done-means/563-bounded-recall.sh
OVER BUDGET: 8881 > 8000
section                          tokens
Task                             36
Done-means                       891
Standing rules                   33
Tightenings (ranked)             6907
Report format                    250
Excluded (available on request)  738
header                           26
EXIT=1
```

Same run with `--max-tightenings 3` -> `budget: 5524/8000`, EXIT=0. This is
the first OVER BUDGET refusal on a real contract, which the amendment's pilot
exit criteria ask for. Outputs kept beside the earlier ones:
`fixtures/openbrain-heading.out.md`, `fixtures/openbrain-heading.err`.

Originals re-run after the change: `lane-contract.fixture.md` EXIT=0,
`derived-dir/lane-contract.md` EXIT=0.

### 17. RED — a Tightenings section in an unrecognised shape packed as (none)

The mirror of case 15: there, heading entries were invisible; here, entries in
NEITHER supported shape are invisible and the packer shipped a brief anyway.
The fixture's section holds three real rules as plain bullets, one of them
literally "A check that exits 0 having examined nothing is not a pass":

```
$ bash pack.sh --task fixtures/task.txt \
    --lane-contract fixtures/harness-unrecognised-shape.fixture.md \
    --done-means fixtures/done-means.fixture.sh
## Tightenings (ranked)

(none)
EXIT=0
```

A brief that omits every standing rule while reporting success is worse than a
refusal, because the lane reads it as the complete contract. brief-pack now
carries the same vacuous-green guard as ratchet-bound:

```
HARNESS ERROR: 0 Tightenings entries recognized in a non-empty section (3
content lines); entries must open with "- **YYYY-MM-DD" or "### YYYY-MM-DD"
EXIT=3
```

A genuinely empty or whitespace-only section still packs at exit 0 — the guard
counts content lines, ignoring blanks and HTML comments.

Regression: over-budget 1, missing --done-means 3, no-Tightenings 3, default 0,
derived-dir 0, heading-shaped 0. Both REAL pilot contracts unchanged: the first
still refuses OVER BUDGET (exit 1), the second still packs at 2740/8000
(exit 0).

## Case 18 — an unknown flag and a zero cap both shipped a hollow brief at exit 0

Two ways to get a brief that examined almost nothing while reporting success,
found by adversarial review 2026-08-27. Both are argument-level, so neither
touched the vacuous-green guard added in case 17.

A misspelled flag was stored in the options map under its own wrong name and
then never read, so the run silently used every default. A misspelled budget is
the worst case: the operator believes they capped the brief at 800 tokens and
gets 8000.

```
$ bash pack.sh --task fixtures/task.txt \
    --lane-contract fixtures/lane-contract.fixture.md \
    --done-means fixtures/done-means.fixture.sh \
    --budget-token 800
EXIT=0        # full 8000-token default brief, no warning
```

A cap of zero packed the literal string "(none)" under every ranked section and
still exited 0 — the same hollow brief the guard exists to refuse, reached
through a flag instead of an empty section. A negative cap was quieter and
worse: `slice(0, -1)` is not an error in JavaScript, it drops exactly the last
element, so `--max-tightenings -1` shipped 11 of 12 entries and looked like an
ordinary pass.

```
$ bash pack.sh ... --max-tightenings 0
## Tightenings (ranked)

(none)
EXIT=0

$ bash pack.sh ... --max-tightenings -1
EXIT=0        # 11 of 12 entries, silently
```

After the fix, the argument parser rejects an unrecognised flag by name and
bounds the three numeric options:

```
$ bash pack.sh ... --budget-token 800
HARNESS ERROR: unknown flag --budget-token; known flags are --task
--lane-contract --done-means --controller-contract --decisions --loop-policy
--budget-tokens --max-tightenings --max-decisions --report-heading --out
EXIT=3

$ bash pack.sh ... --max-tightenings 0
HARNESS ERROR: --max-tightenings must be at least 1, got 0
EXIT=3

$ bash pack.sh ... --max-tightenings -1
HARNESS ERROR: --max-tightenings must be at least 1, got -1
EXIT=3
```

`--max-decisions 0` stays legal and exits 0: a brief with no Decisions section
is a real shape, unlike a brief with no Tightenings.

Regression, 14 cases: unknown flag 3, max-t 0 3, max-t -1 3, max-d -1 3,
max-d 0 legal 0, max-t 1 legal 0, plain 0, no-tightenings 3, budget-10 1,
ctrl-no-report 3, decisions 0, loop-policy 0, heading variant 0, unrecognised
shape 3. All three REAL lane contracts re-run: Development packs at exit 0,
software-factory packs at exit 0, open-brain still refuses OVER BUDGET at
exit 1 (8229 > 8000) because it carries 45 live Tightenings against its own
bound of 15 — a harvest backlog, not a brief-pack defect.
