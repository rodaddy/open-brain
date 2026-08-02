/**
 * Real-PostgreSQL namespace boundary tests.
 *
 * Design authority: `docs/decisions/privilege-isolation-closed-brain.md`
 * requires realistic tests proving cross-client leakage fails closed.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pino from "pino";
import { Pool } from "pg";
import type { AuthIdentity } from "../auth/types.ts";
import { createDatabase } from "./pool.ts";
import { runMigrations } from "./migrations.ts";
import { deleteById, selectById } from "./query.ts";

const DATABASE_URL = process.env.OPENBRAIN_TEST_DATABASE_URL;
const databaseDescribe = DATABASE_URL ? describe : describe.skip;
if (!DATABASE_URL) process.stdout.write("SKIP server/db/query.pg.test.ts: OPENBRAIN_TEST_DATABASE_URL is unset\n");

const schema = `foundation_${process.pid}`;
const bilby: AuthIdentity = {
  role: "agent",
  clientId: "bilby",
  tokenClientId: "bilby",
  namespaceSource: "token",
};
const fixtureDirectory = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "migrations");
const testLogger = pino({ level: "silent" });

function databaseConfig(connectionString: string) {
  const url = new URL(connectionString);
  return {
    host: url.hostname,
    port: Number(url.port || "5432"),
    database: url.pathname.slice(1),
    user: decodeURIComponent(url.username),
    ...(url.password ? { password: decodeURIComponent(url.password) } : {}),
    maxConnections: 2,
    connectionTimeoutMs: 5_000,
    statementTimeoutMs: 30_000,
    migrationsDirectory: fixtureDirectory,
  };
}

databaseDescribe("server ID queries enforce namespace isolation (live Postgres)", () => {
  let owner: Pool;
  let scoped: Pool;

  beforeAll(async () => {
    owner = new Pool({ connectionString: DATABASE_URL });
    await owner.query(`CREATE SCHEMA ${schema}`);
    await owner.query(`CREATE TABLE ${schema}.thoughts (id TEXT PRIMARY KEY, namespace TEXT NOT NULL, content TEXT NOT NULL)`);
    await owner.query(`INSERT INTO ${schema}.thoughts (id, namespace, content) VALUES ($1, $2, $3), ($4, $5, $6)`, [
      "bilby-row", "bilby", "owned", "skippy-row", "skippy", "private",
    ]);
    scoped = new Pool({ connectionString: DATABASE_URL, options: `-c search_path=${schema}` });
  });

  afterAll(async () => {
    await scoped.end();
    await owner.query(`DROP SCHEMA ${schema} CASCADE`);
    await owner.end();
  });

  it("does not return an attacker-selected ID from another namespace", async () => {
    expect(await selectById(scoped, { table: "thoughts", id: "skippy-row", identity: bilby, operation: "read" })).toBeUndefined();
    expect(await selectById<{ content: string }>(scoped, { table: "thoughts", id: "bilby-row", identity: bilby, operation: "read" })).toMatchObject({ content: "owned" });
  });

  it("does not delete an ID from another namespace", async () => {
    expect(await deleteById(scoped, { table: "thoughts", id: "skippy-row", identity: bilby })).toBe(false);
    const row = await owner.query(`SELECT content FROM ${schema}.thoughts WHERE id = $1`, ["skippy-row"]);
    expect(row.rows[0]?.content).toBe("private");
  });

  it("owns, probes, and closes its configured pool", async () => {
    if (!DATABASE_URL) throw new Error("OPENBRAIN_TEST_DATABASE_URL is required");
    const database = createDatabase(databaseConfig(DATABASE_URL), testLogger);
    expect(await database.health()).toMatchObject({ connected: true });
    await database.close();
  });

  it("serializes concurrent migration runners and applies each SQL file once", async () => {
    const results = await Promise.all([
      runMigrations(scoped, fixtureDirectory, testLogger),
      runMigrations(scoped, fixtureDirectory, testLogger),
    ]);
    expect(results.flat()).toEqual(["001_foundation_fixture.sql"]);
    const result = await scoped.query("SELECT value FROM foundation_migration_fixture WHERE id = $1", [1]);
    expect(result.rows[0]?.value).toBe("applied");
  });
});
