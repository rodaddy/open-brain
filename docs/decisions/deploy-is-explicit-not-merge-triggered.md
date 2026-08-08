# Deploy is explicit, never merge-triggered

**Scope key:** `process.deploy_is_explicit_not_merge_triggered`
**Source:** https://github.com/rodaddy/open-brain/issues/240
**Recorded:** 2026-08-03 (harvest #522, operator-routed)
**Status:** settled. Recorded from the source issue/PR; verify against current code before relying on an implementation detail.

---

## The decision

Production deploy to deployment_host is decoupled from merging: pushes to `main` run CI validation only. Deploy runs only from an explicit manual workflow dispatch whose HEAD equals the current `origin/main` tip with `deploy_deployment_host=true`, or from a `v*` version tag whose commit is reachable from `origin/main`. Merging a PR is never a deploy; cut a versioned release candidate and deploy it deliberately via the release gate.

## Verbatim, from the source

> stop deploying Open Brain automatically on every push to `main` ... allow production deploy only from an explicit manual workflow dispatch from the current `origin/main` tip with `deploy_deployment_host=true`, or from a version tag matching `v*` whose commit is reachable from `origin/main`

## Provenance

Harvested in #522 from the issue/PR text cited above, reviewed by the operator on
2026-08-03, and routed here rather than into a guidance lane: a decision with
rationale worth not re-litigating lives in a file, not only in a closed issue.
The quote is byte-identical to the harvest record; the decision paragraph is the
harvest's distilled rule text, unedited.
