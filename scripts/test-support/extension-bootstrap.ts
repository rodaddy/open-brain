/**
 * Extension bootstrap for test databases (issue 1667).
 *
 * `vector` is created unconditionally, as before: a shared server's template
 * already carries it, so the statement is a no-op there.
 *
 * `pg_stat_statements` is created only where the server can provide it, by the
 * exact guard migration `server/db/migrations/008_index_cleanup.sql` uses: skip
 * when installed, otherwise try, and turn a refusal into a WARNING. On a
 * server that does not preload it (k3s `general`, where
 * `shared_preload_libraries` is empty and the test role may not create the
 * untrusted extension) provisioning continues without it -- the server's
 * WARNING announces the skip. A local superuser server still gets it, so local
 * behaviour is unchanged.
 */

/** Migration 008's guarded DO block, verbatim minus its comments. */
export const PG_STAT_STATEMENTS_IF_AVAILABLE_SQL = `DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_stat_statements') THEN
    BEGIN
      CREATE EXTENSION pg_stat_statements;
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'pg_stat_statements not available -- add to shared_preload_libraries and restart PostgreSQL';
    END;
  END IF;
END $$;`;

/** The administrative extension bootstrap both provisioning sites run. */
export const EXTENSION_BOOTSTRAP_SQL = `CREATE EXTENSION IF NOT EXISTS vector; ${PG_STAT_STATEMENTS_IF_AVAILABLE_SQL}`;
