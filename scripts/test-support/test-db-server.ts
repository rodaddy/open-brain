/**
 * Which server the isolated test database lives on (issue 1667).
 *
 * The checkout's `.env` `DB_*` names the local dogfood database, which operator
 * scripts and `psql` rely on, so it cannot also point the suite at the shared
 * test server (k3s `general`). The test server therefore has its own four
 * variables:
 *
 *   OPENBRAIN_TEST_DB_HOST  OPENBRAIN_TEST_DB_PORT
 *   OPENBRAIN_TEST_DB_USER  OPENBRAIN_TEST_DB_PASSWORD
 *
 * PRECEDENCE. Each variable is read from the process environment when the key
 * is PRESENT there (even empty), else from the checkout's `.env` file, else
 * empty. An explicitly empty OPENBRAIN_TEST_DB_HOST therefore means "no
 * test-server override" (local): the escape hatch for a one-off local run when
 * `.env` points remote. Whenever
 * OPENBRAIN_TEST_DB_HOST is set (environment or `.env`), these four WIN over
 * every `DB_*`/`PG*` value, including an explicitly exported DB_HOST: `DB_*`
 * is the dogfood connection, not the test server. When it is unset (or empty)
 * the resolver returns `undefined` and the caller keeps today's `DB_*`
 * resolution byte-for-byte.
 *
 * Covers the main test-database admin connection only: `test:isolated`
 * (create/migrate/drop of the isolated database) and `lane-bootstrap.ts
 * --fresh-db`. The local-clone database and the backup/restore drill stay on
 * the `.env` loopback server (`resolveCloneAdmin`, `resolveDrillAdmin`).
 *
 * A non-loopback host without OPENBRAIN_TEST_TEMPLATE_DB is refused up front:
 * the shared server's test role cannot `CREATE EXTENSION vector`, so a
 * template0 database would fail at migration (docs/lane-contract.md, 2026-10-04
 * harvest, lesson 1).
 *
 * Lives under `scripts/`: `.oxlintrc.json` scopes `node/no-process-env` to
 * `server/**` only.
 */

import type { AdminConnection } from "./clone-database.ts";
import { resolveTestTemplateDb, TEST_TEMPLATE_DB_ENV } from "./test-template-db.ts";

export const TEST_DB_HOST_ENV = "OPENBRAIN_TEST_DB_HOST";
export const TEST_DB_PORT_ENV = "OPENBRAIN_TEST_DB_PORT";
export const TEST_DB_USER_ENV = "OPENBRAIN_TEST_DB_USER";
export const TEST_DB_PASSWORD_ENV = "OPENBRAIN_TEST_DB_PASSWORD";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

type Env = Readonly<Record<string, string | undefined>>;

/**
 * Resolve the test-database server from OPENBRAIN_TEST_DB_*.
 *
 * @param env     the process environment (wins)
 * @param fileEnv the checkout's `.env` values, parsed from the file
 * @returns the admin connection, or `undefined` when OPENBRAIN_TEST_DB_HOST is unset
 * @throws Error when the host is set without a user, or is non-loopback without
 *   OPENBRAIN_TEST_TEMPLATE_DB (or that template name is invalid)
 */
export function resolveTestDbServer(
  env: Env,
  fileEnv: Readonly<Record<string, string>>,
): AdminConnection | undefined {
  // A key PRESENT in the environment wins even when empty; absent, `.env`.
  const pick = (key: string): string => (key in env ? env[key] : fileEnv[key]) ?? "";
  const host = pick(TEST_DB_HOST_ENV);
  if (!host) return undefined;

  const user = pick(TEST_DB_USER_ENV);
  if (!user) {
    throw new Error(
      `${TEST_DB_HOST_ENV} is set but ${TEST_DB_USER_ENV} is not; refusing to fall back to DB_USER (the dogfood connection)`,
    );
  }

  if (!LOOPBACK_HOSTS.has(host)) {
    const template = resolveTestTemplateDb({
      [TEST_TEMPLATE_DB_ENV]:
        env[TEST_TEMPLATE_DB_ENV] ?? fileEnv[TEST_TEMPLATE_DB_ENV],
    });
    if (template === undefined) {
      throw new Error(
        `${TEST_DB_HOST_ENV}=${host} is a remote server but ${TEST_TEMPLATE_DB_ENV} is not set; a remote test server needs the pre-built template (docs/lane-contract.md, 2026-10-04 harvest, lesson 1)`,
      );
    }
  }

  return {
    host,
    port: pick(TEST_DB_PORT_ENV) || "5432",
    user,
    password: pick(TEST_DB_PASSWORD_ENV),
  };
}

/** The announcement both callers print when the override is in effect. */
export function describeTestDbServer(server: AdminConnection, ignored: string): string {
  return `test database server from ${TEST_DB_HOST_ENV}: ${server.host}:${server.port} as ${server.user} (${ignored} ignored for the test database)`;
}

/**
 * `lane-bootstrap.ts --fresh-db`'s admin connection: OPENBRAIN_TEST_DB_* when
 * set (announced), else the `.env` file's DB_* and PG* values exactly as before -- that
 * path reads the FILE only, not the process environment.
 *
 * @throws Error from resolveTestDbServer, or when `.env` names no DB_USER/PGUSER
 */
export function resolveLaneDbConnection(
  env: Env,
  fileEnv: Readonly<Record<string, string>>,
  announce: (notice: string) => void,
): AdminConnection {
  const server = resolveTestDbServer(env, fileEnv);
  if (server) {
    announce(describeTestDbServer(server, ".env DB_*"));
    return server;
  }
  const user = fileEnv.DB_USER || fileEnv.PGUSER;
  if (!user)
    throw new Error("no DB_USER/PGUSER in .env; cannot create a test database.");
  return {
    host: fileEnv.DB_HOST || fileEnv.PGHOST || "127.0.0.1",
    port: fileEnv.DB_PORT || fileEnv.PGPORT || "5432",
    user,
    password: fileEnv.DB_PASSWORD || fileEnv.PGPASSWORD || "",
  };
}
