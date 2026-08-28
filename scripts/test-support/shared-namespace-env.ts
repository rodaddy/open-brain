/**
 * Shared-namespace environment isolation for suites that must observe nothing
 * but their own writes.
 *
 * `readableNamespaces()` grants every non-admin role read access to the shared
 * namespace as well, so a suite running against the real `shared-kb` would also
 * observe whatever the target database happens to hold there, and its recorded
 * counts would assert an accident of that database.
 *
 * `sharedNamespaceConfig()` re-reads the environment on every call, and Bun runs
 * every test file in ONE process, so a module-scope assignment leaks into
 * sibling files and fails them by load order. A suite therefore installs the
 * isolation in `beforeAll` and removes it in `afterAll`.
 *
 * This module lives under `scripts/` deliberately: `.oxlintrc.json` scopes
 * `node/no-process-env` to `server/**\/*.ts`, so the environment access belongs
 * in test support rather than beside the tests it serves.
 */

const KEYS = ["SHARED_NAMESPACE_CANONICAL", "SHARED_NAMESPACE_PHYSICAL"];

let prior: Array<string | undefined> | undefined;

/**
 * Point both shared-namespace variables at `value`, recording the prior values
 * once so a later restore returns the process to what it inherited.
 */
export function isolateSharedNamespace(value: string): void {
  if (prior === undefined) {
    prior = KEYS.map((key) => process.env[key]);
  }
  for (const key of KEYS) {
    process.env[key] = value;
  }
}

/** Restore both shared-namespace variables to the values recorded on isolate. */
export function restoreSharedNamespace(): void {
  if (prior === undefined) return;
  KEYS.forEach((key, index) => {
    const value = prior?.[index];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  });
  prior = undefined;
}
