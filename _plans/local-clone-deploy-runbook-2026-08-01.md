# Local dogfood clone — deploy merged-main runbook (2026-08-01)

> **NOT EXECUTED against the live service. Operator go/no-go required.**
>
> Every step below was **REHEARSED on a disposable copy**
> (`open_brain_local_drift_test`, a full pg_dump/restore clone of the live
> dogfood DB taken 2026-08-01). **Nothing in this runbook was run against the
> running service `com.rico.open-brain-local-clone` (port 3100) or the live
> dogfood DB `open_brain_local_20260724`.** The commands are written for the
> operator to execute after go.
>
> **LAW-0 state key per step:** REHEARSED-on-copy = proven RUNNING against the
> disposable clone this session. WRITTEN = command composed and read from the
> proven scripts, not yet run live. The header of each step states which.
>
> **Re-verification 2026-08-01 (this rebuild).** Every load-bearing number
> below was re-checked read-only against live `open_brain_local_20260724` this
> session, and the repair SQL was re-proven on `open_brain_local_drift_test`.
> All facts held: live ledger = **50 rows**, the **4 orphans present**, repo =
> **46 migration files** (50−4=46), `ob_raw_turns` = **41,427 rows**,
> `open_brain_local_drift_test` already carries the applied repair at **46 rows
> with zero orphans**, an idempotent re-run returned **`DELETE 0`** and held at
> 46, and the DB guard **refused** and rolled back against a wrong DB
> (`open_brain_local_play`, ledger untouched at 50).

---

## TL;DR — the go/no-go summary

- **The drift is cosmetic, not blocking.** The live dogfood ledger
  (`_migrations`) carries **4 orphan rows** from renamed/abandoned migration
  lineages. They are stale bookkeeping rows; they are **not** a schema conflict.
- **`bun run migrate` runs CLEAN against the drifted DB** — proven on the copy:
  `"No new migrations to apply"`, zero applied, zero failed, clean exit. Every
  migration `main` expects (001..045) is already applied AND materialized.
- **The original alarm was a false positive.** "raw_turns table ABSENT" checked
  the wrong name: the table is `ob_raw_turns` and it is present with 41,427 rows.
- **Deploy is therefore safe WITHOUT any DB reconciliation.** The repair script
  in Step 3 is **OPTIONAL cosmetic hygiene** (make the ledger match the repo so
  future audits stop re-flagging the four rows). It is not a deploy prerequisite.
- **GO recommendation:** deploy merged main to the clone runtime via the proven
  `local-clone-deploy.sh` (Steps 2, 4). Run the ledger repair (Step 3) only if
  the operator wants the ledger to read clean. **Operator decides.**

Merged-main revision this runbook targets: **`30f22e2`** (`origin/main` as of
2026-08-01, `docs(worklog): record landing wave -- CI green, merge, client
deploy, drift flag (#457)`). The prior revision `3584527`
(`fix(local-clone): allow 0.0.0.0 bind host behind the LAN dogfood opt-in
(#456)`) is now an ancestor; the only commit between them is the #457 worklog
doc, which changes no migration or runtime code, so every migration fact in this
runbook is unchanged.

---

## Diagnosis (READ-ONLY, proven against the live DB this session)

Live dogfood DB `open_brain_local_20260724` (127.0.0.1:5432), read-only inspection.

### The drift, exactly

The ledger has **50 rows**; the repo has **46 migration files**. The 4 extras
are orphans — filenames that are **not** current repo migrations:

| Orphan ledger row | Applied | Why it is an orphan |
|---|---|---|
| `005_fts_hybrid` | 2026-03-22 17:09 | Pre-`.sql`-suffix filename. Re-applied 8 min later as `005_fts_hybrid.sql` (the current repo file). This bare row is a **stale duplicate** of an applied migration. |
| `010_chunking.sql` | 2026-05-20 | Chunking was **renumbered** to `011_chunking.sql` (applied 2026-06-08). Slot 010 on main is now `010_entity_links.sql`. |
| `033_system_facts.sql` | 2026-07-25 | From the **abandoned "code-brain" branch**. `main` uses `033_candidate_memory.sql` (applied 2026-07-27, materialized). |
| `034_memory_axes.sql` | 2026-07-25 | Same abandoned branch. `main` uses `034_content_occurrences.sql` (applied 2026-07-27, materialized). |

**History:** the DB was cloned 2026-07-24. On 2026-07-25 an abandoned code-brain
lineage (`033_system_facts`, `034_memory_axes` — from commits `caabc14`,
`26be6ab`, `0f6e209`, present only on the superseded branches
`feat/380-raw-turns-ingest` / `feat/410-uv-workspace`, never on `main`) was
applied to this DB. `main` later shipped a **different** 033/034 pair
(candidate_memory / content_occurrences), applied 2026-07-27. The migration
runner keys on exact `filename` and only ever ADDS files missing from the ledger
— it never removes extra rows — so both lineages' rows coexist harmlessly.

### What is NOT missing (alarm refuted with evidence)

- `ob_raw_turns` (what `032_raw_turns.sql` creates): **present, 41,427 rows.**
  The "raw_turns ABSENT" report checked for a table named `raw_turns`; the
  migration creates `ob_raw_turns`.
- Every repo migration filename 001..045 is in the ledger.
- Every table a **fresh-from-empty** migrate produces is present in the live DB
  (schema-diff missing-set is EMPTY). Column-level checks on
  `candidate_memory`, `ob_raw_turns`, `candidate_grade`, `content_occurrences`,
  `candidate_reinforcement` are all equivalent.

### Harmless residue left in the live DB (data, NOT touched by this runbook)

- `ob_system_facts` — 150 rows of dead code-brain data, referenced by **no**
  current source (`rg 'ob_system_facts' src/` outside migrations = none).
- `memory_axes` / `ob_memory_axes` — **do not exist** (only the ledger row
  remains; the table was never persisted or was dropped).
- `zz_test_*` (11 tables) — test scaffolding left in live by prior test runs.

None of these are referenced by merged-main runtime code. Cleaning them up is a
**separate operator-owned decision**, out of scope for this deploy.

### Deployed-app parity

The deployed runtime at `/Volumes/ThunderBolt/open-brain-local/app/src/db/migrations/`
is a **byte-identical file list** (46 `.sql` files) to the repo's
`src/db/migrations/`. The drift is purely in the live **DB ledger**, not in a
divergent migrations directory.

---

## Rehearsal outcome (proven on the disposable copy)

1. Cloned live → `open_brain_local_drift_test` via `scripts/local-clone-db.sh`
   (proven method: `pg_dump -Fc` + `pg_restore`, ownership preserved, live stays
   up). Verified: 35 tables, `ob_raw_turns` 41,427 = 41,427, ownership matches
   live (`open_brain_local_clone:23,rico:10`).
2. `bun run migrate` (DB_NAME=open_brain_local_drift_test) against the drifted
   clone → **`No new migrations to apply`**, clean exit. No failure, no blocked
   state.
3. Built a from-empty baseline (`open_brain_local_fresh_test`) by migrating an
   empty DB — all 46 files applied cleanly. Table-set diff drifted-vs-fresh:
   **missing-set EMPTY** (drifted clone has every table the code expects).
4. Applied the Step-3 repair script to the clone → `DELETE 4`, ledger 50 → 46,
   ledger now set-equals the repo migration list exactly. Idempotent re-run →
   `DELETE 0`, still 46. `bun run migrate` after repair → still
   `No new migrations to apply`. DB guard proven: the script raises and rolls
   back if run against any DB other than the live clone or the rehearsal copy.

**Re-proof 2026-08-01 (this rebuild session):** `open_brain_local_drift_test`
still exists and already carries the applied repair (46 rows, zero orphans). An
idempotent re-run this session returned `DELETE 0` and held at 46. The DB guard
was re-proven by running the script against `open_brain_local_play`: it raised
`reconcile refused: current_database() is open_brain_local_play …` and rolled
back, leaving that ledger untouched at 50.

**Rehearsal verdict: CLEAN. No blocked step. No fix required for deploy.**

---

## The deploy — ordered commands (WRITTEN; run after operator go)

All commands run from `/Volumes/ThunderBolt/Development/open-brain` unless noted.
Env/secret files are read by the scripts; **no secret is printed** by any step.

### Step 0 — pre-flight (READ-ONLY, safe to run now)

```bash
cd /Volumes/ThunderBolt/Development/open-brain

# Confirm merged main is what you intend to ship.
git fetch origin
git rev-parse --short origin/main          # expect 30f22e2 (or newer if main moved)

# Confirm the running service and its DB target (name only; no secrets echoed).
launchctl list | rg 'open-brain-local-clone'          # expect com.rico.open-brain-local-clone
curl -s --max-time 5 http://127.0.0.1:3100/health | rg -o '"status":"[a-z]*"'   # expect "status":"healthy"
rg -n '^DB_NAME|^PORT' /Volumes/ThunderBolt/open-brain-local/local-clone.env    # DB_NAME=open_brain_local_20260724 PORT=3100
```

**LAW-0:** REHEARSED-on-copy for the DB inspection; the service/health probes are
WRITTEN read-only commands.

### Step 1 — snapshot the live DB (rollback point) — REQUIRED before any DB write

Only needed if you will run Step 3 (the ledger repair). If you deploy WITHOUT the
repair, no DB write happens and this snapshot is optional insurance.

```bash
# Custom-format dump into the existing backups convention. Live service stays up.
# This is the same dump method local-clone-db.sh uses and is proven safe live.
pg_dump -Fc -d open_brain_local_20260724 \
  -f "/Volumes/ThunderBolt/open-brain-local/_backups/open_brain_local_20260724-pre-repair-$(date -u +%Y%m%dT%H%M%SZ).dump"
```

**LAW-0:** WRITTEN. `pg_dump -Fc` against live is the exact method the rehearsal
clone used successfully this session (read-only on live; produces a file).
Restore path is in Step 6.

### Step 2 — deploy merged main to the clone runtime (source sync)

Uses the proven `scripts/local-clone-deploy.sh` — **do NOT hand-roll rsync.**
It `git archive`s the committed ref (working-tree edits are structurally
excluded), `bun install --frozen-lockfile`, runs `bun run migrate` against the
clone DB, atomic-swaps `app` ← staging (old `app` → `app.previous`), restarts
the launchd service, health-checks, and auto-rolls-back on health failure.

```bash
cd /Volumes/ThunderBolt/Development/open-brain

OPENBRAIN_SERVICE_LABEL=com.rico.open-brain-local-clone \
  scripts/local-clone-deploy.sh origin/main
```

Expected: `deployed <sha> to /Volumes/ThunderBolt/open-brain-local/app` and
`post-deploy health check passed on port 3100`. The embedded
`bun run migrate` will log **`No new migrations to apply`** (proven on the copy).

**LAW-0:** WRITTEN. The embedded migrate step is REHEARSED-on-copy (clean no-op).
The source-swap/restart is WRITTEN — read from the proven script, not run live.

### Step 3 — reconcile the ledger (OPTIONAL, cosmetic)

**Skip this unless the operator wants the ledger to read clean.** Deploy in
Step 2 succeeds and the service runs correctly with the four orphan rows still
present (proven). Run this only to make `_migrations` match the repo so a future
file-by-file audit stops re-flagging them.

```bash
cd /Volumes/ThunderBolt/Development/open-brain

# Idempotent, transactional, self-guarding: refuses any DB except the live clone
# or the rehearsal copy, and rolls back if the post-count isn't exactly 46.
psql -v ON_ERROR_STOP=1 -d open_brain_local_20260724 \
  -f src/db/migrations/repair/2026-08-01_reconcile_local_clone_ledger.sql
```

Expected: `DELETE 4`, then `COMMIT`. Re-running is safe (`DELETE 0`).

**LAW-0:** REHEARSED-on-copy — this exact script ran on
`open_brain_local_drift_test` (`DELETE 4` → 46 rows → idempotent `DELETE 0`), and
its DB guard was proven to refuse and roll back on the wrong database. NOT run
against live. **Note:** the script lives under `src/db/migrations/repair/`, a
subdirectory the migration runner (`src/db/migrate.ts`) and the census
(`src/operator-doctor.ts`) never see — both do a **non-recursive** `readdir` +
`.endsWith(".sql")`, so a subdirectory named `repair` is skipped. Placing it
there means it can never be auto-applied by `bun run migrate`; it is
operator-run, by hand, only.

### Step 4 — health checks (post-deploy)

```bash
# Service healthy, DB connected, embedding connected.
curl -s http://127.0.0.1:3100/health | rg -o '"status":"[a-z]*"|"connected":(true|false)'

# Ledger sanity: if Step 3 was run, expect 46 rows and no orphans.
set -a; . /Volumes/ThunderBolt/Development/open-brain/.env; set +a
psql -At -d open_brain_local_20260724 -c "SELECT count(*) FROM _migrations;"
psql -At -d open_brain_local_20260724 -c \
  "SELECT filename FROM _migrations WHERE filename IN ('005_fts_hybrid','010_chunking.sql','033_system_facts.sql','034_memory_axes.sql');"

# Data intact: raw turns still present (the table is ob_raw_turns).
psql -At -d open_brain_local_20260724 -c "SELECT count(*) FROM ob_raw_turns;"

# Deployed revision stamp matches what you shipped.
cat /Volumes/ThunderBolt/open-brain-local/app/.deployed-revision
```

Expected: `"status":"healthy"`, DB+embedding `connected":true`; if Step 3 ran,
`_migrations` = 46 and the orphan query returns empty; `ob_raw_turns` count
unchanged from Step 0 (41,427); `.deployed-revision` shows the shipped sha.

**LAW-0:** REHEARSED-on-copy for the ledger/data checks; the /health probe is
WRITTEN.

### Step 5 — dogfood smoke (optional, normal production traffic)

A provider capture is normal dogfood traffic and persists a distilled event in
`ob_session_events`; it does **not** ingest a row into `ob_raw_turns`. If the
operator wants a live round-trip proof, fire one normal capture, require a
`saved` / `durable` receipt, retain its `event_id`, and verify that exact row:

```bash
set -a; . /Volumes/ThunderBolt/Development/open-brain/.env; set +a
psql -At -d open_brain_local_20260724 -c \
  "SELECT id, event_type, created_at FROM ob_session_events WHERE id = '<event_id-from-receipt>';"
```

Keep `ob_raw_turns` checks for smokes that actually exercise raw-turn ingestion;
a distilled provider capture is not one of those operations. This is production
write behavior, not a schema mutation.

**Corrected from live evidence 2026-08-02:** the capture receipt reported
`saved` / `durable`, `ob_raw_turns` changed by 0, and the persisted event was
present in `ob_session_events` as
`2496e009-a2a3-48af-9aa5-6ea1996c9c1a`.

### Step 6 — rollback (if anything is wrong)

Two independent rollback axes — **runtime** and **DB** — because they fail
independently.

**Runtime rollback** (restores the previous `app` directory + restarts):

```bash
cd /Volumes/ThunderBolt/Development/open-brain
OPENBRAIN_SERVICE_LABEL=com.rico.open-brain-local-clone \
  scripts/local-clone-deploy.sh --rollback
# Restores /Volumes/ThunderBolt/open-brain-local/app from app.previous.
```

**DB rollback** (only relevant if Step 3 was run and must be undone). The repair
only DELETEs 4 bookkeeping rows and touches no data, so the cheapest undo is to
re-insert them; a full restore from the Step-1 dump is the heavy option.

Cheap undo (re-insert the 4 orphan ledger rows — restores exact pre-repair state):

```bash
set -a; . /Volumes/ThunderBolt/Development/open-brain/.env; set +a
psql -v ON_ERROR_STOP=1 -d open_brain_local_20260724 <<'SQL'
INSERT INTO _migrations (filename) VALUES
  ('005_fts_hybrid'), ('010_chunking.sql'),
  ('033_system_facts.sql'), ('034_memory_axes.sql')
ON CONFLICT (filename) DO NOTHING;
SQL
```

Heavy undo (full restore from the Step-1 snapshot — operator-run, stops the
service first; a restore is destructive to the current DB so **Rico runs it**):

```text
# Operator-owned. Stop com.rico.open-brain-local-clone, then:
#   pg_restore --clean --if-exists -d open_brain_local_20260724 <the pre-repair .dump>
# Restart the service and re-run Step 4. (Left as prose: a --clean restore drops
# objects, so it is Rico's call and Rico's hand.)
```

**LAW-0:** The runtime `--rollback` and the row re-insert are WRITTEN (composed
from the proven script and the exact orphan set diagnosed this session). The full
DB restore is intentionally left as operator-run prose because it is destructive.

---

## Cleanup after the operator is done

Disposable scratch databases were created on `127.0.0.1:5432` for this
rehearsal and can be dropped once the operator no longer needs them:

- `open_brain_local_drift_test` — the full live clone used for rehearsal.
- `open_brain_local_fresh_test` — the from-empty schema baseline.

```bash
# Agent does NOT run forced/destructive deletes. Operator drops these:
cd /Volumes/ThunderBolt/Development/open-brain
scripts/local-clone-db.sh --drop open_brain_local_drift_test
scripts/local-clone-db.sh --drop open_brain_local_fresh_test
```

Both names contain `test`, so the script's disposable-name guard accepts them and
its live-DB guard still refuses the real dogfood DB.

---

## Provenance

- Diagnosis: read-only psql against live `open_brain_local_20260724`,
  `src/db/migrate.ts`, `src/operator-doctor.ts`, git history of the abandoned
  code-brain migrations. RUNNING-verified this session (2026-08-01).
- Rehearsal: `open_brain_local_drift_test` full clone; migrate + repair proven on
  it. RUNNING-verified this session — the repair was re-proven idempotent
  (`DELETE 0`, 46 rows) and the DB guard re-proven to refuse a wrong DB.
- Repair script: `src/db/migrations/repair/2026-08-01_reconcile_local_clone_ledger.sql`.
- **Live service and live DB: untouched. Operator go/no-go required.**
