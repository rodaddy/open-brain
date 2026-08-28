/**
 * Live backup/restore drill: the full run (issues #298, #878, #938).
 *
 * End-to-end against a REAL Postgres: creates throwaway scratch databases via
 * the admin connection, migrates + seeds a source, runs the actual backup.ts /
 * backup-verify.ts / restore.ts CLIs, and asserts every post-restore
 * validation plus:
 *   - archived (soft-deleted) rows restore AS archived
 *   - hard-deleted rows are absent from the dump and cannot be resurrected
 *   - restored data is readable AND writable
 *   - a session-lane append lands against the restored db (server-side proof
 *     that a client spool drain would land after restore)
 *   - a restore into a fresh administrator-bootstrapped database the
 *     non-superuser clone role owns succeeds (#938)
 *
 * The snapshot, refusal, and upgrade tests live in
 * scripts/__tests__/backup-restore-live-refusals.test.ts, and the drill
 * lifecycle both halves need lives in backup-restore-live-helpers.ts.
 *
 * REQUIREMENTS (issue #878): the drill runs on every isolated run. The two
 * database connection strings are demanded through
 * scripts/test-support/require-test-database.ts, which throws
 * test_database_required when either is unset, and the pg_dump/pg_restore
 * probe is asserted by the first test rather than gating the suite. Host pg
 * client tools whose MAJOR VERSION is older than the server make pg_dump
 * refuse to dump; the CI drill step pins matched tools via
 * OPENBRAIN_PG_DUMP_BIN/OPENBRAIN_PG_RESTORE_BIN docker-exec wrappers. A
 * missing prerequisite FAILS loudly instead of skipping, so no run can
 * silently no-op.
 *
 * The scratch databases live on the same server as the test database but use
 * dedicated `open_brain_ci_restore_*` names, mirroring the DB_NAME /
 * DB_NAME_TEST separation in ci.yml, and are dropped afterwards.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { join } from "node:path";
import { pgToolAvailable } from "../backup-lib.ts";
import { requireTestDatabaseUrl } from "../test-support/require-test-database.ts";
import { requireLocalCloneTestDatabaseUrl } from "../test-support/require-test-database.ts";
import {
  ARCHIVED_HASH,
  cliEnv,
  CLONE_TGT_DB,
  closeDrill,
  type CliReceipt,
  dbUrl,
  DELETED_HASH,
  type DrillContext,
  expectDefined,
  makePool,
  NS_ALPHA,
  NS_BETA,
  openDrill,
  receiptSetField,
  runCli,
  seedAndBackup,
  SRC_DB,
  TGT_DB,
} from "./backup-restore-live-helpers.ts";

const TOOLS_AVAILABLE = pgToolAvailable("pg_dump") && pgToolAvailable("pg_restore");

let ctx: DrillContext;
let backupDir: string;

/** A restore receipt's validations array, as the CLI prints it. */
interface RestoreValidation {
  verdict: string;
}

function validationsOf(receipt: CliReceipt): RestoreValidation[] {
  return (receipt?.["validations"] ?? []) as RestoreValidation[];
}

function prerequisitesAreAvailable(): void {
  // The drill MUST run — missing pg client tools is a wiring failure, not a
  // skip. The two database URLs are demanded, never probed: each throws
  // test_database_required when its variable is unset.
  expect(Boolean(requireTestDatabaseUrl())).toBe(true);
  expect(Boolean(requireLocalCloneTestDatabaseUrl())).toBe(true);
  expect(TOOLS_AVAILABLE).toBe(true);
}

/** Seeds the source, backs it up, and asserts the backup receipt. */
async function drillSeedAndBackup(): Promise<CliReceipt> {
  const { admin } = ctx;
  const seeded = await seedAndBackup(ctx);
  backupDir = seeded.backupDir;
  const backup = seeded.backup;
  expect(backup.stderr).not.toContain("error");
  expect(backup.exitCode).toBe(0);
  expect(backup.receipt?.schema).toBe("openbrain.backup_receipt.v1");
  expect(backup.receipt?.status).toBe("ok");
  expect(backup.receipt?.distinct_namespaces).toBe(2);
  expect(backup.receipt?.dump_bytes).toBeGreaterThan(0);

  // Second run without --force refuses to overwrite.
  const refused = await runCli(
    "backup.ts",
    ["--out", backupDir],
    cliEnv(admin, SRC_DB),
  );
  expect(refused.exitCode).not.toBe(0);
  return backup.receipt;
}

/** Verifies the backup set and asserts its artifacts are content-free. */
async function drillVerify(backupReceipt: CliReceipt): Promise<void> {
  const { admin } = ctx;
  // --- verify (before any mutation anywhere) --------------------------
  const verify = await runCli(
    "backup-verify.ts",
    ["--dir", backupDir],
    cliEnv(admin, SRC_DB),
  );
  expect(verify.exitCode).toBe(0);
  expect(verify.receipt?.schema).toBe("openbrain.backup_verify_receipt.v1");
  expect(verify.receipt?.status).toBe("passed");
  expect(receiptSetField(verify.receipt, 0, "migration_compat")).toBe("equal");

  // Receipts and manifest are content-free: no namespace names, no row
  // content, no credentials.
  const manifestText = await Bun.file(join(backupDir, "manifest.json")).text();
  for (const artifact of [
    manifestText,
    JSON.stringify(backupReceipt),
    JSON.stringify(verify.receipt),
  ]) {
    expect(artifact).not.toContain(NS_ALPHA);
    expect(artifact).not.toContain(NS_BETA);
    expect(artifact).not.toContain("drill alpha thought");
    if (admin.password) {
      // Credential-in-URL form must never appear. A raw substring check
      // is only meaningful for non-trivial passwords: CI's throwaway
      // password is "ci", which collides with "open_brain_ci_*" database
      // names and would false-positive.
      expect(artifact).not.toContain(`:${admin.password}@`);
      expect(artifact).not.toContain(`:${encodeURIComponent(admin.password)}@`);
      if (admin.password.length >= 6) {
        expect(artifact).not.toContain(admin.password);
      }
    }
  }
}

/** Restores the set into the empty scratch target. */
async function drillRestore(): Promise<void> {
  const { admin } = ctx;
  // --- restore into the empty scratch target --------------------------
  const restore = await runCli(
    "restore.ts",
    ["--dir", backupDir, "--target-db-url", dbUrl(admin, TGT_DB)],
    cliEnv(admin, SRC_DB),
  );
  expect(restore.receipt?.schema).toBe("openbrain.restore_receipt.v1");
  expect(restore.receipt?.status).toBe("ok");
  expect(restore.exitCode).toBe(0);
  expect(restore.receipt?.rollback_hint).toContain(TGT_DB);
  const failedValidations = validationsOf(restore.receipt).filter(
    (v) => v.verdict !== "ok",
  );
  expect(failedValidations).toEqual([]);
}

/** Asserts every post-restore property on the restored target. */
async function drillPostRestoreAssertions(): Promise<void> {
  const { admin } = ctx;
  // --- post-restore assertions on the target --------------------------
  const tgtPool = makePool(admin, TGT_DB);
  try {
    // Counts and namespaces survived.
    const { rows: countRows } = await tgtPool.query(
      "SELECT COUNT(*)::int AS count FROM thoughts",
    );
    expect(expectDefined(countRows[0], "count row").count).toBe(5);
    const { rows: nsRows } = await tgtPool.query(
      "SELECT COUNT(DISTINCT namespace)::int AS count FROM thoughts",
    );
    expect(expectDefined(nsRows[0], "namespace row").count).toBe(2);

    // Archived row restored AS archived.
    const { rows: archivedRows } = await tgtPool.query(
      "SELECT archived_at FROM thoughts WHERE content_hash = $1",
      [ARCHIVED_HASH],
    );
    expect(archivedRows.length).toBe(1);
    expect(expectDefined(archivedRows[0], "archived row").archived_at).not.toBeNull();

    // Hard-deleted row NOT resurrected.
    const { rows: deletedRows } = await tgtPool.query(
      "SELECT 1 FROM thoughts WHERE content_hash = $1",
      [DELETED_HASH],
    );
    expect(deletedRows.length).toBe(0);

    // Readable.
    const { rows: readRows } = await tgtPool.query(
      "SELECT content FROM thoughts WHERE content_hash = $1",
      ["drill-alpha-1"],
    );
    expect(expectDefined(readRows[0], "read row").content).toBe(
      "drill alpha thought one",
    );

    // Writable.
    await tgtPool.query(
      `INSERT INTO thoughts (content, created_by, namespace, content_hash)
         VALUES ($1, $2, $3, $4)`,
      ["drill post-restore write", "drill", NS_ALPHA, "drill-post-1"],
    );

    // Restore-then-replay linkage (server-side scope): a session lane
    // append lands against the restored db, proving a client spool
    // drain would land. The full python-client replay drill is out of
    // scope for this repo (named in the PR's deferred list).
    const { rows: laneRows } = await tgtPool.query(
      `SELECT id FROM ob_session_lanes
          WHERE namespace = $1 AND session_key = $2`,
      [NS_ALPHA, "drill-lane-1"],
    );
    expect(laneRows.length).toBe(1);
    await tgtPool.query(
      `INSERT INTO ob_session_events (lane_id, event_type, content, created_by)
         VALUES ($1, $2, $3, $4)`,
      [
        expectDefined(laneRows[0], "lane row").id,
        "fact",
        "drill post-restore append",
        "drill",
      ],
    );
    const { rows: eventRows } = await tgtPool.query(
      "SELECT COUNT(*)::int AS count FROM ob_session_events WHERE lane_id = $1",
      [expectDefined(laneRows[0], "lane row").id],
    );
    expect(expectDefined(eventRows[0], "event row").count).toBe(2);
  } finally {
    await tgtPool.end();
  }
}

async function fullDrill(): Promise<void> {
  const backupReceipt = await drillSeedAndBackup();
  await drillVerify(backupReceipt);
  await drillRestore();
  await drillPostRestoreAssertions();
}

async function restoresIntoFreshNonSuperuserClone(): Promise<void> {
  const { admin, clone } = ctx;
  expect(clone.host).toBe("127.0.0.1");
  expect(clone.user).toBe("open_brain_local_clone");
  expect(clone.database.startsWith("open_brain_local_")).toBe(true);

  const restore = await runCli(
    "restore.ts",
    // Issue #938: the runner already migrated clone.database, and restore.ts
    // refuses a non-empty target, so the drill restores into a fresh
    // database the clone role OWNS -- the non-superuser property this test
    // is about is preserved, the false failure is not.
    ["--dir", backupDir, "--target-db-url", dbUrl(clone, CLONE_TGT_DB)],
    cliEnv(admin, SRC_DB),
  );
  expect(restore.exitCode).toBe(0);
  expect(restore.receipt?.status).toBe("ok");
  expect(validationsOf(restore.receipt).every((v) => v.verdict === "ok")).toBe(true);

  const restored = makePool(clone, CLONE_TGT_DB);
  try {
    const { rows: identity } = await restored.query(
      `SELECT current_user,
              EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector') AS vector_installed,
              EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_stat_statements') AS pg_stat_statements_installed`,
    );
    expect(identity[0]).toEqual({
      current_user: "open_brain_local_clone",
      vector_installed: true,
      pg_stat_statements_installed: true,
    });
    const { rows: readRows } = await restored.query(
      "SELECT COUNT(*)::int AS count FROM thoughts",
    );
    expect(expectDefined(readRows[0], "read row").count).toBeGreaterThan(0);
    await restored.query(
      `INSERT INTO thoughts (content, created_by, namespace, content_hash)
         VALUES ($1, $2, $3, $4)`,
      ["non-superuser clone restore write", "drill", NS_ALPHA, "drill-clone-write"],
    );
  } finally {
    await restored.end();
  }
}

describe("backup restore drill full run (live Postgres)", () => {
  beforeAll(async () => {
    ctx = await openDrill();
  }, 60_000);

  afterAll(async () => {
    await closeDrill(ctx);
  }, 60_000);

  it(
    "prerequisites are available (fails loudly when the drill is enabled)",
    prerequisitesAreAvailable,
  );
  it(
    "full drill: seed → backup → verify → restore → validations → replay linkage",
    fullDrill,
    180_000,
  );
  it(
    "restores into the fresh administrator-bootstrapped non-superuser clone",
    restoresIntoFreshNonSuperuserClone,
    180_000,
  );
});
