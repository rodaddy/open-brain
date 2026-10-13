/**
 * Extension bootstrap for test databases (issue 1667). Pure: no database.
 *
 * pg_stat_statements must be created only where the server can provide it,
 * by the same guard migration 008_index_cleanup.sql uses: skip when already
 * installed, otherwise try and turn a refusal into a WARNING. A shared server
 * that does not preload it (and refuses the untrusted extension to a
 * non-superuser) must not fail database provisioning; a local superuser
 * server still gets it.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import {
  EXTENSION_BOOTSTRAP_SQL,
  PG_STAT_STATEMENTS_IF_AVAILABLE_SQL,
} from "./extension-bootstrap.ts";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (path: string): string => readFileSync(join(REPO_ROOT, path), "utf8");
const squash = (sql: string): string => sql.replace(/\s+/g, " ").trim();

/** The DO block from migration 008, with the comment lines removed. */
function migration008Guard(): string {
  const sql = read("server/db/migrations/008_index_cleanup.sql");
  const start = sql.indexOf("DO $$");
  const end = sql.indexOf("END $$;", start);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return squash(sql.slice(start, end + "END $$;".length));
}

describe("PG_STAT_STATEMENTS_IF_AVAILABLE_SQL", () => {
  test("is exactly migration 008's guarded DO block", () => {
    expect(squash(PG_STAT_STATEMENTS_IF_AVAILABLE_SQL)).toBe(migration008Guard());
  });
  test("keeps: creates the extension when it is not installed", () => {
    const sql = squash(PG_STAT_STATEMENTS_IF_AVAILABLE_SQL);
    expect(sql).toContain(
      "IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_stat_statements') THEN",
    );
    expect(sql).toContain("CREATE EXTENSION pg_stat_statements;");
  });
  test("skips: a refusal is caught as a WARNING, never raised", () => {
    const sql = squash(PG_STAT_STATEMENTS_IF_AVAILABLE_SQL);
    expect(sql).toMatch(
      /CREATE EXTENSION pg_stat_statements; EXCEPTION WHEN OTHERS THEN RAISE WARNING/,
    );
    expect(sql).not.toContain("CREATE EXTENSION IF NOT EXISTS pg_stat_statements");
  });
});

describe("EXTENSION_BOOTSTRAP_SQL", () => {
  test("creates vector unconditionally, then pg_stat_statements only if available", () => {
    expect(
      EXTENSION_BOOTSTRAP_SQL.startsWith("CREATE EXTENSION IF NOT EXISTS vector;"),
    ).toBe(true);
    expect(EXTENSION_BOOTSTRAP_SQL).toContain(PG_STAT_STATEMENTS_IF_AVAILABLE_SQL);
  });
});

describe("test-database provisioning sites", () => {
  test.each([
    "scripts/test-support/clone-database.ts",
    "scripts/__tests__/backup-restore-live-helpers.ts",
  ])("%s never creates pg_stat_statements unconditionally", (path) => {
    const source = read(path);
    expect(source).not.toMatch(/CREATE EXTENSION IF NOT EXISTS pg_stat_statements/);
    expect(source).toContain("EXTENSION_BOOTSTRAP_SQL");
  });
});
