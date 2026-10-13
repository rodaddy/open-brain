/**
 * Which server the local-clone database is provisioned on (issue 1667).
 *
 * `scripts/local-clone.test.ts` asserts a LOOPBACK clone by design, and
 * `provisionCloneDatabase` builds its URL on 127.0.0.1. When the main suite
 * runs against a remote server (the process environment sets DB_HOST to it),
 * provisioning the clone with that remote admin connection both creates the
 * clone on the wrong server and needs CREATEROLE the remote test role does not
 * hold. So the clone's admin connection is the checkout's `.env` loopback
 * server, read from the FILE (not the process environment, which now names the
 * remote one). Its template is `template0`: the loopback admin installs the
 * extensions itself, as it always has, and the remote template does not exist
 * there.
 *
 * When the main database is already on loopback, the result is the main
 * connection unchanged, with the template override honoured -- today's
 * behaviour byte-for-byte.
 *
 * Lives under `scripts/`: `.oxlintrc.json` scopes `node/no-process-env` to
 * `server/**` only.
 */

import type { AdminConnection } from "./clone-database.ts";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

/** The clone's admin connection and how its database is created. */
export interface CloneAdmin {
  admin: AdminConnection;
  /** False when the clone server differs from the main one: use template0, not OPENBRAIN_TEST_TEMPLATE_DB. */
  useTestTemplate: boolean;
  /** Announced by the caller; nothing is adjusted silently. */
  notices: string[];
}

function isLoopback(host: string): boolean {
  return LOOPBACK_HOSTS.has(host);
}

/**
 * Resolve the admin connection the local-clone database is provisioned with.
 *
 * @param main    the main suite's admin connection (environment first, then `.env`)
 * @param fileEnv the checkout's `.env` values, parsed from the file only
 * @returns `main` unchanged when it is loopback (or `.env` names no loopback
 *   server); otherwise the `.env` loopback connection with template0
 */
export function resolveCloneAdmin(
  main: AdminConnection,
  fileEnv: Readonly<Record<string, string>>,
): CloneAdmin {
  const unchanged: CloneAdmin = { admin: main, useTestTemplate: true, notices: [] };
  if (isLoopback(main.host)) return unchanged;

  const pick = (...keys: string[]): string => {
    for (const key of keys) if (fileEnv[key]) return fileEnv[key];
    return "";
  };
  const user = pick("DB_USER", "PGUSER");
  const host = pick("DB_HOST", "PGHOST") || "127.0.0.1";
  if (!user || !isLoopback(host)) return unchanged;

  const admin: AdminConnection = {
    host,
    port: pick("DB_PORT", "PGPORT") || "5432",
    user,
    password: pick("DB_PASSWORD", "PGPASSWORD"),
  };
  return {
    admin,
    useTestTemplate: false,
    notices: [
      `clone provisioned on the .env loopback server ${admin.host}:${admin.port} as ${admin.user} (main database host is ${main.host}); clone template is template0`,
    ],
  };
}
