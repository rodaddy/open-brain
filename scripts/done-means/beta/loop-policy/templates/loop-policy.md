# Loop policy — schema

Status: WRITTEN 2026-08-27.

A loop policy states, before a run starts, what would make it stop. Without
one a run ends when someone notices it is going badly, which is late and
unrepeatable. The block lives under `## Loop policy` in a dispatch plan and is
validated by `check.sh`.

The rule the schema exists to enforce: **exhaustion parks, it never loops.**
A run that hits a guard writes down where it got to and stops. `on_exhaust`
may not say "retry", because a retry is what the guards just ruled out.

## Fields

All eight are mandatory.

| field | type | meaning |
| --- | --- | --- |
| `goal` | one falsifiable sentence | What done means, NAMING the `scripts/done-means/` check path that decides it. Prose that no check can settle is not a goal. |
| `deadline_minutes` | positive integer | Wall-clock minutes from run start. |
| `budget_tokens` | positive integer | Token ceiling for the run. Estimate tokens as `ceil(chars / 4)`. |
| `max_turns` | positive integer | Dispatch rounds for a run; attempts for a lane. |
| `no_progress` | object | `metric` (text, the signal watched — normally `done-means RED streak`) and `window` (integer >= 1, how many consecutive no-progress observations trip it). |
| `on_goal` | text | What happens when the check passes, e.g. `commit, PR, harvest`. |
| `on_exhaust` | text, non-empty | Where the run PARKS: the decisions-pass item to write, and the `ABANDONED: <check-id> <reason>` line to emit. May never be `retry`. |
| `priority` | list | Exactly `[goal, deadline, budget, max_turns, no_progress]`, in that order. The first guard that trips decides the outcome. |

`priority` is fixed rather than free-form so that two runs that hit the same
pair of guards stop for the same stated reason. `goal` sits first because a met
goal ends the run successfully even if another guard also tripped.

## Example

```yaml
goal: scripts/done-means/exemplar-battery.sh exits 0 on the exemplar tree with mypy strict enabled
deadline_minutes: 90
budget_tokens: 400000
max_turns: 6
no_progress:
  metric: done-means RED streak
  window: 3
on_goal: commit, PR, harvest
on_exhaust: park — write a decisions-pass item recording the last RED output, then emit "ABANDONED: exemplar-battery mypy-strict unresolved after 3 RED rounds"
priority:
  - goal
  - deadline
  - budget
  - max_turns
  - no_progress
```

## Who evaluates what

`goal` is decided by the done-means check, never by the loop policy code. The
runner executes the check, and on a pass calls `markGoal()` on the snippet
(`snippet.js`). Every other guard the snippet evaluates itself from an injected
clock and budget.
