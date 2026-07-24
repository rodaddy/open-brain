/**
 * Live backup/restore drill (issue #298).
 *
 * End-to-end against a REAL Postgres: creates throwaway scratch databases via
 * the OPENBRAIN_TEST_DATABASE_URL admin connection, migrates + seeds a source,
 * runs the actual backup.ts / backup-verify.ts / restore.ts CLIs, and asserts
 * every post-restore validation plus:
 *   - archived (soft-deleted) rows restore AS archived
 *   - hard-deleted rows are absent from the dump and cannot be resurrected
 *   - restored data is readable AND writable
 *   - a session-lane append lands against the restored db (server-side proof
 *     that a client spool drain would land after restore)
 *   - an OLD backup (taken before the newest migration) restores into the
 *     upgraded runtime and the migration head advances
 *   - a non-empty target is refused without --wipe-target + approval env
 *   - a target with user tables in a non-public schema is refused outright,
 *     even with wipe approval (the approved wipe only drops schema public)
 *
 * GATING: the drill only runs when OPENBRAIN_BACKUP_DRILL=1 (in addition to
 * OPENBRAIN_TEST_DATABASE_URL and a pg_dump/pg_restore availability probe).
 * The extra flag exists because generic `bun test` runs may have host pg
 * client tools whose MAJOR VERSION is older than the server (pg_dump refuses
 * to dump a newer server) — the dedicated CI drill step pins matched tools
 * via OPENBRAIN_PG_DUMP_BIN/OPENBRAIN_PG_RESTORE_BIN docker-exec wrappers and
 * sets the flag. When the flag IS set, missing prerequisites FAIL loudly
 * instead of skipping, so the CI step cannot silently no-op.
 *
 * The scratch databases live on the same server as the test database but use
 * dedicated `open_brain_ci_restore_*` names, mirroring the DB_NAME /
 * DB_NAME_TEST separation in ci.yml, and are dropped afterwards.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { cp, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { runMigrations } from "../../src/db/migrate.ts";
import { pgToolAvailable, resolvePgTool } from "../backup-lib.ts";
import {
  RESTORE_WIPE_APPROVAL_ENV,
  RESTORE_WIPE_APPROVAL_VALUE,
} from "../restore.ts";

const DB_URL = process.env.OPENBRAIN_TEST_DATABASE_URL;
const LOCAL_CLONE_URL = process.env.OPENBRAIN_LOCAL_CLONE_TEST_DATABASE_URL;
const DRILL_ENABLED = process.env.OPENBRAIN_BACKUP_DRILL === "1";
const TOOLS_AVAILABLE =
  pgToolAvailable("pg_dump") && pgToolAvailable("pg_restore");

const drillDescribe = DRILL_ENABLED ? describe : describe.skip;
const READY = Boolean(DB_URL) && Boolean(LOCAL_CLONE_URL) && TOOLS_AVAILABLE;

const REPO_ROOT = join(import.meta.dir, "..", "..");
const MIGRATIONS_DIR = join(REPO_ROOT, "src", "db", "migrations");

const SRC_DB = "open_brain_ci_restore_src";
const TGT_DB = "open_brain_ci_restore_tgt";
const OLD_SRC_DB = "open_brain_ci_restore_oldsrc";
const OLD_TGT_DB = "open_brain_ci_restore_oldtgt";
const SNAPSHOT_TGT_DB = "open_brain_ci_restore_snapshot_tgt";
const SCRATCH_DBS = [SRC_DB, TGT_DB, OLD_SRC_DB, OLD_TGT_DB, SNAPSHOT_TGT_DB];

const NS_ALPHA = "drill-ns-alpha";
const NS_BETA = "drill-ns-beta";
const DELETED_HASH = "drill-hard-deleted-hash";
const ARCHIVED_HASH = "drill-archived-hash";

interface Conn {
  host: string;
  port: number;
  user: string;
  password: string | undefined;
}

function parseAdminUrl(url: string): Conn & { database: string } {
  const parsed = new URL(url);
  return {
    host: parsed.hostname,
    port: parsed.port ? Number(parsed.port) : 5432,
    user: decodeURIComponent(parsed.username),
    password: parsed.password ? decodeURIComponent(parsed.password) : undefined,
    database: parsed.pathname.replace(/^\//, ""),
  };
}

function dbUrl(conn: Conn, database: string): string {
  const auth = conn.password
    ? `${encodeURIComponent(conn.user)}:${encodeURIComponent(conn.password)}`
    : encodeURIComponent(conn.user);
  return `postgres://${auth}@${conn.host}:${conn.port}/${database}`;
}

function cliEnv(conn: Conn, database: string): Record<string, string> {
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    DB_HOST: conn.host,
    DB_PORT: String(conn.port),
    DB_USER: conn.user,
    DB_NAME: database,
  };
  if (conn.password !== undefined) env.DB_PASSWORD = conn.password;
  return env;
}

async function runCli(
  script: string,
  args: string[],
  env: Record<string, string>,
): Promise<{ exitCode: number; receipt: any; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["bun", join(REPO_ROOT, "scripts", script), ...args], {
    cwd: REPO_ROOT,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;
  const lines = stdout
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  let receipt: any = null;
  // The receipt is the last stdout line (logger lines may precede it).
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      receipt = JSON.parse(lines[i]!);
      break;
    } catch {
      continue;
    }
  }
  return { exitCode, receipt, stdout, stderr };
}

function makePool(conn: Conn, database: string): pg.Pool {
  return new pg.Pool({ ...conn, database, max: 2 });
}

drillDescribe("backup restore drill (live Postgres, #298)", () => {
  it("prerequisites are available (fails loudly when the drill is enabled)", () => {
    // OPENBRAIN_BACKUP_DRILL=1 means "the drill MUST run" — missing DB URL or
    // pg client tools is a wiring failure, not a skip.
    expect(Boolean(DB_URL)).toBe(true);
    expect(Boolean(LOCAL_CLONE_URL)).toBe(true);
    expect(TOOLS_AVAILABLE).toBe(true);
  });

  const inner = READY ? describe : describe.skip;
  inner("drill execution", () => {
    // describe bodies evaluate even when skipped — only parse the URL when
    // the drill is actually ready to run.
    const admin: Conn & { database: string } = READY
      ? parseAdminUrl(DB_URL!)
      : { host: "", port: 0, user: "", password: undefined, database: "" };
    const clone: Conn & { database: string } = READY
      ? parseAdminUrl(LOCAL_CLONE_URL!)
      : { host: "", port: 0, user: "", password: undefined, database: "" };
    let adminClient: pg.Client;
    const tempDirs: string[] = [];

    async function tempDir(): Promise<string> {
      const dir = await mkdtemp(join(tmpdir(), "ob298-live-"));
      tempDirs.push(dir);
      return dir;
    }

    async function dropScratchDbs(): Promise<void> {
      for (const name of SCRATCH_DBS) {
        // Names come from the fixed SCRATCH_DBS list above, never from input.
        await adminClient.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      }
    }

    beforeAll(async () => {
      adminClient = new pg.Client({ connectionString: DB_URL });
      await adminClient.connect();
      await dropScratchDbs();
      for (const name of SCRATCH_DBS) {
        await adminClient.query(`CREATE DATABASE ${name}`);
      }
    }, 60_000);

    afterAll(async () => {
      await dropScratchDbs();
      await adminClient.end();
      for (const dir of tempDirs) {
        await rm(dir, { recursive: true, force: true });
      }
    }, 60_000);

    let backupDir: string;

    it("full drill: seed → backup → verify → restore → validations → replay linkage", async () => {
      // --- seed the source ------------------------------------------------
      const srcPool = makePool(admin, SRC_DB);
      try {
        await runMigrations(srcPool);
        await srcPool.query(
          `INSERT INTO thoughts (content, created_by, namespace, content_hash)
             VALUES ($1, $2, $3, $4), ($5, $2, $3, $6)`,
          [
            "drill alpha thought one",
            "drill",
            NS_ALPHA,
            "drill-alpha-1",
            "drill alpha thought two",
            "drill-alpha-2",
          ],
        );
        await srcPool.query(
          `INSERT INTO thoughts (content, created_by, namespace, content_hash, archived_at)
             VALUES ($1, $2, $3, $4, NOW())`,
          ["drill archived thought", "drill", NS_ALPHA, ARCHIVED_HASH],
        );
        await srcPool.query(
          `INSERT INTO thoughts (content, created_by, namespace, content_hash)
             VALUES ($1, $2, $3, $4), ($5, $2, $3, $6)`,
          [
            "drill beta thought one",
            "drill",
            NS_BETA,
            "drill-beta-1",
            "drill beta thought two",
            "drill-beta-2",
          ],
        );
        // Hard-delete semantics: this row is deleted BEFORE the backup and
        // must not be resurrected by restore (absent from the dump).
        await srcPool.query(
          `INSERT INTO thoughts (content, created_by, namespace, content_hash)
             VALUES ($1, $2, $3, $4)`,
          ["drill hard-deleted thought", "drill", NS_ALPHA, DELETED_HASH],
        );
        await srcPool.query("DELETE FROM thoughts WHERE content_hash = $1", [
          DELETED_HASH,
        ]);
        const { rows: laneRows } = await srcPool.query(
          `INSERT INTO ob_session_lanes (session_key, namespace, created_by, project)
             VALUES ($1, $2, $3, $4)
             RETURNING id`,
          ["drill-lane-1", NS_ALPHA, "drill", "drill-project"],
        );
        const laneId = laneRows[0]!.id as string;
        await srcPool.query(
          `INSERT INTO ob_session_events (lane_id, event_type, content, created_by)
             VALUES ($1, $2, $3, $4)`,
          [laneId, "fact", "drill pre-backup event", "drill"],
        );
      } finally {
        await srcPool.end();
      }

      // --- backup ---------------------------------------------------------
      backupDir = join(await tempDir(), "set-1");
      const backup = await runCli(
        "backup.ts",
        ["--out", backupDir],
        cliEnv(admin, SRC_DB),
      );
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

      // --- verify (before any mutation anywhere) --------------------------
      const verify = await runCli(
        "backup-verify.ts",
        ["--dir", backupDir],
        cliEnv(admin, SRC_DB),
      );
      expect(verify.exitCode).toBe(0);
      expect(verify.receipt?.schema).toBe("openbrain.backup_verify_receipt.v1");
      expect(verify.receipt?.status).toBe("passed");
      expect(verify.receipt?.sets?.[0]?.migration_compat).toBe("equal");

      // Receipts and manifest are content-free: no namespace names, no row
      // content, no credentials.
      const manifestText = await Bun.file(
        join(backupDir, "manifest.json"),
      ).text();
      for (const artifact of [
        manifestText,
        JSON.stringify(backup.receipt),
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
          expect(artifact).not.toContain(
            `:${encodeURIComponent(admin.password)}@`,
          );
          if (admin.password.length >= 6) {
            expect(artifact).not.toContain(admin.password);
          }
        }
      }

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
      const failedValidations = (restore.receipt?.validations ?? []).filter(
        (v: any) => v.verdict !== "ok",
      );
      expect(failedValidations).toEqual([]);

      // --- post-restore assertions on the target --------------------------
      const tgtPool = makePool(admin, TGT_DB);
      try {
        // Counts and namespaces survived.
        const { rows: countRows } = await tgtPool.query(
          "SELECT COUNT(*)::int AS count FROM thoughts",
        );
        expect(countRows[0]!.count).toBe(5);
        const { rows: nsRows } = await tgtPool.query(
          "SELECT COUNT(DISTINCT namespace)::int AS count FROM thoughts",
        );
        expect(nsRows[0]!.count).toBe(2);

        // Archived row restored AS archived.
        const { rows: archivedRows } = await tgtPool.query(
          "SELECT archived_at FROM thoughts WHERE content_hash = $1",
          [ARCHIVED_HASH],
        );
        expect(archivedRows.length).toBe(1);
        expect(archivedRows[0]!.archived_at).not.toBeNull();

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
        expect(readRows[0]!.content).toBe("drill alpha thought one");

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
          [laneRows[0]!.id, "fact", "drill post-restore append", "drill"],
        );
        const { rows: eventRows } = await tgtPool.query(
          "SELECT COUNT(*)::int AS count FROM ob_session_events WHERE lane_id = $1",
          [laneRows[0]!.id],
        );
        expect(eventRows[0]!.count).toBe(2);
      } finally {
        await tgtPool.end();
      }
    }, 180_000);

    it("restores into the fresh administrator-bootstrapped non-superuser clone", async () => {
      expect(clone.host).toBe("127.0.0.1");
      expect(clone.user).toBe("open_brain_local_clone");
      expect(clone.database.startsWith("open_brain_local_")).toBe(true);

      const restore = await runCli(
        "restore.ts",
        ["--dir", backupDir, "--target-db-url", dbUrl(clone, clone.database)],
        cliEnv(admin, SRC_DB),
      );
      expect(restore.exitCode).toBe(0);
      expect(restore.receipt?.status).toBe("ok");
      expect(
        (restore.receipt?.validations ?? []).every(
          (v: any) => v.verdict === "ok",
        ),
      ).toBe(true);

      const restored = makePool(clone, clone.database);
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
        expect(readRows[0]!.count).toBeGreaterThan(0);
        await restored.query(
          `INSERT INTO thoughts (content, created_by, namespace, content_hash)
             VALUES ($1, $2, $3, $4)`,
          [
            "non-superuser clone restore write",
            "drill",
            NS_ALPHA,
            "drill-clone-write",
          ],
        );
      } finally {
        await restored.end();
      }
    }, 180_000);

    it("uses one exported snapshot for manifest counts and dump contents across a concurrent commit", async () => {
      const coordinationDir = await tempDir();
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

      const snapshotBackupDir = join(await tempDir(), "set-snapshot");
      const backupPromise = runCli("backup.ts", ["--out", snapshotBackupDir], {
        ...cliEnv(admin, SRC_DB),
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
      const writer = makePool(admin, SRC_DB);
      try {
        await writer.query(
          `INSERT INTO thoughts (content, created_by, namespace, content_hash)
             VALUES ($1, $2, $3, $4)`,
          [
            "concurrent write after exported snapshot",
            "drill",
            NS_ALPHA,
            concurrentHash,
          ],
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
        [
          "--dir",
          snapshotBackupDir,
          "--target-db-url",
          dbUrl(admin, SNAPSHOT_TGT_DB),
        ],
        cliEnv(admin, SRC_DB),
      );
      expect(restore.exitCode).toBe(0);
      expect(restore.receipt?.status).toBe("ok");

      const restored = makePool(admin, SNAPSHOT_TGT_DB);
      try {
        const { rows: countRows } = await restored.query(
          "SELECT COUNT(*)::int AS count FROM thoughts",
        );
        expect(countRows[0]!.count).toBe(manifest.row_counts.thoughts);
        const { rows: concurrentRows } = await restored.query(
          "SELECT 1 FROM thoughts WHERE content_hash = $1",
          [concurrentHash],
        );
        expect(concurrentRows).toEqual([]);
      } finally {
        await restored.end();
      }
    }, 180_000);

    it("refuses a non-empty target without --wipe-target + approval env", async () => {
      // Self-sufficient: ensure the target exists and is non-empty rather
      // than depending on the previous drill test having populated it.
      const adminPool = new pg.Client({
        connectionString: dbUrl(admin, admin.database),
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
        connectionString: dbUrl(admin, TGT_DB),
      });
      await seedPool.connect();
      try {
        await seedPool.query(
          "CREATE TABLE IF NOT EXISTS drill_nonempty_marker (id int)",
        );
      } finally {
        await seedPool.end();
      }
      const noWipe = await runCli(
        "restore.ts",
        ["--dir", backupDir, "--target-db-url", dbUrl(admin, TGT_DB)],
        cliEnv(admin, SRC_DB),
      );
      expect(noWipe.exitCode).not.toBe(0);
      expect(noWipe.receipt?.status).toBe("failed");
      expect(noWipe.receipt?.error).toContain("NOT empty");

      const noApproval = await runCli(
        "restore.ts",
        [
          "--dir",
          backupDir,
          "--target-db-url",
          dbUrl(admin, TGT_DB),
          "--wipe-target",
        ],
        cliEnv(admin, SRC_DB),
      );
      expect(noApproval.exitCode).not.toBe(0);
      expect(noApproval.receipt?.error).toContain(RESTORE_WIPE_APPROVAL_ENV);

      // With the approval env the wipe + restore succeeds.
      const approved = await runCli(
        "restore.ts",
        [
          "--dir",
          backupDir,
          "--target-db-url",
          dbUrl(admin, TGT_DB),
          "--wipe-target",
        ],
        {
          ...cliEnv(admin, SRC_DB),
          [RESTORE_WIPE_APPROVAL_ENV]: RESTORE_WIPE_APPROVAL_VALUE,
        },
      );
      expect(approved.receipt?.status).toBe("ok");
      expect(approved.exitCode).toBe(0);
    }, 180_000);

    it("refuses a target with non-public user schemas even with wipe approval", async () => {
      // The approved wipe only drops schema public; a target carrying user
      // tables in ANY other schema must be refused outright (fail-closed),
      // wipe approval or not.
      const seed = new pg.Client({ connectionString: dbUrl(admin, TGT_DB) });
      await seed.connect();
      try {
        await seed.query("CREATE SCHEMA IF NOT EXISTS drill_foreign");
        await seed.query(
          "CREATE TABLE IF NOT EXISTS drill_foreign.marker (id int)",
        );
      } finally {
        await seed.end();
      }
      const refused = await runCli(
        "restore.ts",
        [
          "--dir",
          backupDir,
          "--target-db-url",
          dbUrl(admin, TGT_DB),
          "--wipe-target",
        ],
        {
          ...cliEnv(admin, SRC_DB),
          [RESTORE_WIPE_APPROVAL_ENV]: RESTORE_WIPE_APPROVAL_VALUE,
        },
      );
      expect(refused.exitCode).not.toBe(0);
      expect(refused.receipt?.status).toBe("failed");
      expect(refused.receipt?.error).toContain("non-public");

      // Nothing was wiped: both the foreign schema AND the existing public
      // tables survived the refusal.
      const check = new pg.Client({ connectionString: dbUrl(admin, TGT_DB) });
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
        expect(publicRows[0]!.count).toBeGreaterThan(0);
        // Clean up so later tests see a public-only target again.
        await check.query("DROP SCHEMA drill_foreign CASCADE");
      } finally {
        await check.end();
      }
    }, 120_000);

    it("old backup (pre-latest-migration) restores into the upgraded runtime and the head advances", async () => {
      // Build a source whose migration head is ONE BEHIND the repo head by
      // migrating with a truncated copy of the migrations directory.
      const allMigrations = (await readdir(MIGRATIONS_DIR))
        .filter((f) => f.endsWith(".sql"))
        .sort();
      expect(allMigrations.length).toBeGreaterThan(1);
      const truncatedDir = await tempDir();
      for (const file of allMigrations.slice(0, -1)) {
        await cp(join(MIGRATIONS_DIR, file), join(truncatedDir, file));
      }

      const oldPool = makePool(admin, OLD_SRC_DB);
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

      const oldBackupDir = join(await tempDir(), "set-old");
      const backup = await runCli(
        "backup.ts",
        ["--out", oldBackupDir],
        cliEnv(admin, OLD_SRC_DB),
      );
      expect(backup.exitCode).toBe(0);
      expect(backup.receipt?.migrations_head).toBe(
        allMigrations[allMigrations.length - 2],
      );

      const verify = await runCli(
        "backup-verify.ts",
        ["--dir", oldBackupDir],
        cliEnv(admin, OLD_SRC_DB),
      );
      expect(verify.exitCode).toBe(0);
      expect(verify.receipt?.sets?.[0]?.migration_compat).toBe(
        "restorable_with_migrations",
      );

      const restore = await runCli(
        "restore.ts",
        ["--dir", oldBackupDir, "--target-db-url", dbUrl(admin, OLD_TGT_DB)],
        cliEnv(admin, OLD_SRC_DB),
      );
      expect(restore.receipt?.status).toBe("ok");
      expect(restore.exitCode).toBe(0);
      expect(restore.receipt?.migrations_applied_forward).toBeGreaterThan(0);

      const tgtPool = makePool(admin, OLD_TGT_DB);
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
    }, 180_000);

    it("a corrupted dump fails CLI verification with a nonzero exit", async () => {
      // Run LAST: this intentionally breaks the first drill's backup set.
      const dumpPath = join(backupDir, "openbrain.dump");
      const original = new Uint8Array(await Bun.file(dumpPath).arrayBuffer());
      original[Math.floor(original.length / 2)]! ^= 0xff;
      await Bun.write(dumpPath, original);

      const verify = await runCli(
        "backup-verify.ts",
        ["--dir", backupDir],
        cliEnv(admin, SRC_DB),
      );
      expect(verify.exitCode).toBe(1);
      expect(verify.receipt?.status).toBe("failed");

      // And restore refuses the corrupted set before touching any target.
      const restore = await runCli(
        "restore.ts",
        ["--dir", backupDir, "--target-db-url", dbUrl(admin, TGT_DB)],
        {
          ...cliEnv(admin, SRC_DB),
          [RESTORE_WIPE_APPROVAL_ENV]: RESTORE_WIPE_APPROVAL_VALUE,
        },
      );
      expect(restore.exitCode).not.toBe(0);
      expect(restore.receipt?.status).toBe("failed");
      expect(restore.receipt?.error).toContain("verification failed");
    }, 120_000);
  });
});
