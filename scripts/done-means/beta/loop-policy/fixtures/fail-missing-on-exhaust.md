# Dispatch plan — exemplar battery hardening

## Lanes

- `lane-a` — extend `scripts/done-means/exemplar-battery.sh` to cover mypy strict.

## Loop policy

```yaml
goal: scripts/done-means/exemplar-battery.sh exits 0 on the exemplar tree with mypy strict enabled
deadline_minutes: 90
budget_tokens: 400000
max_turns: 6
no_progress:
  metric: done-means RED streak
  window: 3
on_goal: commit, PR, harvest
priority:
  - goal
  - deadline
  - budget
  - max_turns
  - no_progress
```

## Notes

The check path named in `goal` is the only thing that decides done.
