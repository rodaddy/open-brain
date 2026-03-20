import { describe, expect, test } from "bun:test";
import { canRead, canWrite, PERMISSIONS } from "./permissions.ts";
import type { Role, Table } from "./types.ts";

const ALL_TABLES: Table[] = [
  "thoughts",
  "decisions",
  "relationships",
  "projects",
  "sessions",
];

describe("PERMISSIONS matrix", () => {
  test("exports a PERMISSIONS object keyed by role", () => {
    const roles: Role[] = ["admin", "agent", "discord", "n8n", "readonly"];
    for (const role of roles) {
      expect(PERMISSIONS[role]).toBeDefined();
    }
  });
});

describe("admin role", () => {
  test.each(ALL_TABLES)("canRead(admin, %s) returns true", (table) => {
    expect(canRead("admin", table)).toBe(true);
  });

  test.each(ALL_TABLES)("canWrite(admin, %s) returns true", (table) => {
    expect(canWrite("admin", table)).toBe(true);
  });
});

describe("agent role", () => {
  const rwTables: Table[] = [
    "thoughts",
    "decisions",
    "relationships",
    "sessions",
  ];
  const roTables: Table[] = ["projects"];

  test.each(rwTables)("canRead(agent, %s) returns true", (table) => {
    expect(canRead("agent", table)).toBe(true);
  });

  test.each(rwTables)("canWrite(agent, %s) returns true", (table) => {
    expect(canWrite("agent", table)).toBe(true);
  });

  test.each(roTables)("canRead(agent, %s) returns true", (table) => {
    expect(canRead("agent", table)).toBe(true);
  });

  test.each(roTables)("canWrite(agent, %s) returns false", (table) => {
    expect(canWrite("agent", table)).toBe(false);
  });
});

describe("discord role", () => {
  test("canWrite(discord, thoughts) returns true", () => {
    expect(canWrite("discord", "thoughts")).toBe(true);
  });

  test("canRead(discord, thoughts) returns false", () => {
    expect(canRead("discord", "thoughts")).toBe(false);
  });

  const otherTables: Table[] = [
    "decisions",
    "relationships",
    "projects",
    "sessions",
  ];

  test.each(otherTables)("canRead(discord, %s) returns false", (table) => {
    expect(canRead("discord", table)).toBe(false);
  });

  test.each(otherTables)("canWrite(discord, %s) returns false", (table) => {
    expect(canWrite("discord", table)).toBe(false);
  });
});

describe("n8n role", () => {
  test.each(ALL_TABLES)("canRead(n8n, %s) returns true", (table) => {
    expect(canRead("n8n", table)).toBe(true);
  });

  test.each(ALL_TABLES)("canWrite(n8n, %s) returns true", (table) => {
    expect(canWrite("n8n", table)).toBe(true);
  });
});

describe("readonly role", () => {
  test.each(ALL_TABLES)("canRead(readonly, %s) returns true", (table) => {
    expect(canRead("readonly", table)).toBe(true);
  });

  test.each(ALL_TABLES)("canWrite(readonly, %s) returns false", (table) => {
    expect(canWrite("readonly", table)).toBe(false);
  });
});
