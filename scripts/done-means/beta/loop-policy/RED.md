# RED transcript — loop-policy

Status: WRITTEN 2026-08-27. Captured before the README was written; outputs
are copied verbatim from the terminal, not paraphrased.

Node: `/opt/homebrew/opt/node@24/bin/node` v24.19.0.

## Failing fixtures

### `fixtures/fail-missing-on-exhaust.md`

```
$ ./check.sh fixtures/fail-missing-on-exhaust.md
FAIL on_exhaust: field missing
exit=1
```

### `fixtures/fail-on-exhaust-retry.md`

```
$ ./check.sh fixtures/fail-on-exhaust-retry.md
FAIL on_exhaust: must not contain "retry": exhaustion parks, it does not loop
exit=1
```

### `fixtures/fail-priority-order.md`

```
$ ./check.sh fixtures/fail-priority-order.md
FAIL priority: position 2 must be "deadline", got "budget"
FAIL priority: position 3 must be "budget", got "deadline"
exit=1
```

### `fixtures/fail-max-turns-nonint.md`

```
$ ./check.sh fixtures/fail-max-turns-nonint.md
FAIL max_turns: must be a positive integer, got "many"
exit=1
```

### `fixtures/fail-no-section.md`

```
$ ./check.sh fixtures/fail-no-section.md
FAIL section: no "## Loop policy" heading
exit=1
```

## Passing fixture

```
$ ./check.sh fixtures/pass.md
exit=0
```

The template validates too — a template that fails its own check is a trap:

```
$ ./check.sh templates/dispatch-plan.template.md
exit=0
```

## Harness cases (exit 3)

```
$ ./check.sh
HARNESS: usage: check.sh <dispatch-plan.md>
exit=3

$ ./check.sh fixtures/nope.md
HARNESS: unreadable file: fixtures/nope.md
exit=3

$ : > fixtures/empty.md && ./check.sh fixtures/empty.md
HARNESS: empty file, examined nothing: fixtures/empty.md
exit=3
```

Exit 0 having examined nothing is not a pass: the empty file sets exit 3.

## snippet.js — tests bite

A passing suite that was never seen failing is not evidence. Mutating the
`max_turns` comparison from `>` to `>=` fails exactly the one test that
pins the off-by-one:

```
$ sed 's|turns > policy.max_turns|turns >= policy.max_turns|' snippet.js > mutant.js && cp mutant.js snippet.js
$ /opt/homebrew/opt/node@24/bin/node --test test/snippet.test.js
✖ max_turns trips on the (max+1)th turn (1.4735ms)
✔ no_progress trips after window consecutive reds and resets on false (0.109083ms)
✔ budget trips when spent >= budget_tokens (0.0675ms)
✔ budget is skipped when no budget object is injected (0.049041ms)
✔ deadline trips via the injected clock (0.061042ms)
✔ priority order decides when two guards trip simultaneously (0.074917ms)
✔ markGoal reports goal without exhausting the run (0.053333ms)
ℹ tests 7
ℹ pass 6
ℹ fail 1
✖ max_turns trips on the (max+1)th turn (1.4735ms)
```

Restored, the suite is green:

```
$ /opt/homebrew/opt/node@24/bin/node --test test/snippet.test.js
✔ max_turns trips on the (max+1)th turn (0.663166ms)
✔ no_progress trips after window consecutive reds and resets on false (0.084416ms)
✔ budget trips when spent >= budget_tokens (0.060292ms)
✔ budget is skipped when no budget object is injected (0.046791ms)
✔ deadline trips via the injected clock (0.061208ms)
✔ priority order decides when two guards trip simultaneously (0.070417ms)
✔ markGoal reports goal without exhausting the run (0.061625ms)
ℹ tests 7
ℹ pass 7
ℹ fail 0
```
