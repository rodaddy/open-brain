-- Migration 027: Namespace-bound approved-source registry (Issue #337, SOURCE-1)
--
-- The registry is the single server-side allowlist for ingestion: only an
-- approved registry entry makes a source location eligible to be ingested.
-- Unregistered or unapproved locations are rejected server-side, so a
-- caller-supplied "approved" flag can never authorize ingestion on its own.
--
-- Isolation: every registry row carries an exact namespace (and optional
-- session scope). All identity, read, update, and delete paths are
-- namespace-qualified in src/source-registry.ts; the UNIQUE(namespace,
-- source_kind, external_id) key makes the immutable external identity unique
-- WITHIN a namespace only, so two namespaces may register the same external
-- location without colliding or leaking across the boundary.
--
-- Content safety: this table stores identity, state, and content-free hash /
-- timestamp metadata only. It never stores raw source bodies. content_hash is
-- an opaque digest; language/config are structural, not content.

CREATE TABLE IF NOT EXISTS ob_sources (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Exact isolation boundary. namespace is the physical namespace; scope is an
  -- optional finer session/source scope (kept as content-free JSONB keys).
  namespace     TEXT NOT NULL,
  scope         JSONB NOT NULL DEFAULT '{}'::jsonb,

  -- Source kind (collector family) and immutable external identity. external_id
  -- is the stable, opaque external locator (e.g. a repo URL, directory path,
  -- drop id); it is immutable once created and unique within a namespace+kind.
  source_kind   TEXT NOT NULL
                CHECK (source_kind IN ('git', 'directory', 'drop', 'conversation')),
  external_id   TEXT NOT NULL,

  -- Human-facing label (not content). Optional.
  title         TEXT,

  -- Approval state. Server-authored: a caller cannot set this to 'approved'
  -- without an authorized role (enforced in src/source-registry.ts). Pending
  -- and rejected sources are NOT eligible for ingestion.
  approval_state TEXT NOT NULL DEFAULT 'pending'
                CHECK (approval_state IN ('pending', 'approved', 'rejected')),
  approved_by    TEXT,
  approved_at    TIMESTAMPTZ,

  -- Lifecycle / synchronization state. 'active' is the normal registered
  -- state; 'paused' suspends sync; 'retired' is a soft delete. sync_state
  -- tracks the last sync outcome without storing any synced content.
  lifecycle_state TEXT NOT NULL DEFAULT 'active'
                CHECK (lifecycle_state IN ('active', 'paused', 'retired')),
  sync_state    TEXT NOT NULL DEFAULT 'never_synced'
                CHECK (sync_state IN ('never_synced', 'syncing', 'synced', 'error')),

  -- Language / collector config. Structural only; never source bodies.
  language      TEXT,
  config        JSONB NOT NULL DEFAULT '{}'::jsonb,

  -- Content-safe hash + timestamp metadata. content_hash is an opaque digest of
  -- the last-observed source content; last_synced_at is when sync last ran.
  content_hash  TEXT,
  last_synced_at TIMESTAMPTZ,

  -- Optimistic-concurrency revision. Every update bumps this; callers that pass
  -- a stale expected revision are rejected (stale/deleted-revision protection).
  revision      INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),

  created_by    TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Immutable external identity is unique per namespace + kind. Scoped to
  -- namespace so identity never collides or resolves across the boundary.
  UNIQUE (namespace, source_kind, external_id)
);

CREATE INDEX IF NOT EXISTS idx_ob_sources_namespace
  ON ob_sources (namespace, lifecycle_state);

CREATE INDEX IF NOT EXISTS idx_ob_sources_ingestion_eligible
  ON ob_sources (namespace, source_kind)
  WHERE approval_state = 'approved' AND lifecycle_state = 'active';

-- Reuse the shared updated_at trigger function (defined in 001_init.sql).
DROP TRIGGER IF EXISTS trg_ob_sources_updated_at ON ob_sources;
CREATE TRIGGER trg_ob_sources_updated_at
  BEFORE UPDATE ON ob_sources
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();
