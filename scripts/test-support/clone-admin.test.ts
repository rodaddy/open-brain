/**
 * resolveCloneAdmin (issue 1667). Pure: no database.
 *
 * A remote main database must not take the local clone with it: the clone is
 * provisioned on the `.env` loopback server with template0. A loopback main
 * database keeps today's config unchanged.
 */
import { describe, expect, test } from "vitest";
import { resolveCloneAdmin } from "./clone-admin.ts";
import type { AdminConnection } from "./clone-database.ts";

const fileEnv = {
  DB_HOST: "127.0.0.1",
  DB_PORT: "5432",
  DB_USER: "local_admin",
  DB_PASSWORD: "local-secret",
  PGHOST: "127.0.0.1",
  PGUSER: "local_admin",
};

const local: AdminConnection = {
  host: "127.0.0.1",
  port: "5432",
  user: "local_admin",
  password: "local-secret",
};

const remote: AdminConnection = {
  host: "10.0.20.167",
  port: "5432",
  user: "open_brain_test",
  password: "remote-secret",
};

describe("resolveCloneAdmin", () => {
  test("env host remote + .env loopback: clone admin is the .env loopback config on template0", () => {
    const resolved = resolveCloneAdmin(remote, fileEnv);
    expect(resolved.admin).toEqual(local);
    expect(resolved.useTestTemplate).toBe(false);
    expect(resolved.notices).toHaveLength(1);
    expect(resolved.notices[0]).toContain("10.0.20.167");
    expect(resolved.notices.join("\n")).not.toContain("local-secret");
  });

  test("no env override: the main config is returned unchanged", () => {
    const resolved = resolveCloneAdmin(local, fileEnv);
    expect(resolved.admin).toBe(local);
    expect(resolved.useTestTemplate).toBe(true);
    expect(resolved.notices).toEqual([]);
  });

  test("libpq spellings in .env are honoured, defaults fill host and port", () => {
    const resolved = resolveCloneAdmin(remote, { PGUSER: "pg_admin" });
    expect(resolved.admin).toEqual({
      host: "127.0.0.1",
      port: "5432",
      user: "pg_admin",
      password: "",
    });
  });

  test(".env naming a non-loopback server leaves today's config in place", () => {
    const resolved = resolveCloneAdmin(remote, { ...fileEnv, DB_HOST: "10.0.0.9" });
    expect(resolved.admin).toBe(remote);
    expect(resolved.useTestTemplate).toBe(true);
  });
});
