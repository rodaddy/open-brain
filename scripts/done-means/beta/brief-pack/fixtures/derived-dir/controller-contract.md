# Controller contract (fixture)

## Dispatch rules

One lane, one bounded deliverable, one done-means check.

## Required lane report format

Five fields, in this order, nothing after `lessons:`:

```
deliverable:   <one line>
claim-states:  <each file: WRITTEN | MERGED | RUNNING>
verified:      <cmd> -> <exit N and last line>
deviations:    <none | what>
lessons:       <none | one line>
```

## Controller obligations

Verify before landing; a worker's output is PROPOSED until checked.
