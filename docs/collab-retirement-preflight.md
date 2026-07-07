# Collab Retirement Release Preflight

Issue: #167  
Branch: `release/167-retire-collab`  
Scope: release-preflight only

This document turns the remaining `collab` retirement work into an exact
release checklist. It is intentionally local-first and must not be used to
justify live mutation from an unapproved planning lane.

## Hard Guardrails

- Do not run any live DB mutation, production migration, deploy, or canary from
  this planning lane.
- Do not point scratch validation at production credentials or the core01 DB.
- `scripts/retire-collab-migration.ts` is dry-run by default. `--execute` is a
  release-only step and requires explicit approval plus a verified backup.
- `collab` is a frozen snapshot namespace. The release objective is to
  reconcile remaining live-unique rows into `shared-kb`, then remove the legacy
  fallback only after reconciliation is proven complete.

## Approved Release/Runtime Environment

For this preflight, an approved release/runtime environment means a release
operator is running the script from the approved live Open Brain runtime checkout
for the current deployed code, with the live DB environment intentionally loaded,
after the backup receipt has been recorded and execute approval has been granted
for this release window.

It does not mean this PR worktree, a local planning checkout, a scratch shell, or
any shell that merely has production credentials available. Before running any
live dry-run or execute command, the release operator must set this explicit
sentinel in the approved shell:

```zsh
export OPENBRAIN_COLLAB_RETIRE_RELEASE_APPROVED=core01-live-db-after-backup
```

All live command blocks below include a shell guard for that sentinel, and the
script itself refuses `--execute` unless the same sentinel is present. If the
guard fails, stop; do not delete the guard or rerun from a different shell to get
past it.

## Why This Is Still Blocked

Local code and tests already cover the retirement mechanics:

- namespace defaults are dropped by migration `019_drop_collab_namespace_defaults.sql`
- runtime/tests treat `collab` as retired and `shared-kb` as canonical
- `scripts/retire-collab-migration.ts` provides dry-run audit, transactional
  execute mode, and idempotent per-step reconciliation

What is still not complete is release-time evidence against live data:

1. verified backup before mutation
2. dry-run inventory against live data
3. operator classification of remaining out-of-scope rows
4. approved execute run against the current deployed code
5. proof that the fallback can be removed without making live rows invisible
6. downstream rollout and canary evidence

## Expected Release Inputs

These counts are the release-time baseline that must be confirmed from the
first approved live dry-run before any execute step is authorized:

- thoughts to reconcile: `69`
- `repo_fact` entities to handle: `12`
- collab lanes to handle: `4`

If the first live dry-run does not match those expected counts, stop and treat
the delta as a fresh release blocker. Do not improvise.

## Release Order

The order is load-bearing. Do not swap it.

1. backup live DB
2. run approved dry-run inventory against the current deployed code
3. classify every out-of-scope row surfaced by the audit
4. decide whether execute is allowed for this release window
5. if approved, run `--execute` against the current deployed code
6. verify zero unmirrored rows for the migrated scope
7. only then deploy the code path that removes the legacy fallback
8. run downstream refresh and canaries

This matches the merge-order warning captured in `docs/sme/domain-backend.md`:
migrate first, then deploy.

## Step 0: Local Release Readiness

Before touching live data, confirm the branch still matches the local artifact
expectations:

- `scripts/retire-collab-migration.ts` remains dry-run by default
- the script still audits all five content tables plus non-`repo_fact`
  entities and null-hash thoughts
- the script still performs the full `--execute` run inside one transaction
- migration `019` still leaves namespace columns without `collab` defaults
- docs still describe `collab` as retired and `shared-kb` as canonical

Minimum local checks:

```zsh
git diff --check
bun test scripts/retire-collab-migration.test.ts
rg -n "dry-run by default|--execute|backup|deploy" \
  scripts/retire-collab-migration.ts docs/collab-retirement-preflight.md
```

## Step 1: Backup Gate

Required before any live `--execute` run:

- take a fresh Postgres backup or storage snapshot for the live Open Brain DB
- record the backup timestamp, operator, target host, and restore path
- verify the backup completed successfully before continuing

Receipt template:

```text
Backup:
- Timestamp:
- Operator:
- Method: pg_dump | snapshot
- Source DB:
- Restore path:
- Verification:
```

No backup receipt means no execute approval.

## Step 2: Approved Live Dry-Run Inventory

Run the script in dry-run mode against the current deployed code and live DB
from the approved release/runtime environment only. Do not run this local PR
checkout or a scratch shell against production credentials, and do not deploy
new fallback behavior first. The script also fails closed before any DB query
when `DB_HOST` is non-local unless the release approval sentinel is present; the
shell guard below is operator feedback, not the only enforcement layer.

Use the full script first:

```zsh
[ "$OPENBRAIN_COLLAB_RETIRE_RELEASE_APPROVED" = "core01-live-db-after-backup" ] || {
  echo "Blocked: not in the approved collab-retirement release/runtime environment" >&2
  exit 1
}
bun run scripts/retire-collab-migration.ts
```

Then capture the per-step view if the full report needs operator review:

```zsh
[ "$OPENBRAIN_COLLAB_RETIRE_RELEASE_APPROVED" = "core01-live-db-after-backup" ] || {
  echo "Blocked: not in the approved collab-retirement release/runtime environment" >&2
  exit 1
}
bun run scripts/retire-collab-migration.ts --thoughts
bun run scripts/retire-collab-migration.ts --entities
bun run scripts/retire-collab-migration.ts --lanes
```

The dry-run report must be attached to the release note or issue comment with:

- `audit.total_out_of_scope`
- `thoughts.unmirrored_before`
- `entities.collab_repo_facts`
- `lanes.collab_unarchived_lanes`

## Step 3: Classification Gate

The dry-run audit is allowed to block the release. Treat every surfaced row as
belonging to one of these buckets:

### Thoughts (`69` expected)

- rows safe for direct shared copy
- rows already mirrored but archived on the shared side
- null-`content_hash` rows that need manual handling before execute

The release note must say whether the `69` thought total is:

- exactly executable by the scripted thought step
- partially blocked by null-hash/manual review
- changed since the last expected baseline

### `repo_fact` entities (`12` expected)

Classify each of the `12` collab `repo_fact` rows into:

- re-tag to `shared-kb`
- archive-in-collab due to active shared name conflict
- archive-in-collab due to active shared canonical-id conflict
- manual review if the row is not a clean repo-fact migration candidate

Any non-`repo_fact` collab entity surfaced by the audit is an out-of-scope
blocker until explicitly resolved or acknowledged by the release owner.

### Lanes (`4` expected)

The `4` lane rows are not copied; they are handled by lane status transition:

- archive active/wrapped collab lanes
- leave already archived lanes untouched

If the live lane count is not `4`, stop and explain why before execute.

## Step 4: Execute Authorization Gate

`--execute` is allowed only when all of the following are true:

- backup receipt exists
- dry-run report is attached
- expected counts match or the delta is explicitly approved
- out-of-scope rows are either resolved or explicitly acknowledged by the
  release owner
- operator confirms the execute run will target the current deployed code, not
  the post-fallback-removal deploy
- operator confirms the execute run is being launched from the approved
  release/runtime environment, not from this local PR checkout or a scratch shell
  with production credentials

If any item above is missing, the issue stays blocked.

Execute command after explicit release approval:

```zsh
[ "$OPENBRAIN_COLLAB_RETIRE_RELEASE_APPROVED" = "core01-live-db-after-backup" ] || {
  echo "Blocked: not in the approved collab-retirement release/runtime environment" >&2
  exit 1
}
bun run scripts/retire-collab-migration.ts --execute
```

If the audit still reports intentional out-of-scope rows and the release owner
explicitly accepts them, the receipt must say why before using:

```zsh
[ "$OPENBRAIN_COLLAB_RETIRE_RELEASE_APPROVED" = "core01-live-db-after-backup" ] || {
  echo "Blocked: not in the approved collab-retirement release/runtime environment" >&2
  exit 1
}
bun run scripts/retire-collab-migration.ts \
  --execute \
  --acknowledge-out-of-scope
```

Do not use `--acknowledge-out-of-scope` as a convenience flag.

## Step 5: Post-Execute Verification

After execute and before deploy:

- rerun the dry-run report from the approved release/runtime environment:

```zsh
[ "$OPENBRAIN_COLLAB_RETIRE_RELEASE_APPROVED" = "core01-live-db-after-backup" ] || {
  echo "Blocked: not in the approved collab-retirement release/runtime environment" >&2
  exit 1
}
bun run scripts/retire-collab-migration.ts
```

- prove the migrated scope is now reconciled
- prove the audit state matches the approved classification

Minimum success conditions:

- `thoughts.unmirrored_after = 0` for scripted thought scope
- `entities.would_retag = 0`
- `lanes.would_archive = 0`
- `audit.total_out_of_scope` is `0` or exactly matches the release-owner-approved
  acknowledged classification, with each surviving row enumerated in the release
  record before fallback removal
- no newly introduced out-of-scope rows beyond that approved classification

If any success condition fails, stop and rollback using the backup/snapshot
plan before any fallback-removal deploy proceeds.

## Step 6: Fallback Removal Deploy Gate

Only after post-execute verification passes:

- follow `docs/local-release-deploy-sop.md`
- classify downstream impact with `docs/downstream-rollout.md`
- deploy the code that removes the legacy fallback

The release record must explicitly state:

- data migration executed before deploy
- fallback-removal code was not deployed against unreconciled collab data
- any temporary escape hatch env remains off unless deliberately needed for
  rollback

## Step 7: Downstream Rollout And Canary

Because this changes namespace behavior and removes a legacy read path,
downstream rollout is applicable.

Required evidence after deploy:

1. hosted Open Brain health and focused namespace smoke
2. `rtech-mcps` handoff if service/skill guidance changed
3. `mcp2cli` schema/cache refresh and representative Open Brain call
4. `rtech-hermes` runtime/plugin compatibility check if agent behavior depends
   on the retired fallback
5. live Hermes canary proving normal reads still reach `shared-kb` and do not
   depend on implicit `collab` fallback

Do not mark #167 complete on local verification alone.

## Rollback

Rollback plan must be written before execute:

- restore the DB from the verified backup or snapshot if execute produces
  unexpected audit results
- if fallback-removal code already deployed and read behavior regresses,
  redeploy the prior runtime and restore data as needed
- do not leave the system in a mixed state where fallback is removed but the
  live reconciliation is incomplete

Receipt template:

```text
Rollback:
- Trigger:
- Data restore method:
- Runtime rollback method:
- Verification after rollback:
```

## Release Receipt Template

```text
Issue #167 release preflight:
- Backup:
- Dry-run timestamp:
- Thoughts expected/observed:
- Repo facts expected/observed:
- Lanes expected/observed:
- Out-of-scope rows:
- Execute approved by:
- Execute result:
- Post-execute verification:
- Fallback-removal deploy:
- Downstream rollout:
- Canary result:
- Rollback readiness:
- Residual risk:
```
