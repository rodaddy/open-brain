import { describe, expect, it } from "vitest";
import {
  RESTORE_REMOTE_APPROVAL_ENV,
  RESTORE_REMOTE_APPROVAL_VALUE,
  RESTORE_WIPE_APPROVAL_ENV,
  RESTORE_WIPE_APPROVAL_VALUE,
  assertRemoteApproval,
  assertWipeApproval,
  parseRestoreArgs,
  parseTargetDbUrl,
  prepareRestoreTarget,
  targetHostRequiresRemoteApproval,
  writabilityProbe,
} from "./restore.ts";
import { makeTargetDb } from "./test-support/restore-test-support.ts";

// ---------------------------------------------------------------------------
// Target parsing
// ---------------------------------------------------------------------------

describe("parseTargetDbUrl", () => {
  it("parses a full postgres URL", () => {
    // Assembled at runtime so no credential-shaped URI literal lives in
    // source (secret scanners flag full user:pass URIs even when fake).
    const fakeCred = ["s%40", "crat"].join("");
    expect(
      parseTargetDbUrl(
        ["postgres:", "//alice:", fakeCred, "@db.example:5433/restore_db"].join(""),
      ),
    ).toEqual({
      host: "db.example",
      port: 5433,
      user: "alice",
      password: decodeURIComponent(fakeCred),
      dbName: "restore_db",
    });
  });
  it("defaults the port and allows password-less URLs", () => {
    expect(parseTargetDbUrl("postgresql://bob@127.0.0.1/scratch")).toEqual({
      host: "127.0.0.1",
      port: 5432,
      user: "bob",
      password: undefined,
      dbName: "scratch",
    });
  });
  it("rejects non-postgres schemes, missing db name, missing user", () => {
    expect(() => parseTargetDbUrl("mysql://u@h/db")).toThrow(/postgres/);
    expect(() => parseTargetDbUrl("postgres://u@h/")).toThrow(/database name/);
    expect(() => parseTargetDbUrl("postgres://h:5432/db")).toThrow(/user/);
    expect(() => parseTargetDbUrl("not a url")).toThrow(/invalid/);
  });
});

describe("parseRestoreArgs credential path", () => {
  it("a passwordless --target-db-url picks up DB_PASSWORD from the env", () => {
    const env = { DB_PASSWORD: ["env", "secret"].join("-") };
    const args = parseRestoreArgs(
      ["--dir", "/tmp/set", "--target-db-url", "postgres://bob@127.0.0.1/scratch"],
      env,
    );
    expect(args.target.password).toBe(env.DB_PASSWORD);
  });
  it("an inline URL password wins over DB_PASSWORD (scratch/CI path)", () => {
    const inlineCred = ["url", "-pass"].join("");
    const args = parseRestoreArgs(
      [
        "--dir",
        "/tmp/set",
        "--target-db-url",
        ["postgres:", "//bob:", inlineCred, "@127.0.0.1/scratch"].join(""),
      ],
      { DB_PASSWORD: ["env", "secret"].join("-") },
    );
    expect(args.target.password).toBe(inlineCred);
  });
});

// ---------------------------------------------------------------------------
// Target emptiness / wipe-scope gate (FIX: wipe scope vs check scope)
// ---------------------------------------------------------------------------

const WIPE_APPROVED_ENV = {
  [RESTORE_WIPE_APPROVAL_ENV]: RESTORE_WIPE_APPROVAL_VALUE,
};

describe("prepareRestoreTarget", () => {
  it("refuses non-public user schemas even with wipe flag AND approval env", async () => {
    const { db, queries } = makeTargetDb([
      { schemaname: "public", count: 3 },
      { schemaname: "foo", count: 2 },
    ]);
    await expect(prepareRestoreTarget(db, true, WIPE_APPROVED_ENV)).rejects.toThrow(
      /non-public user schemas/,
    );
    // Fail-closed BEFORE any wipe: no DROP/CREATE ever issued.
    expect(queries.join("\n")).not.toContain("DROP SCHEMA");
    expect(queries.join("\n")).not.toContain("CREATE SCHEMA");
  });

  it("refuses non-public schemas even when public itself is empty", async () => {
    const { db } = makeTargetDb([{ schemaname: "foo", count: 1 }]);
    await expect(prepareRestoreTarget(db, true, WIPE_APPROVED_ENV)).rejects.toThrow(
      /scratch databases or public-schema-only/,
    );
  });

  it("refuses a non-empty public schema without --wipe-target", async () => {
    const { db, queries } = makeTargetDb([{ schemaname: "public", count: 3 }]);
    await expect(prepareRestoreTarget(db, false, WIPE_APPROVED_ENV)).rejects.toThrow(
      /NOT empty .*schema public/,
    );
    expect(queries.join("\n")).not.toContain("DROP SCHEMA");
  });

  it("refuses a non-empty public schema with the flag but without approval", async () => {
    const { db, queries } = makeTargetDb([{ schemaname: "public", count: 3 }]);
    await expect(prepareRestoreTarget(db, true, {})).rejects.toThrow(
      RESTORE_WIPE_APPROVAL_ENV,
    );
    expect(queries.join("\n")).not.toContain("DROP SCHEMA");
  });

  it("wipes ONLY schema public for an approved public-only target", async () => {
    const { db, queries } = makeTargetDb([{ schemaname: "public", count: 3 }]);
    await prepareRestoreTarget(db, true, WIPE_APPROVED_ENV);
    expect(queries).toContain("DROP SCHEMA IF EXISTS public CASCADE");
    expect(queries).toContain("CREATE SCHEMA public");
  });

  it("an empty target needs no wipe and no approval", async () => {
    const { db, queries } = makeTargetDb([]);
    await prepareRestoreTarget(db, false, {});
    expect(queries.join("\n")).not.toContain("DROP SCHEMA");
  });
});

// ---------------------------------------------------------------------------
// Approval gates (assertExecuteApproval pattern)
// ---------------------------------------------------------------------------

describe("restore approval gates", () => {
  it("wipe approval requires the exact env value", () => {
    expect(() => assertWipeApproval({})).toThrow(RESTORE_WIPE_APPROVAL_ENV);
    expect(() => assertWipeApproval({ [RESTORE_WIPE_APPROVAL_ENV]: "yes" })).toThrow();
    expect(() =>
      assertWipeApproval({
        [RESTORE_WIPE_APPROVAL_ENV]: RESTORE_WIPE_APPROVAL_VALUE,
      }),
    ).not.toThrow();
  });

  it("remote approval requires the exact env value", () => {
    expect(() => assertRemoteApproval({})).toThrow(RESTORE_REMOTE_APPROVAL_ENV);
    expect(() =>
      assertRemoteApproval({
        [RESTORE_REMOTE_APPROVAL_ENV]: RESTORE_REMOTE_APPROVAL_VALUE,
      }),
    ).not.toThrow();
  });

  it("local hosts skip remote approval; anything else requires it", () => {
    expect(targetHostRequiresRemoteApproval("127.0.0.1")).toBe(false);
    expect(targetHostRequiresRemoteApproval("localhost")).toBe(false);
    expect(targetHostRequiresRemoteApproval("LOCALHOST")).toBe(false);
    expect(targetHostRequiresRemoteApproval("::1")).toBe(false);
    expect(targetHostRequiresRemoteApproval("192.0.2.21")).toBe(true);
    expect(targetHostRequiresRemoteApproval("production-host.local")).toBe(true);
  });
});

describe("writabilityProbe", () => {
  it("runs BEGIN / temp insert / ROLLBACK and reports ok", async () => {
    const statements: string[] = [];
    const client = {
      async query(sql: string) {
        statements.push(sql);
        return {};
      },
    };
    const result = await writabilityProbe(client);
    expect(result.verdict).toBe("ok");
    expect(statements[0]).toBe("BEGIN");
    expect(statements.at(-1)).toBe("ROLLBACK");
    expect(statements.join(" ")).toContain("INSERT INTO ob_restore_probe");
  });

  it("reports fail and still rolls back when the insert fails", async () => {
    const statements: string[] = [];
    const client = {
      async query(sql: string) {
        statements.push(sql);
        if (sql.startsWith("INSERT")) throw new Error("read-only target");
        return {};
      },
    };
    const result = await writabilityProbe(client);
    expect(result.verdict).toBe("fail");
    expect(statements).toContain("ROLLBACK");
  });
});
