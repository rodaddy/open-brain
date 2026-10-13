/**
 * resolveTestDbServer (issue 1667). Pure: no database.
 *
 * OPENBRAIN_TEST_DB_* picks the server the isolated test database lives on,
 * from the process environment first and then the checkout's `.env`. Unset,
 * the caller keeps today's DB_* resolution (the resolver returns undefined).
 */
import { describe, expect, test } from "vitest";
import { resolveLaneDbConnection, resolveTestDbServer } from "./test-db-server.ts";

const remoteVars = {
  OPENBRAIN_TEST_DB_HOST: "10.0.20.167",
  OPENBRAIN_TEST_DB_PORT: "5433",
  OPENBRAIN_TEST_DB_USER: "open_brain_test",
  OPENBRAIN_TEST_DB_PASSWORD: "remote-secret",
  OPENBRAIN_TEST_TEMPLATE_DB: "open_brain_test_template",
};

const dogfoodFile = {
  DB_HOST: "127.0.0.1",
  DB_PORT: "5432",
  DB_USER: "rico",
  DB_PASSWORD: "local-secret",
};

const ignoreNotice = (): void => undefined;

const expectedRemote = {
  host: "10.0.20.167",
  port: "5433",
  user: "open_brain_test",
  password: "remote-secret",
};

describe("resolveTestDbServer", () => {
  test("set in the process environment: the four variables win over DB_*", () => {
    const resolved = resolveTestDbServer(
      { ...remoteVars, DB_HOST: "127.0.0.1", DB_USER: "rico" },
      dogfoodFile,
    );
    expect(resolved).toEqual(expectedRemote);
  });

  test("set only in .env: read from the file", () => {
    const resolved = resolveTestDbServer({}, { ...dogfoodFile, ...remoteVars });
    expect(resolved).toEqual(expectedRemote);
  });

  test("environment beats .env, variable by variable", () => {
    const resolved = resolveTestDbServer(
      { OPENBRAIN_TEST_DB_PASSWORD: "env-secret" },
      { ...dogfoodFile, ...remoteVars },
    );
    expect(resolved).toEqual({ ...expectedRemote, password: "env-secret" });
  });

  test("an exported DB_HOST does not beat .env's OPENBRAIN_TEST_DB_HOST", () => {
    const resolved = resolveTestDbServer(
      { DB_HOST: "192.0.2.1", DB_USER: "someone" },
      { ...dogfoodFile, ...remoteVars },
    );
    expect(resolved).toEqual(expectedRemote);
  });

  test("an explicitly empty env host beats .env's remote host: no override (local run)", () => {
    expect(
      resolveTestDbServer(
        { OPENBRAIN_TEST_DB_HOST: "" },
        { ...dogfoodFile, ...remoteVars },
      ),
    ).toBeUndefined();
  });

  test("an explicitly empty env password beats .env's password", () => {
    const resolved = resolveTestDbServer(
      { OPENBRAIN_TEST_DB_PASSWORD: "" },
      { ...dogfoodFile, ...remoteVars },
    );
    expect(resolved).toEqual({ ...expectedRemote, password: "" });
  });

  test("a key absent from env falls back to the .env value", () => {
    const { OPENBRAIN_TEST_DB_PORT: _absent, ...envWithoutPort } = remoteVars;
    const resolved = resolveTestDbServer(envWithoutPort, {
      OPENBRAIN_TEST_DB_PORT: "6543",
    });
    expect(resolved).toEqual({ ...expectedRemote, port: "6543" });
  });

  test("unset everywhere: undefined, so the caller keeps today's DB_* path", () => {
    expect(resolveTestDbServer({ DB_HOST: "10.0.0.9" }, dogfoodFile)).toBeUndefined();
    expect(resolveTestDbServer({ OPENBRAIN_TEST_DB_HOST: "" }, {})).toBeUndefined();
  });

  test("loopback host without a template is allowed; port defaults to 5432", () => {
    const resolved = resolveTestDbServer(
      { OPENBRAIN_TEST_DB_HOST: "127.0.0.1", OPENBRAIN_TEST_DB_USER: "tester" },
      {},
    );
    expect(resolved).toEqual({
      host: "127.0.0.1",
      port: "5432",
      user: "tester",
      password: "",
    });
  });

  test("remote host without OPENBRAIN_TEST_TEMPLATE_DB is refused, naming both", () => {
    const { OPENBRAIN_TEST_TEMPLATE_DB: _omitted, ...noTemplate } = remoteVars;
    expect(() => resolveTestDbServer(noTemplate, dogfoodFile)).toThrow(
      /OPENBRAIN_TEST_DB_HOST.*OPENBRAIN_TEST_TEMPLATE_DB/s,
    );
  });

  test("host set without a user is refused rather than borrowing DB_USER", () => {
    expect(() =>
      resolveTestDbServer({ OPENBRAIN_TEST_DB_HOST: "127.0.0.1" }, { DB_USER: "rico" }),
    ).toThrow(/OPENBRAIN_TEST_DB_USER/);
  });

  test("the refusal never carries the password", () => {
    const { OPENBRAIN_TEST_TEMPLATE_DB: _omitted, ...noTemplate } = remoteVars;
    let refusal: unknown;
    try {
      resolveTestDbServer(noTemplate, {});
    } catch (err) {
      refusal = err;
    }
    expect(refusal).toBeInstanceOf(Error);
    expect(String(refusal)).not.toContain("remote-secret");
  });
});

describe("resolveLaneDbConnection (lane-bootstrap --fresh-db)", () => {
  test("unset: the .env file's DB_* exactly as before, process DB_* ignored", () => {
    const notices: string[] = [];
    const conn = resolveLaneDbConnection({ DB_HOST: "192.0.2.1" }, dogfoodFile, (n) =>
      notices.push(n),
    );
    expect(conn).toEqual({
      host: "127.0.0.1",
      port: "5432",
      user: "rico",
      password: "local-secret",
    });
    expect(notices).toEqual([]);
  });

  test("set: the test server wins and the switch is announced without the password", () => {
    const notices: string[] = [];
    const conn = resolveLaneDbConnection(remoteVars, dogfoodFile, (n) =>
      notices.push(n),
    );
    expect(conn).toEqual(expectedRemote);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain("OPENBRAIN_TEST_DB_HOST");
    expect(notices[0]).not.toContain("remote-secret");
  });

  test("unset and .env has no user: today's refusal text", () => {
    expect(() => resolveLaneDbConnection({}, {}, ignoreNotice)).toThrow(
      "no DB_USER/PGUSER in .env; cannot create a test database.",
    );
  });
});
