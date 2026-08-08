---
lane: gotcha-agent
order: 18
---
## PR #421 — a new package can ship with no CI gate at all

Severity: MEDIUM. Status: fixed in `0d110f1`. Provenance: PR #421, gotcha lane.

`python/openbrain-provider/` landed with its own tests, strict mypy config,
`py.typed`, and wheel configuration — and **no CI job ran any of it**. The
existing `python-package` job is rooted at `python/openbrain-memory` via
`defaults.run.working-directory`; nothing in `ci.yml` named the new package. All
Python CI stayed green while the new package was entirely unenforced.

The failure mode is delayed: a later change breaks provider imports, typing, or
wheel contents, `openbrain-memory` stays healthy, every check passes, and the
break merges.

Related, same PR: a dependency that cannot be fetched in CI. `rtech-standards`
is a **private** repo and this repo's CI passes **no token** (no `secrets.`
reference exists in `ci.yml`). An `ssh://` git source failed host-key
verification; switching to `https://` failed with `could not read Username`. Two
commits treated a reachability problem as a URL-scheme mistake. Check whether a
new dependency is reachable from an *unauthenticated* checkout before choosing
a URL.

Also caught here: a flush race that was green locally and red only in CI. A test
read a log file before calling `logger.remove()`; with loguru `enqueue=True` the
write is on a background thread.

### Review Questions

- Does a PR that adds a new package, workspace member, or language directory
  also add a CI job that runs its lint, typecheck, test, and build? Grep
  `ci.yml` for the new directory name — presence of tests is not coverage.
- Is the new job in `deploy`'s `needs:` list, or can a broken package deploy?
- For a new external dependency: is its repository public, and if not, does CI
  have credentials? Try the documented install command in a checkout with no
  SSH agent and no token before trusting any git URL.
- Does any test read a file written by an `enqueue=True` sink before removing
  the sink? That passes on a fast local disk and fails in CI.
- Does a declared `[project.scripts]` entry point import successfully? No lint,
  type, or test gate reads packaging metadata; the shim installs and dies at
  runtime.
