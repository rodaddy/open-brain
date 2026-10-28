-- Test fixture for the append-only migration contract in
-- docs/code-brain-design.md section 7.
CREATE TABLE foundation_migration_fixture (
  id INTEGER PRIMARY KEY,
  value TEXT NOT NULL
);

INSERT INTO foundation_migration_fixture (id, value)
VALUES (1, 'applied');
