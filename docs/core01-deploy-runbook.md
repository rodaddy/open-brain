# Core01 Deploy Runbook

Issue: #675 (cutover-blocker B5), with the B1 entrypoint ruling from #674.

**Status: WRITTEN, not RUNNING.** Every step below has been proven locally
against a simulated target and NONE of it has been executed on core01
(`10.71.1.21`). The lane that wrote it never contacted that host. The steps in
"Cutover application" are for the operator to run ON core01 at cutover; nothing
in this repo runs them.

## What changed and why it matters

Until 2026-08-09 the core01 deploy could not fail in the one way that matters.
Its only post-restart assertion was `wait_for_health()` — a 20-second poll of
the `:3100` aggregate front — and on 2026-08-02 that exact shape reported a
successful deploy on the local clone while the OLD runtime was still serving:

1. the restart is accepted,
2. the new entrypoint throws on config and dies,
3. launchd holds the service down for `ThrottleInterval` (30s — **longer than
   the poll ran**),
4. `curl /health` is answered by the process that never stopped,
5. the deploy exits 0.

The stamp on disk said one revision; the running code was another. core01's
poll window was *shorter* than the clone's, so it was strictly more exposed.

The hardening is ported from `scripts/local-clone-deploy.sh`'s lineage.

## The success criterion is the revision proof, not health

`check_new_process_serving()` runs **before** health and all three assertions
are required:

| # | Assertion | What it rules out |
|---|---|---|
| 1 | a listener exists and its pid **differs** from the pre-restart pid | the old process never let go |
| 2 | that listener's `cwd` **is** the runtime directory | it is serving some other checkout |
| 3 | the runtime's `.deployed-revision` **matches** the shipped sha | it is serving a different revision |

`.deployed-revision` had been written since the runtime was first packaged and
was never read by anything. It is now load-bearing.

`lsof` on the port, deliberately — `launchctl print` reports the *supervised*
pid (the two-worker launcher, not a socket-binding worker) and `pgrep` matches
stray orphans holding no port. Only the socket knows who is serving `:PORT`.

## Polling windows are set against the plist

`OPENBRAIN_DEPLOY_REVISION_PROOF_TICKS` defaults to 30 ticks × 2s = **60s**,
chosen to outlast the `ThrottleInterval` of **30s** declared in
`docs/deploy/com.rico.open-brain.plist.template`.

**Changing `ThrottleInterval` without widening that window re-opens B3.** This
is why B2 (version the plist) and B3 (revision proof) were one fix surface: the
window has to outlast a number that previously existed only on the box.

## Per-worker ports, not just the front

core01 runs `open-brain-worker-1` (`:3101`) and `open-brain-worker-2` (`:3102`)
behind the `:3100` front (`scripts/run-two-worker.ts`). The front **aggregates**
worker health, so polling it is one indirection away from the question, and a
front answering over a dead worker reads green. `wait_for_worker_ports()` asks
each port directly. A dead worker is a halving of capacity and — for worker 0,
which carries the migrate flag — a deploy that did not do what it said.

## Feature signal: a revision proof is not a feature-live proof

Issue #659: the clone's redeploy passed its revision proof at the right SHA
while the merged feature stayed dark, because the launcher's env allowlist
dropped the new config keys. Revision right, feature absent.

`assert_feature_live()` reads the feature's own top-level key out of the served
`/health` body — with a JSON parse, not a substring match, since a substring is
satisfied by the key appearing anywhere including inside an error naming it.

```bash
# default; set per deploy to whatever this release is supposed to light up
OPENBRAIN_DEPLOY_HEALTH_FEATURE_KEY=capture_health
```

Setting it **empty** disables the assertion, and the deploy says so loudly in
its log rather than quietly degrading to a liveness check.

## The commit ships, not the working tree

`scripts/core01-package-runtime.sh` now `git archive`s the resolved commit.
Previously it `tar`red `$REPO_DIR`, so a dirty file on the runner shipped to
production. The ref gate did **not** cover that — it asserts a git-*history*
property (HEAD is an ancestor of `origin/main`) and is a no-op entirely outside
CI, which is every operator-run deploy.

Uncommitted paths are announced, never silently dropped. Deploy a specific
revision with `DEPLOY_REF`:

```bash
DEPLOY_REF=<sha> scripts/core01-deploy-local.sh
```

## Rollback

The previous runtime is restored and then held to the **same** standard of
proof, minus the feature assertion (the previous revision predates the feature
by definition, so demanding its signal would fail every correct rollback). A
rollback is when a false success is most expensive: the operator stops looking.

The failed runtime is **moved aside** to `<runtime>.failed-<timestamp>`, not
deleted — it is the evidence for why the deploy failed.

## Cutover application (RUN ON CORE01, BY THE OPERATOR)

Not executed from this repo. Preconditions: B1, B4 landed; `DB_NAME` verified
explicitly (#676 — it silently defaults to `open_brain`, and it selects which
brain).

1. **Install the versioned plist.** This is the B1 cutover: it sets
   `OPEN_BRAIN_WORKER_ENTRYPOINT=server/main.ts`. `src/` stays in the tree as
   rollback.

   ```bash
   cd /Volumes/ThunderBolt/open-brain/app
   cp docs/deploy/com.rico.open-brain.plist.template \
      ~/Library/LaunchAgents/com.rico.open-brain.plist
   plutil -lint ~/Library/LaunchAgents/com.rico.open-brain.plist
   ```

   Diff it against the live shape FIRST and reconcile any delta into the
   template, in git, before booting it — the template is written from source
   and has never been compared to the running service:

   ```bash
   launchctl print gui/$(id -u)/com.rico.open-brain
   ```

2. **Reload the service.**

   ```bash
   launchctl bootout   gui/$(id -u)/com.rico.open-brain 2>/dev/null || true
   launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.rico.open-brain.plist
   ```

3. **Deploy.** The script now proves its own success.

   ```bash
   OPENBRAIN_DEPLOY_HEALTH_FEATURE_KEY=capture_health \
     scripts/core01-deploy-local.sh
   ```

4. **Read the receipts in the deploy log.** All four must appear:

   - `revision proof PASSED: pid <old> -> <new>, cwd <runtime>, revision <sha>`
   - `worker port 3101 healthy` **and** `worker port 3102 healthy`
   - `feature 'capture_health' live on port ...` for each port
   - `env file backed up: ... -> ....bak-<timestamp>`

5. **Confirm the entrypoint actually changed** — the launcher announces it:

   ```bash
   grep "workers will run entrypoint" /Volumes/ThunderBolt/open-brain/logs/open-brain.out.log | tail -1
   # expect: server/main.ts
   ```

6. **Confirm each worker independently**, not through the front:

   ```bash
   curl -s http://127.0.0.1:3101/health | jq '.capture_health'
   curl -s http://127.0.0.1:3102/health | jq '.capture_health'
   ```

## Known residuals — NOT closed by this work

- **SHOULD-FIX 6 (advisory lock).** Migration concurrency is held only by
  `run-two-worker.ts` giving the migrate flag to worker 0. That is convention,
  not a lock. The plist deliberately does **not** set
  `OPEN_BRAIN_RUN_MIGRATIONS`, because setting it there would apply it to both
  workers and put two concurrent migration runs against one database.
- **Forward-incompatible migrations.** Rollback is code-only: restoring
  `.previous` restores code that may not run against the migrated schema. A
  forward-fix plan is still owed.
- **The plist has never been diffed against the live service** (step 1 exists
  because of this). It is written from source and is PROPOSED as an accurate
  description of the running shape until that comparison happens on core01.
- **`verify_deploy_ref` remains a no-op outside CI.** `git archive` now makes
  the working tree unshippable, which was the concrete harm, but an operator
  running this by hand still gets no origin-ancestry check.

## Verification

`scripts/done-means/675-core01-deploy-hardening.sh` — 9 clauses over a
simulated deploy (throwaway git repo, `_scratch` runtime, fake `launchctl`,
real listeners/sockets/`lsof`, ports in the 7100-7199 dev range). It reproduces
both failure modes literally: the new process dying while the old one answers,
and an unchanged pid still holding the port. core01 is never contacted.
