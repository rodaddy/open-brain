# Local playground — a disposable Open Brain you can break

**Status:** RUNNING. Built and verified 2026-07-30/31.

Two Open Brain services on this machine, fully isolated:

| | real | playground |
|---|---|---|
| port | 3100 | 3101 |
| database | `open_brain_local_20260724` | `open_brain_local_play` |
| runtime | `open-brain-local/app/` | `open-brain-local/app-play/` |
| env | `open-brain-local/local-clone.env` | `open-brain-local/play.env` |
| WAL | `state/recovery.wal` | `state/recovery-play.wal` |
| log | `log/open-brain.log` | `log/open-brain-play.log` |
| launchd | `com.rico.open-brain-local-clone` | started by hand |
| purpose | Claude's real memory | break it freely |

**Both now run from `open-brain-local`, from committed revisions.** The dev
checkout serves nothing.

---

## Why this exists

Measured 2026-07-30: the real dogfood service was running `bun run src/index.ts`
with **cwd set to the dev checkout** (pid 79427, cwd
`/Volumes/ThunderBolt/Development/open-brain`). Every uncommitted edit was one
restart away from being the running memory service.

`scripts/local-clone-autostart.sh` set
`REPO_DIR=/Volumes/ThunderBolt/Development/open-brain` and then `cd`'d into it;
`scripts/local-clone.ts:397-398` spawns with `cwd: process.cwd()`, so the
running code was whatever was in the working tree at restart time.

**Fixed 2026-07-31.** The launcher now uses `RUNTIME_DIR`, defaulting to
`<clone root>/app`, populated by `scripts/local-clone-deploy.sh` from a
committed revision. The launchd plist runs the launcher from that runtime too,
so nothing in the boot path reads the working tree.

Verified after the swap: pid 46396, `cwd=/Volumes/ThunderBolt/open-brain-local/app`,
serving `a06f7ca`, turn count unchanged at 35,577 across the restart, and the
runtime contains **no `.git`** — it cannot drift, only be redeployed.

---

## Daily use

```bash
# --- the REAL service ---------------------------------------------
scripts/local-clone-deploy.sh                # deploy HEAD to app/
scripts/local-clone-deploy.sh <ref>          # deploy any commit
launchctl kickstart -k gui/$(id -u)/com.rico.open-brain-local-clone
scripts/local-clone-deploy.sh --rollback     # restore .previous

# --- the PLAYGROUND ------------------------------------------------
# deploy a COMMITTED revision into the playground
OPENBRAIN_RUNTIME_NAME=app-play \
OPENBRAIN_CLONE_ENV_FILE=/Volumes/ThunderBolt/open-brain-local/play.env \
  scripts/local-clone-deploy.sh              # HEAD
  scripts/local-clone-deploy.sh <ref>        # any commit

# re-pull fresh data from live (~3 minutes for 4 GB, live stays up)
scripts/local-clone-db.sh

# start it
cd /Volumes/ThunderBolt/open-brain-local/app-play
set -a && . /Volumes/ThunderBolt/open-brain-local/play.env && set +a
bun run src/index.ts

# throw it away
scripts/local-clone-db.sh --drop open_brain_local_play
scripts/local-clone-db.sh --list
```

---

## Only committed code deploys

`scripts/local-clone-deploy.sh` uses **`git archive <sha>`**, which reads git
object storage. The working tree is structurally invisible to it.

Proven 2026-07-30: appending a line to `src/index.ts`, then re-exporting HEAD,
produced an archive containing **zero** occurrences of it.

This differs from `scripts/core01-deploy-local.sh:136`, which tars `$REPO_DIR`
directly and therefore carries uncommitted edits. That is acceptable on core01
because an origin gate (`:58-61`) already proved HEAD is pushed; locally there
is no such gate, so the archive boundary does the work instead.

The script **reports** uncommitted paths rather than ignoring them — not
deploying them is correct, but an operator who edited a file and expected it to
ship needs to be told.

No network. `git archive` works entirely from local objects, so a commit that
exists only on this machine is deployable.

Gitignored files are absent from git objects, so `.env` **cannot** travel into a
runtime. Each runtime uses its own env file.

---

## Separate database, not a separate schema

A schema-scoped playground was considered and rejected. The repo's own migration
test says why
(`src/db/migrations/028_maintenance_jobs_lease_expired_compat.test.ts:83`):

> *"A dedicated `Client` (not a `Pool`) so the schema-scoping `search_path` set
> once at connect time holds for every query in this file. **A Pool hands out
> arbitrary connections, which would let a query leak back to public.**"*

The server runs on a `pg.Pool` (`src/db/pool.ts:19`) and sets no `search_path`;
every table reference is unqualified. A schema-scoped playground would silently
write into `public` — the live data — as soon as the pool opened a second
connection. Silent, intermittent, and pointed the wrong way.

A separate database makes that **impossible** rather than unlikely, and
`DB_NAME` is already env-driven, so it is config rather than a code change.

Schemas *inside* the playground database remain the right tool for parallel
isolated test runs — that is `Client`-based test code, the context the migration
test proves is safe.

---

## Two naming rules, both required

A playground database name must satisfy both:

1. **Contain `play`, `scratch`, or `test`** — the `--drop` guard. Stops a typo
   or stale variable from ever pointing a destructive operation at live.
2. **Start with `open_brain_local_`** — required by the runtime's fail-closed
   guard (`src/local-clone-mode.ts:154`). A name satisfying only rule 1 clones
   fine and then **cannot be served**.

Rule 2 is checked *before* the clone, so a bad name fails in 0.06s rather than
after a three-minute dump and restore.

`local-clone-mode.ts` additionally requires `DB_USER=open_brain_local_clone`,
`OPEN_BRAIN_RUN_MIGRATIONS=0`, and loopback-only `EMBEDDING_BASE_URL`. The
deploy script runs migrations itself, before the swap, which is why the runtime
flag stays `0`.

---

## Ownership is preserved, not stripped

`pg_dump`/`pg_restore` run **without** `--no-owner`/`--no-acl`.

Measured 2026-07-30: live carries **mixed ownership** — 23 `public` tables owned
by `open_brain_local_clone`, 10 by `rico`. Restoring with `--no-owner` flattened
all 33 to the invoking user, and migrations then failed with `permission denied
for table _migrations`.

The database itself is created with `-O <source owner>`, because live's `public`
schema is granted `pg_database_owner=UC` — schema rights follow database
ownership, so matching the owner needs no explicit `GRANT` that could drift.

**The clone verifies ownership, not just row counts.** Both permission failures
happened while the counts looked perfect: a clone can be complete and still be
unusable.

This works because both roles exist locally. On a host where they do not, the
restore fails — which is the correct failure, not a reason to strip ownership.

---

## `pg_dump`, not `CREATE DATABASE ... TEMPLATE`

`TEMPLATE` requires **zero** active connections to the source, and the live
service holds a pool open. Dump/restore works while live stays up, which is the
entire point.

Measured: **~3 minutes** for a 4 GB database (1.1 GB dump), zero restore errors,
live healthy throughout.

---

## Point in time, and one-directional

The clone is a snapshot. Live keeps ingesting, so the two diverge immediately —
a clone taken during this session showed `live=35208 play=35169`, the gap being
turns written during the dump.

Re-pull whenever you want current data. **Never merge playground data back into
live.** Rebuilt-schema rows flowing backward into real memory is the one outcome
that would actually cost something.

---

## Verified 2026-07-30/31

Playground isolation:
- Both services healthy simultaneously: `:3100` and `:3101`
- `pg_stat_activity`: 1 connection to real, 2 to playground — **no crossover**
- Wrote a marker row into the playground: present in play (1), **absent from
  real (0)**
- Real service undisturbed across four clone cycles
- Guards refuse: dropping the real DB, cloning to a non-disposable name,
  deploying a non-existent ref, creating an unservable name

Runtime repoint (2026-07-31):
- Before: pid 79427, `cwd=/Volumes/ThunderBolt/Development/open-brain`
- After: pid 46396, `cwd=/Volumes/ThunderBolt/open-brain-local/app`, `a06f7ca`
- `ob_raw_turns` = 35,577 before and after — **no data loss across the restart**
- Maintenance queue restarted with all five handlers
  (`embedding.repair, graph.derive, memory.distill, dream.light, dream.rem`)
- Runtime carries **no `.git`**, so it cannot be edited into drift
- Plist backed up to `_backups/com.rico.open-brain-local-clone.plist.bak-20260731`

---

**See Also:**
- `scripts/local-clone-deploy.sh` — commit → runtime
- `scripts/local-clone-db.sh` — live → playground database
- `scripts/core01-deploy-local.sh` — the production pattern this mirrors
- `docs/local-clone-dogfood.md` — the clone's own runbook
- `docs/CI_CD_REQUIREMENTS.md` — the four gates
