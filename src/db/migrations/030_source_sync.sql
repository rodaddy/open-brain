-- Migration 030: Resumable file-source synchronization substrate (Issue #338)
--
-- Builds the durable, content-free state a resumable sync needs on top of the
-- approved-source registry (migration 027, ob_sources). Two tables:
--
--   ob_source_files      the file MANIFEST: one row per durably-identified file
--                        observed under a registered source. Carries a stable
--                        per-file identity (file_id) that survives a rename, the
--                        current content-free path/hash, and a reconciliation
--                        state. NEVER a file body.
--
--   ob_source_sync_runs  the CHECKPOINT: one row per sync run for a source. It
--                        persists the ordered reconciliation plan and how far it
--                        has been committed (checkpoint_index), so an interrupted
--                        run resumes at the exact op it stopped on and re-applies
--                        the tail idempotently (at-least-once) without duplicates.
--
-- Isolation: both tables carry the source's EXACT namespace + scope, copied at
-- creation and never widened. Every read/mutation in src/source-sync.ts is
-- namespace-qualified and gated by canWriteNamespace, so two namespaces that
-- registered the same external location keep entirely separate manifests.
--
-- Content safety: paths and content_hash are opaque locators/digests, not
-- bodies. content_hash is the lowercase 64-char sha256 hex digest hashSourceContent()
-- emits. Nothing here stores or logs file contents.

-- The file manifest. Durable per-file identity is file_id (a UUID minted once and
-- preserved across renames); the (source_id, path) pair is the CURRENT locator
-- and moves when a file is renamed. Only a LIVE (state <> 'deleted') file may
-- occupy a path, so a path is unique among live files under one source.
CREATE TABLE IF NOT EXISTS ob_source_files (
  file_id       UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- The owning registered source. Cascade-clean when a source row is hard-deleted
  -- (the registry only soft-deletes, so this is a safety net, not a normal path).
  source_id     UUID NOT NULL
                REFERENCES ob_sources (id) ON DELETE CASCADE,

  -- Inherited EXACTLY from the owning source at manifest-row creation. The
  -- isolation boundary: never widened, always used as a predicate.
  namespace     TEXT NOT NULL,
  scope         JSONB NOT NULL DEFAULT '{}'::jsonb,

  -- Current content-free locator + digest of the file's last-observed content.
  -- path is opaque (a repo-relative path); content_hash is a lowercase sha256 hex
  -- digest. Neither is a body.
  path          TEXT NOT NULL,
  content_hash  TEXT NOT NULL
                CHECK (content_hash ~ '^[0-9a-f]{64}$'),

  -- Reconciliation state. 'live' files are present in the source; 'deleted' files
  -- were reconciled away (soft delete) but their identity row is retained so a
  -- later re-add can be recognized and provenance is preserved.
  state         TEXT NOT NULL DEFAULT 'live'
                CHECK (state IN ('live', 'deleted')),

  -- The sync run that last mutated this manifest row. Content-free provenance so a
  -- resume can tell whether a row already reflects the current run's plan.
  last_run_id   UUID,

  revision      INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One live file per (source, path). A 'deleted' row does NOT reserve its old
-- path, so a new file can take a freed path and a rename can move onto a path the
-- prior occupant just vacated. Partial on state = 'live'.
CREATE UNIQUE INDEX IF NOT EXISTS idx_ob_source_files_live_path
  ON ob_source_files (source_id, path)
  WHERE state = 'live';

-- Rename detection and per-source scans both walk by (source_id, content_hash).
CREATE INDEX IF NOT EXISTS idx_ob_source_files_source_hash
  ON ob_source_files (source_id, content_hash);

CREATE INDEX IF NOT EXISTS idx_ob_source_files_namespace
  ON ob_source_files (namespace, source_id);

-- The sync-run checkpoint. Each run captures the ordered, content-free
-- reconciliation plan (an array of ops) and a monotonic checkpoint_index marking
-- how many ops have been durably applied. Resume reads the row, re-applies from
-- checkpoint_index onward, and every op is idempotent so an at-least-once replay
-- of the boundary op converges without duplicating manifest state.
CREATE TABLE IF NOT EXISTS ob_source_sync_runs (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  source_id     UUID NOT NULL
                REFERENCES ob_sources (id) ON DELETE CASCADE,

  -- Inherited EXACTLY from the owning source. Same isolation contract as above.
  namespace     TEXT NOT NULL,
  scope         JSONB NOT NULL DEFAULT '{}'::jsonb,

  -- Binds the run to the exact observed corpus it was planned for: the sha256 of
  -- the canonical observation set. A resume with the SAME observation resolves to
  -- the same run row (idempotent planning); a changed observation is a new run.
  observation_hash TEXT NOT NULL
                CHECK (observation_hash ~ '^[0-9a-f]{64}$'),

  -- The ordered reconciliation plan. Content-free op descriptors only (op kind,
  -- durable file_id, content-free path/hash), never a body. Fixed once planned.
  plan          JSONB NOT NULL DEFAULT '[]'::jsonb
                CHECK (jsonb_typeof(plan) = 'array'),

  -- How many plan ops have been durably committed. Advances monotonically as the
  -- run applies ops; equals jsonb_array_length(plan) when the run is complete.
  checkpoint_index INTEGER NOT NULL DEFAULT 0 CHECK (checkpoint_index >= 0),

  -- Run lifecycle. 'running' is resumable; 'completed' is terminal (all ops
  -- applied). No content is stored on either.
  status        TEXT NOT NULL DEFAULT 'running'
                CHECK (status IN ('running', 'completed')),

  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- A source has at most ONE run per observed corpus. Re-planning the same
  -- observation (e.g. a crash before the run was marked complete) resolves to the
  -- existing run row and resumes it, rather than forking a duplicate plan.
  UNIQUE (source_id, observation_hash)
);

CREATE INDEX IF NOT EXISTS idx_ob_source_sync_runs_resumable
  ON ob_source_sync_runs (source_id, created_at)
  WHERE status = 'running';

CREATE INDEX IF NOT EXISTS idx_ob_source_sync_runs_namespace
  ON ob_source_sync_runs (namespace, source_id);

-- Reuse the shared updated_at trigger function (defined in 001_init.sql).
DROP TRIGGER IF EXISTS trg_ob_source_files_updated_at ON ob_source_files;
CREATE TRIGGER trg_ob_source_files_updated_at
  BEFORE UPDATE ON ob_source_files
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

DROP TRIGGER IF EXISTS trg_ob_source_sync_runs_updated_at ON ob_source_sync_runs;
CREATE TRIGGER trg_ob_source_sync_runs_updated_at
  BEFORE UPDATE ON ob_source_sync_runs
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();
