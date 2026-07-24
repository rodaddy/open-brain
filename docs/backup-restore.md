# Backup and Restore

Operator-run backup/restore substrate for the Open Brain database (issue
#298). Three CLIs — `scripts/backup.ts`, `scripts/backup-verify.ts`,
`scripts/restore.ts` — plus a content-free manifest format
(`openbrain.backup_manifest.v1`) and a live restore drill that runs in CI.
For the loopback-only dogfood clone procedure, see
[`local-clone-dogfood.md`](local-clone-dogfood.md).

Everything here is honest about its verification level: each procedure is
marked **TESTED** (with the test that proves it) or **DOCUMENTED-ONLY**.

## Requirements

| Requirement | Value | Rationale |
|---|---|---|
| RPO (max acceptable loss window) | **24 hours** | LAN-local, single-operator deployment on core01. Durable memory accretes at human pace (session lanes, thoughts, promotions); a day of loss is recoverable from client spools, session transcripts, and qmd-derived facts. Sub-daily backup adds operational surface without a matching risk. |
| RTO (max acceptable restore time) | **1 hour** | createdb + verify + `pg_restore` + forward migrations on the current data volume completes in minutes; one hour budgets operator time, a re-point of the launchd service, and a smoke check. |
| Retention | **7 daily + 4 weekly** | One week of fine-grained rollback for bad writes/migrations, one month of coarse history for slow-burn corruption. Retention pruning is operator-run (see stale-backup alerting below); the verify CLI treats every set in the backups root independently. |
| Encryption | **REQUIRED for any off-host copy; NOT applied at rest locally.** Local at-rest encryption is intentionally not layered on, per the standing LAN-local policy: local infra is not over-secured with ceremonies that add failure modes without threat-model backing (same policy as no pre-prod key rotation). Any copy that leaves the host (cloud, portable disk, another site) MUST be encrypted first, e.g. `tar -C <backups-root> -cf - <set-dir> \| age -r <recipient> > set.tar.age` (or `openssl enc -aes-256-cbc -pbkdf2` where `age` is unavailable). |
| Integrity | sha256 per file recorded in the manifest at backup time; `backup-verify` re-hashes and compares before ANY restore mutation. Restore refuses any set with a failed verdict. |
| Off-host independence | A backup set is fully self-contained: `openbrain.dump` (pg_dump custom format) + `manifest.json`. Nothing in the set references live host state; it restores on any host with Postgres 18 + pgvector and this repo checked out. |

## Backup Set Layout

```
<set-dir>/
  openbrain.dump   pg_dump -Fc of the configured database
  manifest.json    openbrain.backup_manifest.v1 (content-free)
```

The manifest records: schema id, created_at, source provenance (db host/port,
db name, hostname — never credentials), applied-migrations head + full list,
contract version + schema hash (from `src/contract.ts`), embedding
model/dimensions/halfvec marker, pgvector extension version, per-file sha256 +
sizes, per-table row counts, per-table archived-row counts, and the
distinct-namespace COUNT. Namespace names are scope metadata and never appear
in manifests or receipts; the namespace boundary itself lives inside the dump
(every row keeps its `namespace` column) and is re-validated on restore.

A backup set is one coordinated snapshot: `openbrain.dump` and its
`manifest.json` must be created together by one successful `backup.ts` run and
transferred together without substitution. Never assemble a clone from files
belonging to different sets.

## Operations

All commands use the repo pool env (`DB_HOST`, `DB_USER` required; `DB_NAME`
default `open_brain`; `DB_PORT`, `DB_PASSWORD`). Passwords reach the child
`pg_dump`/`pg_restore` only via the `PGPASSWORD` environment variable, never
argv, and never appear in receipts.

### One-command backup — TESTED (`backup restore drill (live Postgres, #298)`, `scripts/__tests__/backup-restore-live.test.ts`)

```bash
DB_HOST=127.0.0.1 DB_USER=openbrain DB_NAME=open_brain \
  bun run scripts/backup.ts --out /Volumes/ThunderBolt/open-brain/backups/$(date +%Y%m%d-%H%M%S)
```

Non-mutating for the source (pg_dump reads only). Refuses to overwrite an
existing set without `--force`. Emits a single-line content-free receipt
(`openbrain.backup_receipt.v1`) on stdout.

### Verify — TESTED (same drill + `scripts/backup-lib.test.ts` corruption classes)

```bash
# One set:
bun run scripts/backup-verify.ts --dir <set-dir>
# All sets under a backups root, with a staleness gate:
bun run scripts/backup-verify.ts --dir <backups-root> --max-age-hours 26
```

Detects, distinctly: missing manifest/dump, unparseable manifest, unknown
schema id, missing fields (including manifest file names that are not bare
filenames — path-traversal entries are schema-rejected), checksum mismatch
(corruption), size mismatch (truncation), unexpected extra files,
dump-modified-after-manifest drift, and a future-dated `created_at`
(`future_dated_timestamp` — an invalid set that can never satisfy the
staleness window).
Compatibility against the CURRENT runtime: `restorable_with_migrations`
requires the backup's sorted applied-migrations list to be an exact PREFIX of
the repo's sorted list; a mid-sequence gap (e.g. 001,003 applied against repo
001,002,003) FAILS CLOSED as `incompatible_interleaved` because forward
migration would run the missing file out of order; unknown/newer migrations
FAIL CLOSED; an older contract version warns; a newer or unparseable contract
FAILS CLOSED; an embedding model/dimension mismatch FAILS CLOSED unless
`--allow-embedding-mismatch` (re-embedding is not built — mismatched vectors
silently corrupt retrieval). Exit codes: 0 passed/warned, 1 failed, 2 usage,
3 stale.

### Restore — TESTED (same drill, including refusal paths)

```bash
createdb -h 127.0.0.1 -U openbrain open_brain_restored
bun run scripts/restore.ts --dir <set-dir> \
  --target-db-url postgres://openbrain@127.0.0.1:5432/open_brain_restored
```

Prefer a PASSWORDLESS `--target-db-url` and supply the credential via the
`DB_PASSWORD` (or `PGPASSWORD`) environment variable, as above — an inline
URL password lands in argv/shell history and is accepted only for scratch/CI
targets.

Fail-closed, no partial success:

1. The target database is always EXPLICIT (`--target-db-url` or
   `--target-db`); there is no default.
2. The full verify pass runs first; any failed verdict aborts before the
   target is touched.
3. A target containing user tables in any schema OTHER than `public` is
   refused outright, even with wipe approval — the approved wipe drops schema
   `public` only, so restore targets must be scratch databases or
   public-schema-only. A non-empty `public` schema is refused unless
   `--wipe-target` is passed AND
   `OPENBRAIN_RESTORE_WIPE_APPROVED=wipe-target-database-after-verified-backup`
   is set. Any non-local target host additionally requires
   `OPENBRAIN_RESTORE_REMOTE_APPROVED=restore-remote-target-approved`
   (the `retire-collab-migration.ts` approval pattern).
4. After `pg_restore`, post-restore validation must fully pass: applied
   migrations match the manifest; per-table row counts match EXACTLY;
   archived-row counts match exactly and archived rows stay archived;
   distinct-namespace count matches; namespace predicate columns exist;
   pgvector extension + `halfvec(768)` embedding column present; then, if the
   backup head is older than the repo head, migrations run forward and the
   final applied set must equal the repo set; finally a writability probe
   (BEGIN / temp-table INSERT / ROLLBACK).
5. Any validation failure → receipt status `failed`, nonzero exit. The
   receipt includes a `rollback_hint`: drop the target database; the source
   backup set is never mutated.
6. Receipts stay content-free even on failures: child `pg_dump`/`pg_restore`
   stderr is NEVER passed through (a mid-COPY failure embeds literal row data
   in `CONTEXT`/`COPY`/`DETAIL` lines) — only the exit code plus a sanitized
   error class (first stderr line, cut before any `:` or quote) survives, and
   failed validation details carry the pg error code / error name only, never
   `err.message`. A failed `pg_dump` also removes its partial dump file so a
   retry is not blocked behind `--force`.

### Stale-backup alerting — DOCUMENTED-ONLY (mechanism TESTED, scheduling deferred)

`backup-verify --dir <backups-root> --max-age-hours N` exits 3 with a `stale`
status when the newest VALID backup is older than N hours (a corrupt set does
not count as a valid backup — TESTED in `scripts/backup-lib.test.ts`). Wire
it into cron/launchd on core01 and alert on nonzero exit; the actual launchd
plist/notification wiring is deliberately left to the operator runbook and is
NOT shipped in this repo (scripts stay operator-run, no service wiring).

## Server Data vs Client Adapter State

Two independent restore layers compose:

- **Server layer (this document):** the Postgres database — thoughts, lanes,
  events, entities, namespaces. Restored via the CLIs above.
- **Client layer:** the Development repo's
  `_ob/scripts/ob-memory-provider/activate-claude.ts` writes a per-activation
  client-side restore manifest (`development.openbrain-memory-restore.v3`,
  mode 0600, plus a ready-to-run `restore-command.txt`) capturing the Claude
  adapter state it replaced. That layer restores client adapter wiring, not
  memory data.

They compose cleanly because authority does not overlap: the server restore
brings back durable memory and session lanes; the client manifest brings back
the adapter configuration that points agents at the server. After a server
restore, clients reconnect with their existing tokens and namespaces — no
client-side data migration is involved.

## Deletion, Redaction, and Retention Semantics

- **Hard-deleted rows cannot be resurrected.** They are simply absent from
  the dump. TESTED: the live drill hard-deletes a seeded row before backup
  and asserts it is absent after restore.
- **Archived rows restore AS archived.** `archived_at` soft-delete markers
  survive the round trip; the restore validation requires archived counts to
  match exactly. TESTED in the live drill.
- **Spool replay after restore cannot resurrect prohibited content.** Client
  spools store REDACTED content and replay under parked exact scope with
  `_parked_namespace` provenance; quarantine records and drain receipts are
  content-free (see `docs/memory-contract.md` — "Spool Replay: Quarantine and
  Delivery Semantics (#296)" and the spool-replay row of "Operational-Path
  Isolation Disposition (#297)"). A drain landing on a restored database
  therefore re-delivers at most already-redacted session records.
- **Retention pruning** (7 daily + 4 weekly) removes whole backup sets;
  because sets are self-contained, pruning one set never affects another.

## Upgrade Matrix

| Scenario | Support | Status |
|---|---|---|
| Old backup → upgraded runtime | **Supported** when the backup's sorted applied-migrations list is an exact PREFIX of the repo's sorted list. Verify reports `restorable_with_migrations`; restore replays the dump, then runs the standard migration path forward and requires the final head to equal the repo head. A mid-sequence gap fails closed as `incompatible_interleaved` (forward migration would apply the missing file out of order). | **TESTED** — "old backup (pre-latest-migration) restores into the upgraded runtime and the head advances", `scripts/__tests__/backup-restore-live.test.ts` |
| Backup during an upgrade | **NOT SUPPORTED.** Take backups only at rest (service stopped or no migration in flight). A dump taken mid-migration can capture a half-applied schema whose `_migrations` rows do not describe it; verify cannot detect this from the outside. | DOCUMENTED-ONLY (by construction, not drilled) |
| Interrupted upgrade | Restore the last at-rest backup into a CLEAN database, let restore run migrations forward, re-point the service, drop the broken database. | DOCUMENTED-ONLY (the underlying restore+migrate mechanics are the TESTED old-backup drill) |
| Rollback after a bad upgrade | Check out the pre-upgrade code, restore the pre-upgrade backup into a CLEAN database (verify runs under the old runtime, so heads match), re-point the service. Never restore over the upgraded database in place. | DOCUMENTED-ONLY (restore mechanics TESTED; the code-checkout/service-repoint procedure is operational) |
| Newer backup → older runtime | **REFUSED.** Unknown migrations and newer contract versions fail closed at verify. | TESTED — compatibility matrix, `scripts/backup-lib.test.ts` |
| Client reconnect after restore | Clients reconnect by bearer token + namespace; session lanes and events are restored, so context-pack recall and lane appends resume. | **TESTED** (server side) — the live drill appends a session event to a restored lane, proving a client drain would land. The full python-client replay drill is deferred. |

## CI Drill

The `db-integration` job runs the live drill on every push/PR against the
ephemeral pgvector Postgres, using `docker exec` pg tools matched to the
pinned pg18 image and dedicated `open_brain_ci_restore_*` scratch databases
(created and dropped by the test) so the main CI databases are never touched.
`OPENBRAIN_BACKUP_DRILL=1` makes the drill mandatory in that step: missing
prerequisites fail loudly instead of skipping.
