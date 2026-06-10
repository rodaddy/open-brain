-- Migration 014: Namespace-scoped unique indexes
-- Changes content_hash and person_name uniqueness from global to per-namespace.
-- Allows the same content to exist in different namespaces (required for promotion).
-- Safe for existing data: all rows currently have namespace = 'collab'.

BEGIN;

-- thoughts: content_hash unique per namespace
DROP INDEX IF EXISTS idx_thoughts_content_hash;
CREATE UNIQUE INDEX idx_thoughts_content_hash ON thoughts (content_hash, namespace)
  WHERE content_hash IS NOT NULL;

-- decisions: content_hash unique per namespace
DROP INDEX IF EXISTS idx_decisions_content_hash;
CREATE UNIQUE INDEX idx_decisions_content_hash ON decisions (content_hash, namespace)
  WHERE content_hash IS NOT NULL;

-- relationships: person_name unique per namespace
DROP INDEX IF EXISTS idx_relationships_person;
CREATE UNIQUE INDEX idx_relationships_person ON relationships (namespace, person_name);

-- relationships: content_hash unique per namespace
DROP INDEX IF EXISTS idx_relationships_content_hash;
CREATE UNIQUE INDEX idx_relationships_content_hash ON relationships (content_hash, namespace)
  WHERE content_hash IS NOT NULL;

-- projects: name unique per namespace
DROP INDEX IF EXISTS idx_projects_name;
CREATE UNIQUE INDEX idx_projects_name ON projects (namespace, name);

-- projects: content_hash unique per namespace
DROP INDEX IF EXISTS idx_projects_content_hash;
CREATE UNIQUE INDEX idx_projects_content_hash ON projects (content_hash, namespace)
  WHERE content_hash IS NOT NULL;

-- sessions: content_hash unique per namespace
DROP INDEX IF EXISTS idx_sessions_content_hash;
CREATE UNIQUE INDEX idx_sessions_content_hash ON sessions (content_hash, namespace)
  WHERE content_hash IS NOT NULL;

COMMIT;
