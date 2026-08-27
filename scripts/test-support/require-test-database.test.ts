/**
 * Unit cover for the three database-demand helpers (issue #904).
 *
 * Each helper has one job: return the variable, or throw a
 * `test_database_required` error naming the variable it wanted. Both halves are
 * asserted here, because a helper that returned undefined instead of throwing
 * would reintroduce exactly the silent non-run the helpers exist to stop.
 *
 * The variables are saved and restored around each case so this file leaves the
 * environment as it found it for every other suite in the same bun process.
 */
import { afterEach, describe, expect, it } from "bun:test";

import {
  requireLocalCloneTestDatabaseUrl,
  requireScratchAdminUrl,
  requireTestDatabaseUrl,
} from "./require-test-database.ts";

const CASES = [
  {
    variable: "OPENBRAIN_TEST_DATABASE_URL",
    read: requireTestDatabaseUrl,
    value: "postgres://user:pw@127.0.0.1:5432/ob_test",
  },
  {
    variable: "OPENBRAIN_LOCAL_CLONE_TEST_DATABASE_URL",
    read: requireLocalCloneTestDatabaseUrl,
    value: "postgres://open_brain_local_clone:pw@127.0.0.1:5432/open_brain_local_x",
  },
  {
    variable: "OPENBRAIN_SCRATCH_ADMIN_URL",
    read: requireScratchAdminUrl,
    value: "postgres://admin:pw@127.0.0.1:5432/postgres",
  },
] as const;

const SAVED = new Map<string, string | undefined>(
  CASES.map((c) => [c.variable, process.env[c.variable]]),
);

afterEach(() => {
  for (const [name, value] of SAVED) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

describe("database-demand helpers", () => {
  for (const { variable, read, value } of CASES) {
    it(`throws test_database_required when ${variable} is unset`, () => {
      delete process.env[variable];
      expect(() => read()).toThrow(
        `test_database_required: ${variable} is unset; run bun run test:isolated`,
      );
    });

    it(`throws when ${variable} is set to an empty string`, () => {
      process.env[variable] = "";
      expect(() => read()).toThrow("test_database_required");
    });

    it(`returns the value when ${variable} is set`, () => {
      process.env[variable] = value;
      expect(read()).toBe(value);
    });
  }
});
