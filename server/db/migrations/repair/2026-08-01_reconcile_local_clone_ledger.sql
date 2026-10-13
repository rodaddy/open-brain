-- Repair: reconcile the local dogfood clone's _migrations ledger with the repo.
--
-- STATUS: WRITTEN + REHEARSED-on-copy 2026-08-01. NOT executed against the live
-- dogfood DB (open_brain_local_20260724). Operator go/no-go required.
--
-- WHAT THIS IS (and is NOT):
--   This is COSMETIC ledger hygiene, NOT a deploy prerequisite. Proven on the
--   rehearsal clone open_brain_local_drift_test 2026-08-01: `bun run migrate`
--   against the drifted ledger reports "No new migrations to apply" and exits
--   clean WITHOUT this repair. operator-doctor.ts reports status "current"
--   because it only counts repo files that are NOT applied (pending); extra
--   ledger rows are ignored. So the service deploys and runs correctly with or
--   without this script. Run it only to make the ledger MATCH the repo so a
--   future file-by-file audit stops re-flagging the same four rows.
--
-- WHY THE DRIFT EXISTS (history, verified from ledger applied_at + git log):
--   The dogfood DB open_brain_local_20260724 was cloned 2026-07-24 and carries
--   ledger rows from lineages that were later renamed or abandoned on main:
--     - 005_fts_hybrid        applied 2026-03-22 17:09  (pre-".sql" filename;
--                             re-applied 8 min later as 005_fts_hybrid.sql,
--                             which IS the current repo file -- so this bare row
--                             is a stale duplicate of an applied migration)
--     - 010_chunking.sql      applied 2026-05-20        (chunking was renumbered
--                             to 011_chunking.sql, applied 2026-06-08; 010 is
--                             now 010_entity_links.sql on main)
--     - 033_system_facts.sql  applied 2026-07-25        (abandoned "code-brain"
--     - 034_memory_axes.sql   applied 2026-07-25         branch; main uses
--                             033_candidate_memory.sql / 034_content_occurrences.sql
--                             instead -- both applied 2026-07-27 and materialized)
--
--   None of these four filenames exist in src/db/migrations/ on main. Every
--   filename that DOES exist on main (001..045) is already in the ledger and its
--   schema is materialized (proven: table set of the drifted clone is a superset
--   of a fresh-from-empty migrate, with an EMPTY missing-set).
--
-- WHAT THIS SCRIPT TOUCHES:
--   ONLY rows in the _migrations bookkeeping table whose filename is NOT a
--   current repo migration. It removes stale ledger ROWS only. It does NOT drop,
--   alter, or truncate any data table -- not ob_system_facts (150 rows of dead
--   code-brain data, referenced by NO current source), not the zz_test_* tables.
--   Dead-table cleanup, if ever wanted, is a SEPARATE operator-owned decision;
--   this script deliberately leaves all data in place.
--
-- IDEMPOTENT: a second run deletes nothing (the rows are already gone) and the
--   guard block still passes. Safe to re-run.

BEGIN;

-- Guard: refuse to run against the wrong database. The local clone that carries
-- this exact drift is open_brain_local_20260724; the rehearsal copy is
-- open_brain_local_drift_test. Anything else, abort loudly rather than edit a
-- ledger we did not diagnose.
DO $$
BEGIN
  IF current_database() NOT IN (
    'open_brain_local_20260724',
    'open_brain_local_drift_test'
  ) THEN
    RAISE EXCEPTION
      'reconcile refused: current_database() is %, expected the dogfood clone '
      'open_brain_local_20260724 or the rehearsal copy open_brain_local_drift_test',
      current_database();
  END IF;
END $$;

-- Remove ONLY the four orphan ledger rows, each named explicitly. An orphan is a
-- ledger filename that is not a current repo migration; these four are the exact
-- set diagnosed 2026-08-01. Naming them (rather than a computed "anything not in
-- the repo") keeps the blast radius auditable and stops a future unrelated row
-- from being swept by a broad predicate.
DELETE FROM _migrations
WHERE filename IN (
  '005_fts_hybrid',       -- stale pre-.sql duplicate of applied 005_fts_hybrid.sql
  '010_chunking.sql',     -- renumbered to 011_chunking.sql
  '033_system_facts.sql', -- abandoned code-brain branch; main uses 033_candidate_memory.sql
  '034_memory_axes.sql'   -- abandoned code-brain branch; main uses 034_content_occurrences.sql
);

-- Post-condition assertion: after this runs, the ledger must contain EXACTLY the
-- current repo migration set and nothing else. This is proven at repair time,
-- not trusted. The expected count (46) is the number of *.sql files in
-- src/db/migrations/ on main as of 2026-08-01 (001..045, where 006 and the
-- paired 010 names mean the count is 46 rather than 45 -- verified with
-- `ls src/db/migrations/*.sql | wc -l` = 46, and the pre-repair ledger of 50
-- minus these 4 orphans = 46, which set-equals the repo file list exactly).
-- If the count is wrong, ABORT so the transaction rolls back and nothing is
-- committed on a surprise.
DO $$
DECLARE
  ledger_count INTEGER;
BEGIN
  SELECT count(*) INTO ledger_count FROM _migrations;
  IF ledger_count <> 46 THEN
    RAISE EXCEPTION
      'reconcile post-condition failed: _migrations has % rows after cleanup, '
      'expected 46 (the current repo migration set). Rolling back.',
      ledger_count;
  END IF;
END $$;

COMMIT;
