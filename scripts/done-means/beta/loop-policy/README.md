# loop-policy

Status: WRITTEN 2026-08-27. Nothing here is merged or running.

## What it proves

A dispatch plan states, before the run starts, what would make it stop — and
that statement is machine-checkable. `check.sh` refuses a plan whose stop
conditions are missing, unmeasurable, or circular.

The rule the whole thing exists to enforce: **exhaustion parks, it never
loops.** A run that trips a guard writes down where it got to and stops.
`on_exhaust` is mandatory, non-empty, and may not contain the word "retry",
because a retry is precisely what the guards just ruled out.

## Files

| file | what it is |
| --- | --- |
| `templates/loop-policy.md` | The schema: every field, its type, and a filled example. |
| `templates/dispatch-plan.template.md` | A dispatch plan skeleton with a `## Loop policy` block. Passes `check.sh` as written. |
| `check.sh` | Validates the block. Pure bash + awk, no Node. |
| `snippet.js` | Dependency-free guard evaluation for Workflow scripts. |
| `test/snippet.test.js` | `node:test` suite for the snippet. |
| `fixtures/` | One passing plan, five failing plans (one per failure clause), and a zero-byte `empty.md` for the exit-3 case. |
| `RED.md` | Real transcripts: every fixture, the harness cases, the mutation run. |

## Usage

```
./check.sh <dispatch-plan.md>
```

Failures print one `FAIL <field>: <detail>` line each, so a plan with three
problems reports three lines rather than stopping at the first.

```
$ ./check.sh fixtures/fail-on-exhaust-retry.md
FAIL on_exhaust: must not contain "retry": exhaustion parks, it does not loop
```

Tests:

```
/opt/homebrew/opt/node@24/bin/node --test test/snippet.test.js
```

Note `--test` takes the FILE, not the directory — `node --test test/` resolves
the directory as a module and dies with `MODULE_NOT_FOUND`.

## Exit grammar

| exit | meaning |
| --- | --- |
| `0` | pass |
| `1` | the policy block failed a rule |
| `3` | harness error — no argument, unreadable file, or empty file |

Exit 0 having examined nothing is not a pass: an empty input is exit 3.

## What check.sh enforces

- `## Loop policy` section present, containing a closed fenced block.
- All eight fields present: `goal`, `deadline_minutes`, `budget_tokens`,
  `max_turns`, `no_progress`, `on_goal`, `on_exhaust`, `priority`.
- `deadline_minutes`, `budget_tokens`, `max_turns` are positive integers.
- `no_progress.metric` non-empty; `no_progress.window` an integer >= 1.
- `on_exhaust` non-empty and free of the word "retry" (case-insensitive).
- `priority` is exactly `goal, deadline, budget, max_turns, no_progress`, in
  that order.

## snippet.js

```js
const lp = createLoopPolicy(policy, { budget, now });
lp.turn();                 // count a dispatch round / attempt
lp.noProgress(redAgain);   // true = another RED, false resets the streak
lp.markGoal();             // the done-means check passed
lp.check();                // -> { exhausted: boolean, guard: string|null }
```

`check()` evaluates guards in `policy.priority` order and the **first hit
wins**; guard names are the field names.

**`goal` is not evaluated by the snippet.** The done-means check decides the
goal, so the caller runs it and calls `markGoal()` on a pass; `check()` then
returns `{ exhausted: false, guard: "goal" }` — the one guard that ends a run
successfully, which is why it sits first in priority.

**The clock is injected.** The Workflow evaluator forbids `Date.now`, so pass
`now` returning epoch milliseconds; `deadline` compares `now()` minus the start
captured at construction. `budget` is injected the same way and uses
`budget.total` / `budget.spent()`; with no budget object the budget guard is
skipped rather than treated as tripped.

Estimate tokens anywhere as `ceil(chars / 4)`.

## Known limits

- **`check.sh` is not a YAML parser.** It reads the simple `key: value` and
  two-level nested shape by hand in awk. Flow mappings (`{a: 1}`), inline lists
  (`[a, b]`), multi-line scalars (`|`, `>`), anchors, quoted keys, and comments
  inside the block are not understood. Keep the block in the shape the
  templates use.
- Only the FIRST fenced block under `## Loop policy` is read.
- `on_exhaust` is checked for the substring `retry`, so "retry" inside a longer
  word trips it. That is deliberate: the field should name a parking spot, and
  the false positive is cheaper than the miss.
- `goal` is checked for non-emptiness only. That it names a real, existing
  check path is not verified here — that is the done-means check's job.
- The snippet holds no timers and performs no I/O; it only answers from what
  the caller has told it via `turn()`, `noProgress()`, and the injected clock
  and budget.
