import { afterAll, describe, expect, it } from "vitest";
import {
  DUMP_FILENAME,
  buildManifest,
  gatherDbInfo,
  redactSecret,
  resolvePgTool,
  summarizeChildStderr,
  verifyBackupSet,
  type Queryable,
} from "./backup-lib.ts";
import {
  CONTENT_SENTINEL,
  NS_SENTINEL,
  PASSWORD_SENTINEL,
  RUNTIME,
  cleanupTempDirs,
  tempDir,
  writeSet,
} from "./test-support/backup-fixtures.ts";

afterAll(cleanupTempDirs);

// ---------------------------------------------------------------------------
// gatherDbInfo: counts only, content-free by construction
// ---------------------------------------------------------------------------

type FakeRows = { rows: Array<Record<string, unknown>> };

/** Rows for the two information_schema probes the gatherer runs first. */
function schemaProbeRows(sql: string, table: string): FakeRows | null {
  if (sql.includes("information_schema.tables")) {
    const exists = ["_migrations", "thoughts", "ob_session_lanes"].includes(table);
    return { rows: exists ? [{ "1": 1 }] : [] };
  }
  if (sql.includes("information_schema.columns")) {
    const hasColumn = ["thoughts", "ob_session_lanes"].includes(table);
    return { rows: hasColumn ? [{ "1": 1 }] : [] };
  }
  return null;
}

/**
 * Rows for the count/version queries, deliberately carrying namespace names and
 * row content alongside the counts, as a hostile driver could.
 */
function countProbeRows(sql: string): FakeRows | null {
  if (sql.includes("FROM _migrations")) {
    return {
      rows: [{ filename: "001_init.sql" }, { filename: "002_curation.sql" }],
    };
  }
  if (sql.includes("pg_extension")) {
    return { rows: [{ extversion: "0.8.2" }] };
  }
  if (sql.includes(") AS ns")) {
    // Hostile shape: count plus a namespace name in the same row.
    return { rows: [{ count: 2, namespace: NS_SENTINEL }] };
  }
  if (sql.includes("archived_at IS NOT NULL")) {
    return { rows: [{ count: 1, content: CONTENT_SENTINEL }] };
  }
  if (sql.startsWith("SELECT COUNT(*)::bigint AS count FROM ")) {
    return { rows: [{ count: 7, content: CONTENT_SENTINEL }] };
  }
  return null;
}

/**
 * Fake Queryable that deliberately RETURNS namespace names and row content in
 * its result rows; gatherDbInfo must only ever read counts/versions out of them.
 */
function makeFakeDb(): Queryable {
  return {
    async query(sql: string, params?: unknown[]) {
      const firstParam = params?.[0];
      const table = typeof firstParam === "string" ? firstParam : "";
      const rows = schemaProbeRows(sql, table) ?? countProbeRows(sql);
      if (rows) return rows;
      throw new Error(`unexpected query in fake db: ${sql}`);
    },
  };
}

describe("gatherDbInfo content freedom", () => {
  it("extracts counts only — no namespace names, row content, or credentials in the manifest", async () => {
    process.env.DB_PASSWORD_TEST_SENTINEL = PASSWORD_SENTINEL;
    const info = await gatherDbInfo(makeFakeDb());
    expect(info.appliedMigrations).toEqual(["001_init.sql", "002_curation.sql"]);
    expect(info.distinctNamespaces).toBe(2);
    expect(info.rowCounts.thoughts).toBe(7);
    expect(info.archivedRowCounts.thoughts).toBe(1);

    const manifest = buildManifest({
      dbInfo: info,
      source: { db_host: "127.0.0.1", db_port: 5432, db_name: "unit_db" },
      contract: {
        version: RUNTIME.contractVersion,
        schema_hash: "f".repeat(64),
      },
      embedding: { model: "m", dimensions: 768 },
      files: [{ name: DUMP_FILENAME, sha256: "0".repeat(64), bytes: 10 }],
      hostname: "unit-host",
    });
    const serialized = JSON.stringify(manifest);
    expect(serialized).not.toContain(NS_SENTINEL);
    expect(serialized).not.toContain(CONTENT_SENTINEL);
    expect(serialized).not.toContain(PASSWORD_SENTINEL);
  });

  it("refuses to back up a database without _migrations tracking", async () => {
    const db: Queryable = {
      async query(sql: string) {
        if (sql.includes("information_schema.tables")) return { rows: [] };
        throw new Error("should not reach further queries");
      },
    };
    await expect(gatherDbInfo(db)).rejects.toThrow(/_migrations/);
  });
});

describe("verify result serialization content freedom", () => {
  it("verify verdicts carry no credentials even when env holds them", async () => {
    const dir = await tempDir();
    await writeSet(dir);
    const result = await verifyBackupSet(dir, RUNTIME);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(PASSWORD_SENTINEL);
    expect(serialized).not.toContain(NS_SENTINEL);
  });
});

// ---------------------------------------------------------------------------
// pg tool resolution + redaction
// ---------------------------------------------------------------------------

describe("pg tool resolution", () => {
  it("defaults to the bare tool name", () => {
    expect(resolvePgTool("pg_dump", {})).toEqual(["pg_dump"]);
    expect(resolvePgTool("pg_restore", {})).toEqual(["pg_restore"]);
  });
  it("splits docker-exec overrides into argv tokens (no shell)", () => {
    const container = ["ob", "ci"].join("");
    expect(
      resolvePgTool("pg_dump", {
        OPENBRAIN_PG_DUMP_BIN: ["docker exec -e PGPASSWORD", container, "pg_dump"].join(
          " ",
        ),
      }),
    ).toEqual(["docker", "exec", "-e", "PGPASSWORD", container, "pg_dump"]);
  });
});

describe("summarizeChildStderr", () => {
  const ROW_SENTINEL = "SENTINEL-STDERR-ROW-CONTENT";
  it("keeps only the error class from a mid-COPY failure", () => {
    const stderr = [
      `pg_restore: error: COPY failed for table "thoughts": ERROR:  value too long`,
      `CONTEXT:  COPY thoughts, line 42: "${ROW_SENTINEL} secret row body"`,
      `DETAIL:  Key (content_hash)=(${ROW_SENTINEL}) already exists.`,
      `HINT:  something ${ROW_SENTINEL}`,
    ].join("\n");
    const summary = summarizeChildStderr(stderr);
    expect(summary).toBe("COPY failed for table");
    expect(summary).not.toContain(ROW_SENTINEL);
    expect(summary).not.toContain('"');
  });
  it("cuts at the first colon or quote of the class line", () => {
    expect(
      summarizeChildStderr(`pg_dump: error: connection to server at 'x' failed`),
    ).toBe("connection to server at");
    expect(summarizeChildStderr("something bad happened")).toBe(
      "something bad happened",
    );
  });
  it("handles empty and prefix-only stderr", () => {
    expect(summarizeChildStderr("")).toBe("no stderr output");
    expect(summarizeChildStderr("\n\n")).toBe("no stderr output");
    expect(summarizeChildStderr("pg_restore: error:")).toBe("unclassifiable stderr");
  });

  // Issue #537: a child that colorizes its own stderr (a TTY, or any
  // environment carrying FORCE_COLOR — which the local dev machine sets and
  // CI does not) emits SGR escapes BEFORE the tool-name prefix. Those leading
  // escapes defeat the ^-anchored prefix strip, so the class line was cut at
  // the colon after "pg_dump" and the real class was lost.
  describe("terminal control sequences", () => {
    const ESC = "\u001B";
    const BEL = "\u0007";

    /**
     * True when `text` holds any C0 or C1 control character, decided by code
     * point so the assertion carries no control-character pattern of its own.

     */
    const hasControlCharacter = (text: string): boolean =>
      Array.from(text, (character) => {
        const code = character.codePointAt(0) ?? 0;
        return code <= 0x1f || (code >= 0x7f && code <= 0x9f);
      }).some(Boolean);

    it("classifies a colorized line the same as a plain one", () => {
      const plain = "pg_dump: error: query failed: ERROR:  canceling statement";
      const colorized = `${ESC}[0m${ESC}[31m${plain}${ESC}[0m`;
      expect(summarizeChildStderr(plain)).toBe("query failed");
      expect(summarizeChildStderr(colorized)).toBe("query failed");
    });

    it("strips CSI, OSC, and bare two-character escapes", () => {
      expect(summarizeChildStderr(`${ESC}[1;31mpg_restore: error: COPY failed`)).toBe(
        "COPY failed",
      );
      expect(
        summarizeChildStderr(`${ESC}]0;window title${BEL}pg_dump: error: boom`),
      ).toBe("boom");
      expect(summarizeChildStderr(`${ESC}Mpg_dump: error: boom`)).toBe("boom");
    });

    it("never lets a control character reach the summary", () => {
      const summary = summarizeChildStderr(
        `${ESC}[31mpg_restore: error: COPY failed for table${ESC}[0m`,
      );
      expect(summary).toBe("COPY failed for table");
      expect(hasControlCharacter(summary)).toBe(false);
    });

    it("treats a line that is only control characters as empty", () => {
      expect(summarizeChildStderr(`${ESC}[0m${ESC}[0m`)).toBe("no stderr output");
      // A colorized blank first line falls through to the next real line.
      expect(summarizeChildStderr(`${ESC}[0m\npg_dump: error: query failed: x`)).toBe(
        "query failed",
      );
    });

    it("still refuses to carry row content out of a colorized COPY failure", () => {
      const stderr = [
        `${ESC}[31mpg_restore: error: COPY failed for table "thoughts": ERROR:  value too long${ESC}[0m`,
        `${ESC}[31mCONTEXT:  COPY thoughts, line 42: "${ROW_SENTINEL}"${ESC}[0m`,
      ].join("\n");
      const summary = summarizeChildStderr(stderr);
      expect(summary).toBe("COPY failed for table");
      expect(summary).not.toContain(ROW_SENTINEL);
      expect(summary).not.toContain('"');
    });
  });
});

describe("redactSecret", () => {
  it("strips every occurrence of the secret", () => {
    expect(
      redactSecret(
        `fail ${PASSWORD_SENTINEL} x ${PASSWORD_SENTINEL}`,
        PASSWORD_SENTINEL,
      ),
    ).toBe("fail [redacted] x [redacted]");
  });
  it("is a no-op for empty/undefined secrets", () => {
    expect(redactSecret("text", undefined)).toBe("text");
    expect(redactSecret("text", "")).toBe("text");
  });
});
