/**
 * The runner's contract with the pg suites, asserted (#904).
 *
 * `scripts/local-clone.test.ts` and `scripts/retire-collab-migration.test.ts`
 * gate themselves on two variables the isolated runner did not used to set, so
 * both skipped every local run -- the false green #878 is about. This file is
 * the tripwire for the SUPPLY side: it fails when `bun run test:isolated` stops
 * exporting them, or exports a clone URL those suites would reject.
 *
 * It deliberately asserts the same three properties `local-clone.test.ts`
 * checks (loopback host, `open_brain_local_` database, `open_brain_local_clone`
 * role) rather than merely that the string is non-empty: a URL that is set but
 * wrong would let that suite throw at runtime instead of naming the cause here.
 *
 * It prints both values because the runner's job is to be inspectable -- an
 * operator reading the transcript can see exactly what the child received.
 * Passwords are not printed.
 *
 * A missing variable throws the same named error shape
 * `scripts/test-support/require-test-database.ts` uses --
 * `test_database_required: <VAR> is unset; run bun run test:isolated` -- rather
 * than failing a bare `expect`. The distinction matters to whoever reads the
 * failure: a bare assertion reads as "this test is wrong", while the named
 * error names the actual cause, that the SUPPLIER did not export what the
 * suite demands. `test_database_required` is the string to search for when it
 * fires, in this file and in that one alike.
 *
 * This file lives under `scripts/`, where `.oxlintrc.json` allows the
 * environment read and `console`.
 */

import { describe, expect, it } from "bun:test";

/**
 * Returns the named environment variable, or throws when it is unset.
 *
 * @throws {Error} `test_database_required` when the variable is missing or empty.
 */
function requireSuppliedUrl(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`test_database_required: ${name} is unset; run bun run test:isolated`);
  }
  return value;
}

describe("isolated runner environment contract (#904)", () => {
  it("exports OPENBRAIN_SCRATCH_ADMIN_URL", () => {
    const admin = requireSuppliedUrl("OPENBRAIN_SCRATCH_ADMIN_URL");
    const url = new URL(admin);
    expect(["postgres:", "postgresql:"]).toContain(url.protocol);
    console.log(`OPENBRAIN_SCRATCH_ADMIN_URL -> ${url.username}@${url.host}${url.pathname}`);
  });

  it("exports a OPENBRAIN_LOCAL_CLONE_TEST_DATABASE_URL the clone suite accepts", () => {
    const raw = requireSuppliedUrl("OPENBRAIN_LOCAL_CLONE_TEST_DATABASE_URL");
    const url = new URL(raw);
    const host = url.hostname === "[::1]" ? "::1" : url.hostname;
    const database = decodeURIComponent(url.pathname.replace(/^\//, ""));
    const user = decodeURIComponent(url.username);

    expect(["postgres:", "postgresql:"]).toContain(url.protocol);
    expect(["127.0.0.1", "::1"]).toContain(host);
    expect(user).toBe("open_brain_local_clone");
    expect(database.startsWith("open_brain_local_")).toBe(true);

    console.log(`OPENBRAIN_LOCAL_CLONE_TEST_DATABASE_URL -> ${user}@${host}:${url.port}/${database}`);
  });
});
