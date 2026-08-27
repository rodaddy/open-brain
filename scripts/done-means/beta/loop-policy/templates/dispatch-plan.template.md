# Dispatch plan — <engagement>

Status: PROPOSED <date>.

## Objective

<One paragraph: what this engagement changes, and for whom.>

## Lanes

- `<lane-id>` — <bounded deliverable>. Non-goals: <what this lane must not touch>.
- `<lane-id>` — <bounded deliverable>. Non-goals: <...>.

## Loop policy

<!-- Schema and field meanings: templates/loop-policy.md
     Validate with: check.sh <this-file>
     on_exhaust is mandatory, non-empty, and may never say "retry". -->

```yaml
goal: <scripts/done-means/<check>.sh exits 0 when ...>
deadline_minutes: 60
budget_tokens: 250000
max_turns: 5
no_progress:
  metric: done-means RED streak
  window: 3
on_goal: commit, PR, harvest
on_exhaust: park — write a decisions-pass item with the last RED output, then emit "ABANDONED: <check-id> <reason>"
priority:
  - goal
  - deadline
  - budget
  - max_turns
  - no_progress
```

## Done-means

| check | proves |
| --- | --- |
| `scripts/done-means/<check>.sh` | <what a 0 from it establishes> |

## Harvest

<What gets written back on success: Tightenings entry, GOTCHAS line, new check.>
