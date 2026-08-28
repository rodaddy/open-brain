/**
 * Live backup/restore drill: snapshot, refusals, and upgrade (issues #298,
 * #878).
 *
 * Split out of scripts/__tests__/backup-restore-live.test.ts so neither half
 * exceeds the repo's per-file and per-function code-line standards. The drill
 * lifecycle both halves need lives in backup-restore-live-helpers.ts; this file
 * opens its own, so it runs standalone.
 *
 * REQUIREMENTS (issue #878): the two database connection strings are demanded
 * through scripts/test-support/require-test-database.ts, which throws
 * test_database_required when either is unset. Nothing here skips itself.
 */
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { cp, readdir } from "node:fs/promises";
import { join } from "node:path";
import { runMigrations } from "../../src/db/migrate.ts";
import { resolvePgTool } from "../backup-lib.ts";
import { requireTestDatabaseUrl } from "../test-support/require-test-database.ts";
import { requireLocalCloneTestDatabaseUrl } from "../test-support/require-test-database.ts";
import { RESTORE_WIPE_APPROVAL_ENV, RESTORE_WIPE_APPROVAL_VALUE } from "../restore.ts";
import {
  cliEnv,
  closeDrill,
  dbUrl,
  type DrillContext,
  expectDefined,
  makePool,
  MIGRATIONS_DIR,
  NS_ALPHA,
  OLD_SRC_DB,
  OLD_TGT_DB,
  openDrill,
  receiptSetField,
  runCli,
  seedAndBackup,
  SNAPSHOT_TGT_DB,
  SRC_DB,
  tempDir,
  TGT_DB,
} from "./backup-restore-live-helpers.ts";

// Demanded at module scope, never probed: absent either variable this throws
// test_database_required and the run fails loudly rather than skipping (#878).
requireTestDatabaseUrl();
requireLocalCloneTestDatabaseUrl();

let ctx: DrillContext;
let backupDir: string;

async function snapshotAcrossConcurrentCommit(): Promise<void> {
  const coordinationDir = await tempDir(ctx.tempDirs);
  const readyPath = join(coordinationDir, "pg-dump-ready");
  const releasePath = join(coordinationDir, "pg-dump-release");
  const wrapperPath = join(coordinationDir, "coordinated-pg-dump.ts");
  const realPgDump = resolvePgTool("pg_dump");
  await Bun.write(
    wrapperPath,
    [
      `await Bun.write(process.env.OB_SNAPSHOT_TEST_READY!, "ready");`,
      `while (!(await Bun.file(process.env.OB_SNAPSHOT_TEST_RELEASE!).exists())) await Bun.sleep(20);`,
      `const tool = JSON.parse(process.env.OB_SNAPSHOT_TEST_TOOL!) as string[];`,
      `const proc = Bun.spawn([...tool, ...Bun.argv.slice(2)], {`,
      `  env: process.env, stdin: "inherit", stdout: "inherit", stderr: "inherit",`,
      `});`,
      `process.exit(await proc.exited);`,
      "",
    ].join("\n"),
  );

  const snapshotBackupDir = join(await tempDir(ctx.tempDirs), "set-snapshot");
  const backupPromise = runCli("backup.ts", ["--out", snapshotBackupDir], {
    ...cliEnv(ctx.admin, SRC_DB),
    OPENBRAIN_PG_DUMP_BIN: `bun ${wrapperPath}`,
    OB_SNAPSHOT_TEST_READY: readyPath,
    OB_SNAPSHOT_TEST_RELEASE: releasePath,
    OB_SNAPSHOT_TEST_TOOL: JSON.stringify(realPgDump),
  });

  const readyDeadline = Date.now() + 30_000;
  while (!(await Bun.file(readyPath).exists())) {
    if (Date.now() >= readyDeadline) {
      await Bun.write(releasePath, "release");
      await backupPromise;
      throw new Error("timed out waiting for coordinated pg_dump");
    }
    await Bun.sleep(20);
  }

  const concurrentHash = "drill-concurrent-after-snapshot";
  const writer = makePool(ctx.admin, SRC_DB);
  try {
    await writer.query(
      `INSERT INTO thoughts (content, created_by, namespace, content_hash)
         VALUES ($1, $2, $3, $4)`,
      ["concurrent write after exported snapshot", "drill", NS_ALPHA, concurrentHash],
    );
  } finally {
    await writer.end();
    // Always unblock the wrapper, including when the concurrent write
    // fails, so the backup subprocess cannot leak into later tests.
    await Bun.write(releasePath, "release");
  }

  const backup = await backupPromise;
  expect(backup.exitCode).toBe(0);
  expect(backup.receipt?.status).toBe("ok");
  const manifest = JSON.parse(
    await Bun.file(join(snapshotBackupDir, "manifest.json")).text(),
  );

  const restore = await runCli(
    "restore.ts",
    ["--dir", snapshotBackupDir, "--target-db-url", dbUrl(ctx.admin, SNAPSHOT_TGT_DB)],
    cliEnv(ctx.admin, SRC_DB),
  );
  expect(restore.exitCode).toBe(0);
  expect(restore.receipt?.status).toBe("ok");

  const restored = makePool(ctx.admin, SNAPSHOT_TGT_DB);
  try {
    const { rows: countRows } = await restored.query(
      "SELECT COUNT(*)::int AS count FROM thoughts",
    );
    expect(expectDefined(countRows[0], "count row").count).toBe(
      manifest.row_counts.thoughts,
    );
    const { rows: concurrentRows } = await restored.query(
      "SELECT 1 FROM thoughts WHERE content_hash = $1",
      [concurrentHash],
    );
    expect(concurrentRows).toEqual([]);
  } finally {
    await restored.end();
  }
}

async function refusesNonEmptyTargetWithoutWipe(): Promise<void> {
  // Self-sufficient: ensure the target exists and is non-empty rather
  // than depending on the previous drill test having populated it.
  const adminPool = new pg.Client({
    connectionString: dbUrl(ctx.admin, ctx.admin.database),
  });
  await adminPool.connect();
  try {
    const { rows } = await adminPool.query(
      "SELECT 1 FROM pg_database WHERE datname = $1",
      [TGT_DB],
    );
    if (rows.length === 0) {
      await adminPool.query(`CREATE DATABASE ${TGT_DB}`);
    }
  } finally {
    await adminPool.end();
  }
  const seedPool = new pg.Client({
    connectionString: dbUrl(ctx.admin, TGT_DB),
  });
  await seedPool.connect();
  try {
    await seedPool.query("CREATE TABLE IF NOT EXISTS drill_nonempty_marker (id int)");
  } finally {
    await seedPool.end();
  }
  const noWipe = await runCli(
    "restore.ts",
    ["--dir", backupDir, "--target-db-url", dbUrl(ctx.admin, TGT_DB)],
    cliEnv(ctx.admin, SRC_DB),
  );
  expect(noWipe.exitCode).not.toBe(0);
  expect(noWipe.receipt?.status).toBe("failed");
  expect(noWipe.receipt?.error).toContain("NOT empty");

  const noApproval = await runCli(
    "restore.ts",
    ["--dir", backupDir, "--target-db-url", dbUrl(ctx.admin, TGT_DB), "--wipe-target"],
    cliEnv(ctx.admin, SRC_DB),
  );
  expect(noApproval.exitCode).not.toBe(0);
  expect(noApproval.receipt?.error).toContain(RESTORE_WIPE_APPROVAL_ENV);

  // With the approval env the wipe + restore succeeds.
  const approved = await runCli(
    "restore.ts",
    ["--dir", backupDir, "--target-db-url", dbUrl(ctx.admin, TGT_DB), "--wipe-target"],
    {
      ...cliEnv(ctx.admin, SRC_DB),
      [RESTORE_WIPE_APPROVAL_ENV]: RESTORE_WIPE_APPROVAL_VALUE,
    },
  );
  expect(approved.receipt?.status).toBe("ok");
  expect(approved.exitCode).toBe(0);
}

async function refusesNonPublicUserSchemas(): Promise<void> {
  // The approved wipe only drops schema public; a target carrying user
  // tables in ANY other schema must be refused outright (fail-closed),
  // wipe approval or not.
  const seed = new pg.Client({ connectionString: dbUrl(ctx.admin, TGT_DB) });
  await seed.connect();
  try {
    await seed.query("CREATE SCHEMA IF NOT EXISTS drill_foreign");
    await seed.query("CREATE TABLE IF NOT EXISTS drill_foreign.marker (id int)");
  } finally {
    await seed.end();
  }
  const refused = await runCli(
    "restore.ts",
    ["--dir", backupDir, "--target-db-url", dbUrl(ctx.admin, TGT_DB), "--wipe-target"],
    {
      ...cliEnv(ctx.admin, SRC_DB),
      [RESTORE_WIPE_APPROVAL_ENV]: RESTORE_WIPE_APPROVAL_VALUE,
    },
  );
  expect(refused.exitCode).not.toBe(0);
  expect(refused.receipt?.status).toBe("failed");
  expect(refused.receipt?.error).toContain("non-public");

  // Nothing was wiped: both the foreign schema AND the existing public
  // tables survived the refusal.
  const check = new pg.Client({ connectionString: dbUrl(ctx.admin, TGT_DB) });
  await check.connect();
  try {
    const { rows: foreignRows } = await check.query(
      "SELECT 1 FROM pg_catalog.pg_tables WHERE schemaname = 'drill_foreign'",
    );
    expect(foreignRows.length).toBe(1);
    const { rows: publicRows } = await check.query(
      `SELECT COUNT(*)::int AS count FROM pg_catalog.pg_tables
         WHERE schemaname = 'public'`,
    );
    expect(expectDefined(publicRows[0], "public count row").count).toBeGreaterThan(0);
    // Clean up so later tests see a public-only target again.
    await check.query("DROP SCHEMA drill_foreign CASCADE");
  } finally {
    await check.end();
  }
}

async function oldBackupRestoresIntoUpgradedRuntime(): Promise<void> {
  // Build a source whose migration head is ONE BEHIND the repo head by
  // migrating with a truncated copy of the migrations directory.
  const allMigrations = (await readdir(MIGRATIONS_DIR))
    .filter((f) => f.endsWith(".sql"))
    .sort();
  expect(allMigrations.length).toBeGreaterThan(1);
  const truncatedDir = await tempDir(ctx.tempDirs);
  for (const file of allMigrations.slice(0, -1)) {
    await cp(join(MIGRATIONS_DIR, file), join(truncatedDir, file));
  }

  const oldPool = makePool(ctx.admin, OLD_SRC_DB);
  try {
    await runMigrations(oldPool, truncatedDir);
    await oldPool.query(
      `INSERT INTO thoughts (content, created_by, namespace, content_hash)
         VALUES ($1, $2, $3, $4)`,
      ["drill old-runtime thought", "drill", NS_ALPHA, "drill-old-1"],
    );
  } finally {
    await oldPool.end();
  }

  const oldBackupDir = join(await tempDir(ctx.tempDirs), "set-old");
  const backup = await runCli(
    "backup.ts",
    ["--out", oldBackupDir],
    cliEnv(ctx.admin, OLD_SRC_DB),
  );
  expect(backup.exitCode).toBe(0);
  expect(backup.receipt?.migrations_head).toBe(allMigrations[allMigrations.length - 2]);

  const verify = await runCli(
    "backup-verify.ts",
    ["--dir", oldBackupDir],
    cliEnv(ctx.admin, OLD_SRC_DB),
  );
  expect(verify.exitCode).toBe(0);
  expect(receiptSetField(verify.receipt, 0, "migration_compat")).toBe(
    "restorable_with_migrations",
  );

  const restore = await runCli(
    "restore.ts",
    ["--dir", oldBackupDir, "--target-db-url", dbUrl(ctx.admin, OLD_TGT_DB)],
    cliEnv(ctx.admin, OLD_SRC_DB),
  );
  expect(restore.receipt?.status).toBe("ok");
  expect(restore.exitCode).toBe(0);
  expect(restore.receipt?.migrations_applied_forward).toBeGreaterThan(0);

  const tgtPool = makePool(ctx.admin, OLD_TGT_DB);
  try {
    const { rows } = await tgtPool.query(
      "SELECT filename FROM _migrations ORDER BY filename",
    );
    // The head ADVANCED: the restored-and-migrated db now matches the
    // full repo migration list, including the file the backup predated.
    expect(rows.map((r) => String(r.filename))).toEqual(allMigrations);
    const { rows: dataRows } = await tgtPool.query(
      "SELECT 1 FROM thoughts WHERE content_hash = $1",
      ["drill-old-1"],
    );
    expect(dataRows.length).toBe(1);
  } finally {
    await tgtPool.end();
  }
}

async function corruptedDumpFailsVerification(): Promise<void> {
  // Run LAST: this intentionally breaks the first drill's backup set.
  const dumpPath = join(backupDir, "openbrain.dump");
  const original = new Uint8Array(await Bun.file(dumpPath).arrayBuffer());
  const flipAt = Math.floor(original.length / 2);
  original[flipAt] = expectDefined(original[flipAt], "dump byte") ^ 0xff;
  await Bun.write(dumpPath, original);

  const verify = await runCli(
    "backup-verify.ts",
    ["--dir", backupDir],
    cliEnv(ctx.admin, SRC_DB),
  );
  expect(verify.exitCode).toBe(1);
  expect(verify.receipt?.status).toBe("failed");

  // And restore refuses the corrupted set before touching any target.
  const restore = await runCli(
    "restore.ts",
    ["--dir", backupDir, "--target-db-url", dbUrl(ctx.admin, TGT_DB)],
    {
      ...cliEnv(ctx.admin, SRC_DB),
      [RESTORE_WIPE_APPROVAL_ENV]: RESTORE_WIPE_APPROVAL_VALUE,
    },
  );
  expect(restore.exitCode).not.toBe(0);
  expect(restore.receipt?.status).toBe("failed");
  expect(restore.receipt?.error).toContain("verification failed");
}

describe("backup restore drill snapshot, refusals, and upgrade (live Postgres)", () => {
  beforeAll(async () => {
    ctx = await openDrill();
    ({ backupDir } = await seedAndBackup(ctx));
  }, 60_000);

  afterAll(async () => {
    await closeDrill(ctx);
  }, 60_000);

  it(
    "uses one exported snapshot for manifest counts and dump contents across a concurrent commit",
    snapshotAcrossConcurrentCommit,
    240_000,
  );
  it(
    "refuses a non-empty target without --wipe-target + approval env",
    refusesNonEmptyTargetWithoutWipe,
    180_000,
  );
  it(
    "refuses a target with non-public user schemas even with wipe approval",
    refusesNonPublicUserSchemas,
    180_000,
  );
  it(
    "old backup (pre-latest-migration) restores into the upgraded runtime and the head advances",
    oldBackupRestoresIntoUpgradedRuntime,
    240_000,
  );
  it(
    "a corrupted dump fails CLI verification with a nonzero exit",
    corruptedDumpFailsVerification,
    120_000,
  );
});
