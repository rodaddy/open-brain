import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { testScratchDir } from "./scratch-dir.ts";
import {
  propagateClonePassword,
  provisionCloneDatabase,
  type AdminConnection,
} from "./clone-database.ts";

const admin: AdminConnection = {
  host: "127.0.0.1",
  port: "5432",
  user: "fixture_admin",
  password: "",
};

const SAVED_ENV = new Map<string, string | undefined>([
  ["PATH", process.env.PATH],
  ["DB_PASSWORD_LOCAL_CLONE", process.env.DB_PASSWORD_LOCAL_CLONE],
  ["FAKE_PSQL_LOG", process.env.FAKE_PSQL_LOG],
  ["FAKE_PSQL_MODE", process.env.FAKE_PSQL_MODE],
  ["FAKE_PSQL_PASSWORD", process.env.FAKE_PSQL_PASSWORD],
]);

afterEach(() => {
  for (const [name, value] of SAVED_ENV) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

function installFakePsql(mode: "existing" | "absent" | "error-on-alter") {
  const root = testScratchDir("clone-database-");
  const bin = join(root, "bin");
  const log = join(root, "psql.log");
  mkdirSync(bin);
  writeFileSync(
    join(bin, "psql"),
    `#!/bin/sh
set -eu
sql=$(cat)
{
  printf 'ARGS:%s\\n' "$*"
  printf 'SQL:%s\\n' "$sql"
} >> "$FAKE_PSQL_LOG"
case "$FAKE_PSQL_MODE" in
  existing|absent)
    [ "$FAKE_PSQL_MODE" = "existing" ] && printf '1\\n' || printf '\\n'
    ;;
  error-on-alter)
    case "$sql" in
      *"ALTER ROLE"*) printf 'psql error: %s\\n' "$FAKE_PSQL_PASSWORD" >&2; exit 1 ;;
      *) printf '1\\n' ;;
    esac
    ;;
esac
`,
  );
  chmodSync(join(bin, "psql"), 0o755);
  process.env.PATH = `${bin}:${SAVED_ENV.get("PATH") ?? ""}`;
  process.env.FAKE_PSQL_LOG = log;
  process.env.FAKE_PSQL_MODE = mode;
  delete process.env.FAKE_PSQL_PASSWORD;
  return log;
}

function calls(log: string): Array<{ args: string; sql: string }> {
  const sections = readFileSync(log, "utf8").trim().split("\nARGS:").filter(Boolean);
  return sections.map((section) => {
    const separator = section.indexOf("\nSQL:");
    const args = separator >= 0 ? section.slice(0, separator) : section;
    const sql = separator >= 0 ? section.slice(separator + "\nSQL:".length) : "";
    return { args: args.replace(/^ARGS:/, ""), sql };
  });
}

describe("clone password configuration", () => {
  test.each<[string, NodeJS.ProcessEnv, Record<string, string>, string | undefined]>([
    [
      "process value wins",
      { DB_PASSWORD_LOCAL_CLONE: "process" },
      { DB_PASSWORD_LOCAL_CLONE: "file" },
      "process",
    ],
    [
      "file value fills an absent process value",
      {},
      { DB_PASSWORD_LOCAL_CLONE: "file" },
      "file",
    ],
    [
      "explicit empty process value wins",
      { DB_PASSWORD_LOCAL_CLONE: "" },
      { DB_PASSWORD_LOCAL_CLONE: "file" },
      "",
    ],
    ["explicit empty file value is preserved", {}, { DB_PASSWORD_LOCAL_CLONE: "" }, ""],
    ["an absent value stays absent", {}, {}, undefined],
  ])("%s", (_name, env, fileEnv, expected) => {
    propagateClonePassword(env, fileEnv);
    expect(env.DB_PASSWORD_LOCAL_CLONE).toBe(expected);
  });
});

describe("clone database provisioning boundary", () => {
  test("fails closed before mutation when an existing role lacks an explicit password", () => {
    const log = installFakePsql("existing");
    delete process.env.DB_PASSWORD_LOCAL_CLONE;

    const result = provisionCloneDatabase(admin, "guard");

    expect("error" in result).toBe(true);
    if (!("error" in result)) return;
    expect(result.error).toContain(
      "DB_PASSWORD_LOCAL_CLONE is unset; refusing to reset its password or create a clone database",
    );
    const observed = calls(log);
    expect(observed).toHaveLength(1);
    expect(observed[0]?.sql).toContain("select 1 from pg_roles");
    expect(
      observed.some(({ sql }) => /ALTER ROLE|CREATE (ROLE|DATABASE)/i.test(sql)),
    ).toBe(false);
  });

  test("keeps new-role provisioning available without a configured password", () => {
    const log = installFakePsql("absent");
    delete process.env.DB_PASSWORD_LOCAL_CLONE;

    const result = provisionCloneDatabase(admin, "new-role");

    expect("error" in result).toBe(false);
    if ("error" in result) return;
    expect(result.database).toBe("open_brain_local_new-role");
    expect(result.role).toBe("open_brain_local_clone");
    expect(result.notices.join(" ")).toContain("created with a generated password");
    expect(result.notices.join(" ")).not.toContain(
      "generated open_brain_local_clone password for this cluster:",
    );
    expect(calls(log).some(({ sql }) => sql.includes("CREATE ROLE"))).toBe(true);
  });

  test("sends password SQL through stdin and redacts a leaked psql error", () => {
    const log = installFakePsql("error-on-alter");
    const password = "fixture-only-password";
    process.env.DB_PASSWORD_LOCAL_CLONE = password;
    process.env.FAKE_PSQL_PASSWORD = password;

    const result = provisionCloneDatabase(admin, "stdin");

    expect("error" in result).toBe(true);
    if (!("error" in result)) return;
    expect(result.error).toContain("[REDACTED]");
    expect(JSON.stringify(result)).not.toContain(password);
    const observed = calls(log);
    const alter = observed.find(({ sql }) => sql.includes("ALTER ROLE"));
    expect(alter).toBeDefined();
    expect(alter?.args).not.toContain(password);
    expect(alter?.args).not.toContain("-c");
    expect(alter?.sql).toContain("ALTER ROLE open_brain_local_clone LOGIN PASSWORD");
  });
});
