---
lane: adversarial
order: 25
---
## PR #421 — a fix that broke on its own stated goal

Severity: HIGH. Status: fixed in `b38525d`. Provenance: PR #421, adversarial and
gotcha lanes independently.

A dependency was moved to a git source *specifically so cold environments would
work*, and then given an `ssh://` URL — which requires a configured host key and
credentials that a fresh clone does not have. Both lanes reproduced
`Host key verification failed` from an HTTPS checkout with an empty cache.

The follow-up fix switched to `https://` and failed differently: the repository
is **private** and CI passes no token, so `could not read Username`. Two commits
in a row treated a reachability constraint as a URL-scheme choice.

The adversarial move that caught it was cheap: take the comment's own claim
("this works in a cold clone") and construct the cold clone.

### Review Questions

- Does a comment claim a property? Construct the exact environment it names and
  check. Comments asserting portability, isolation, or "works anywhere" are the
  highest-yield targets.
- For a fix justified by a scenario, does the fix actually hold *in that
  scenario*, or only in the author's working copy?
- For any external resource: is it reachable without the author's ambient
  credentials — no SSH agent, no token, no sibling checkout, empty cache?
- When a second attempt fails differently from the first, is the underlying
  constraint being addressed, or is the symptom being renamed?
