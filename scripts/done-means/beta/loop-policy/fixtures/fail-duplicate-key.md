## Loop policy

```yaml
goal: check exits 0
deadline_minutes: 90
budget_tokens: 400000
max_turns: 6
no_progress:
  metric: RED streak
  window: 3
on_goal: commit
on_exhaust: retry the whole thing from scratch
on_exhaust: park and write a decisions item
priority:
  - goal
  - deadline
  - budget
  - max_turns
  - no_progress
```
