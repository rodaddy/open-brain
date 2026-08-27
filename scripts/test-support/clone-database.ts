/**
 * Local-clone database provisioning for the isolated test runner (#904).
 *
 * `scripts/local-clone.test.ts` asserts a real, non-superuser loopback clone:
 * the URL must name `127.0.0.1`/`::1`, a database whose name starts with
 * `open_brain_local_`, and the role `open_brain_local_clone`. CI already builds
 * exactly that (`.github/workflows/ci.yml:132-134`, `:217`, `:231`); the local
 * runner did not, so the suite skipped every local run -- the false green
 * described in #878.
 *
 * This module is the CI recipe, moved into a helper so `scripts/test-isolated.ts`
 * stays inside the file-size rule in `.oxlintrc.json`. It invents nothing: the
 * SQL is the CI SQL, the database is created with the same
 * `ENCODING 'UTF8' TEMPLATE template0` the rest of the runner uses, and the
 * extensions are the two CI installs.
 *
 * THE ROLE IS SHARED AND OUTLIVES THE RUN. `open_brain_local_clone` is created
 * only when absent and is deliberately NOT dropped on exit: it is a single
 * cluster-wide login role that concurrent runs and the operator's own runbook
 * both rely on, and dropping it would break any run still holding it. Creation
 * is idempotent, so repeated runs converge rather than conflict. Only the
 * per-run database is dropped.
 *
 * The role's password comes from `DB_PASSWORD_LOCAL_CLONE` when the caller
 * supplies one (matching the CI variable name), otherwise one is generated. A
 * role that ALREADY exists has its password set to the value this run will use:
 * a shared role's stored password is not knowable from here, and refusing
 * instead would make every run after the first impossible on a given cluster.
 * Every such decision is announced by the caller -- nothing is adjusted
 * silently (operator ruling 2026-08-08).
 *
 * This module lives under `scripts/` deliberately: `.oxlintrc.json` scopes
 * `node/no-process-env` to `server/**` only.
 */

import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";

/** The exact role `scripts/local-clone.test.ts` demands. Not configurable. */
export const CLONE_ROLE = "open_brain_local_clone";

/** The prefix that test asserts on the clone database name. Not configurable. */
export const CLONE_DB_PREFIX = "open_brain_local_";

/** Admin connection details, as `scripts/test-isolated.ts` already resolves them. */
export interface AdminConnection {
  host: string;
  port: string;
  user: string;
  password: string;
}

/** What the caller needs to export and to tear down afterwards. */
export interface CloneProvision {
  database: string;
  role: string;
  url: string;
  /** Human-readable adjustments to print, so no decision is made silently. */
  notices: string[];
}

function runPsql(
  admin: AdminConnection,
  database: string,
  sql: string,
): { ok: boolean; stdout: string; stderr: string } {
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (admin.password) env.PGPASSWORD = admin.password;
  const result = spawnSync(
    "psql",
    [
      "-h",
      admin.host,
      "-p",
      admin.port,
      "-U",
      admin.user,
      "-d",
      database,
      "-At",
      "-v",
      "ON_ERROR_STOP=1",
      "-c",
      sql,
    ],
    { env, encoding: "utf-8" },
  );
  return {
    ok: !result.error && result.status === 0,
    stdout: (result.stdout || "").trim(),
    stderr: (result.error?.message ?? result.stderr ?? "").trim(),
  };
}

/**
 * The admin connection string the runner already holds, in URL form.
 *
 * `scripts/retire-collab-migration.test.ts` needs an admin connection that can
 * `CREATE DATABASE`/`DROP DATABASE`; that is precisely the credential this
 * runner uses for `createdb`/`dropdb`, so it is published rather than rebuilt.
 * It points at the `postgres` maintenance database, never at a per-run one.
 */
export function adminUrl(admin: AdminConnection): string {
  const auth = admin.password
    ? `${encodeURIComponent(admin.user)}:${encodeURIComponent(admin.password)}`
    : encodeURIComponent(admin.user);
  return `postgres://${auth}@${admin.host}:${admin.port}/postgres`;
}

function ensureCloneRole(
  admin: AdminConnection,
  notices: string[],
): { password: string } | { error: string } {
  const existing = runPsql(
    admin,
    "postgres",
    `select 1 from pg_roles where rolname = '${CLONE_ROLE}';`,
  );
  if (!existing.ok) {
    return { error: `could not query pg_roles: ${existing.stderr}` };
  }

  const supplied = process.env.DB_PASSWORD_LOCAL_CLONE;
  const password = supplied || randomBytes(18).toString("base64url");

  if (existing.stdout === "1") {
    // The role is shared and outlives every run, so its stored password is not
    // knowable from here. Rather than fail -- which would make a second run on
    // any cluster impossible -- the admin connection SETS the password it is
    // about to use. This is announced, never silent: an operator who had their
    // own password on this role needs to see that it changed.
    const reset = runPsql(
      admin,
      "postgres",
      `ALTER ROLE ${CLONE_ROLE} LOGIN PASSWORD '${password}';`,
    );
    if (!reset.ok) {
      return { error: `role ${CLONE_ROLE} exists but its password could not be set: ${reset.stderr}` };
    }
    notices.push(
      supplied
        ? `role ${CLONE_ROLE} already existed; its password was RESET to the DB_PASSWORD_LOCAL_CLONE value so this run can log in (the role is shared and is never dropped here)`
        : `role ${CLONE_ROLE} already existed; DB_PASSWORD_LOCAL_CLONE was unset, so its password was RESET to a freshly generated one for this run (the role is shared and is never dropped here). Export DB_PASSWORD_LOCAL_CLONE to keep a stable password instead`,
    );
    return { password };
  }

  const created = runPsql(
    admin,
    "postgres",
    `CREATE ROLE ${CLONE_ROLE} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD '${password}';`,
  );
  if (!created.ok) return { error: `could not create ${CLONE_ROLE}: ${created.stderr}` };

  notices.push(
    supplied
      ? `role ${CLONE_ROLE} created with the DB_PASSWORD_LOCAL_CLONE password; it is shared and is NOT dropped on exit`
      : `role ${CLONE_ROLE} created with a generated password; DB_PASSWORD_LOCAL_CLONE was unset. The role is shared and is NOT dropped on exit -- export that password on later runs, or reset it via ALTER ROLE`,
  );
  if (!supplied) {
    notices.push(`generated ${CLONE_ROLE} password for this cluster: ${password}`);
  }
  return { password };
}

/**
 * Create the clone role (if absent) and a per-run clone database owned by it.
 *
 * @param admin  the runner's own admin connection
 * @param suffix the unique per-run suffix, so the clone shares the run's identity
 * @returns the provisioned clone, or `{ error }` describing what stopped it
 */
export function provisionCloneDatabase(
  admin: AdminConnection,
  suffix: string,
): CloneProvision | { error: string } {
  const notices: string[] = [];
  const role = ensureCloneRole(admin, notices);
  if ("error" in role) return role;

  const database = `${CLONE_DB_PREFIX}${suffix}`;
  const created = runPsql(
    admin,
    "postgres",
    `CREATE DATABASE ${database} OWNER ${CLONE_ROLE} ENCODING 'UTF8' TEMPLATE template0;`,
  );
  if (!created.ok) return { error: `could not create ${database}: ${created.stderr}` };

  // Administrative bootstrap only, exactly as ci.yml:222-225 does it: the
  // clone role stays a non-superuser and cannot install extensions itself.
  const extensions = runPsql(
    admin,
    database,
    "CREATE EXTENSION IF NOT EXISTS vector; CREATE EXTENSION IF NOT EXISTS pg_stat_statements;",
  );
  if (!extensions.ok) {
    return { error: `could not install extensions in ${database}: ${extensions.stderr}` };
  }

  // The test asserts literal loopback, so the host is 127.0.0.1 regardless of
  // how the admin connection spells it. Announced when they differ.
  if (admin.host !== "127.0.0.1") {
    notices.push(
      `clone URL host set to 127.0.0.1 (admin host is ${admin.host}); the local-clone boundary requires literal loopback`,
    );
  }
  const url = `postgres://${CLONE_ROLE}:${encodeURIComponent(role.password)}@127.0.0.1:${admin.port}/${database}`;

  return { database, role: CLONE_ROLE, url, notices };
}
