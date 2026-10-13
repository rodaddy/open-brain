/**
 * OPENBRAIN_TEST_TEMPLATE_DB resolution (issue 1667). Pure: no database.
 *
 * Unset must reproduce today's commands byte-for-byte; a valid name must be
 * used (quoted in SQL); anything that is not a plain Postgres identifier must be
 * refused before it reaches a command line or a SQL string.
 */
import { describe, expect, test } from "vitest";
import {
  createdbTemplate,
  propagateTestTemplateDb,
  resolveTestTemplateDb,
  sqlTemplateClause,
  TEST_TEMPLATE_DB_ENV,
} from "./test-template-db.ts";

const env = (value: string | undefined): Record<string, string | undefined> => ({
  [TEST_TEMPLATE_DB_ENV]: value,
});

describe("resolveTestTemplateDb", () => {
  test("unset or empty means no template override", () => {
    expect(resolveTestTemplateDb({})).toBeUndefined();
    expect(resolveTestTemplateDb(env(undefined))).toBeUndefined();
    expect(resolveTestTemplateDb(env(""))).toBeUndefined();
  });

  test("a valid identifier is returned unchanged", () => {
    expect(resolveTestTemplateDb(env("open_brain_test_template"))).toBe(
      "open_brain_test_template",
    );
    expect(resolveTestTemplateDb(env("_t1"))).toBe("_t1");
    expect(resolveTestTemplateDb(env(`a${"b".repeat(62)}`))).toBe(`a${"b".repeat(62)}`);
  });

  test.each([
    "Open_brain",
    "1template",
    "tmpl-db",
    'x"; DROP DATABASE postgres; --',
    "has space",
    `a${"b".repeat(63)}`,
  ])("refuses %j", (bad) => {
    expect(() => resolveTestTemplateDb(env(bad))).toThrow(TEST_TEMPLATE_DB_ENV);
  });
});

describe("propagateTestTemplateDb", () => {
  test("fills an absent value from the .env values", () => {
    const target: NodeJS.ProcessEnv = {};
    propagateTestTemplateDb(target, { [TEST_TEMPLATE_DB_ENV]: "from_file" });
    expect(target[TEST_TEMPLATE_DB_ENV]).toBe("from_file");
  });
  test("never overrides the process environment", () => {
    const target: NodeJS.ProcessEnv = { [TEST_TEMPLATE_DB_ENV]: "from_env" };
    propagateTestTemplateDb(target, { [TEST_TEMPLATE_DB_ENV]: "from_file" });
    expect(target[TEST_TEMPLATE_DB_ENV]).toBe("from_env");
  });
  test("leaves it unset when neither source has it", () => {
    const target: NodeJS.ProcessEnv = {};
    propagateTestTemplateDb(target, {});
    expect(TEST_TEMPLATE_DB_ENV in target).toBe(false);
  });
});

describe("createdbTemplate", () => {
  test("unset keeps today's template0", () => {
    expect(createdbTemplate({})).toBe("template0");
  });
  test("set uses the configured template", () => {
    expect(createdbTemplate(env("open_brain_test_template"))).toBe(
      "open_brain_test_template",
    );
  });
  test("invalid is refused", () => {
    expect(() => createdbTemplate(env("bad-name"))).toThrow(TEST_TEMPLATE_DB_ENV);
  });
});

describe("sqlTemplateClause", () => {
  test("unset returns the caller's existing clause byte-for-byte", () => {
    expect(sqlTemplateClause(" TEMPLATE template0", {})).toBe(" TEMPLATE template0");
    expect(sqlTemplateClause("", {})).toBe("");
  });
  test("set returns a quoted TEMPLATE clause", () => {
    expect(sqlTemplateClause("", env("open_brain_test_template"))).toBe(
      ' TEMPLATE "open_brain_test_template"',
    );
    expect(sqlTemplateClause(" TEMPLATE template0", env("t"))).toBe(' TEMPLATE "t"');
  });
  test("invalid is refused", () => {
    expect(() => sqlTemplateClause("", env("Bad"))).toThrow(TEST_TEMPLATE_DB_ENV);
  });
});
