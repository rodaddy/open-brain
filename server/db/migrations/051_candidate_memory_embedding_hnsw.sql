-- Issue 1488: candidate dedupe (server/domain/candidate-dedupe.ts) finds each
-- duplicate's nearest older survivor by an ordered nearest-neighbour lookup.
-- Without an index that lookup is a join over every unreviewed embedded
-- candidate (~295k on dogfood, ~59M distance ops per REM pass).
--
-- Partial because dedupe only ever reads unreviewed, embedded rows.
-- SET LOCAL maintenance_work_mem so the HNSW build does not spill at the 64MB
-- server default.
--
-- The migration runner wraps each file in a transaction
-- (server/db/migrate.ts), so this build holds a write lock on candidate_memory
-- for its duration: on a populated database, run it with the service stopped.
--
-- SET LOCAL statement_timeout = 0 because the pool's 30 s statement timeout
-- (server/db/pool.ts) cancelled this build on a 294k-row playground copy of
-- dogfood on 2026-09-25; both settings end with this migration's transaction.
SET LOCAL maintenance_work_mem = '1GB';
SET LOCAL statement_timeout = 0;

CREATE INDEX IF NOT EXISTS candidate_memory_embedding_unreviewed_hnsw
  ON candidate_memory USING hnsw (embedding halfvec_cosine_ops)
  WITH (m = 16, ef_construction = 200)
  WHERE reviewed_at IS NULL AND embedding IS NOT NULL;
