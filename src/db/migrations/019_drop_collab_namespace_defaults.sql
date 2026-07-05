-- Migration 019: Drop legacy 'collab' namespace column defaults (#167)
-- collab is retired and frozen. Application logic no longer treats it as
-- shared, but the dangling schema-level DEFAULT 'collab' meant any INSERT that
-- omitted namespace would silently land rows in the frozen namespace.
-- Namespace is an auth-derived security boundary: it must always be explicit.
-- Dropping the DEFAULT (columns stay NOT NULL) makes an insert that omits
-- namespace fail loudly instead of silently writing to collab.
-- Transaction managed by the migration runner -- do not wrap in BEGIN/COMMIT.

ALTER TABLE thoughts         ALTER COLUMN namespace DROP DEFAULT;
ALTER TABLE decisions        ALTER COLUMN namespace DROP DEFAULT;
ALTER TABLE relationships    ALTER COLUMN namespace DROP DEFAULT;
ALTER TABLE projects         ALTER COLUMN namespace DROP DEFAULT;
ALTER TABLE sessions         ALTER COLUMN namespace DROP DEFAULT;
ALTER TABLE ob_entities      ALTER COLUMN namespace DROP DEFAULT;
ALTER TABLE ob_links         ALTER COLUMN namespace DROP DEFAULT;
ALTER TABLE ob_session_lanes ALTER COLUMN namespace DROP DEFAULT;
