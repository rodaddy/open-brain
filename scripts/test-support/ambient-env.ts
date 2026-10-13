/**
 * Ambient-environment access for tests that must prove a module IGNORES it.
 *
 * `server/**` may not touch `process.env` (`.oxlintrc.json`, the L2b rung): the
 * composition root parses the environment once and hands the validated result
 * down. A handful of tests exist precisely to prove a module no longer reads
 * the ambient environment behind that root's back, and such a test has to be
 * able to SET a conflicting ambient value before it can assert the value is not
 * the one the module answers with.
 *
 * Those two facts do not conflict — they just cannot both live in the same
 * directory. This module sits under `scripts/`, outside the rule's scope, so
 * the reader stays in one named, greppable place instead of appearing inline in
 * server test files where it would be indistinguishable from the thing the rule
 * forbids.
 */

/** Reads one ambient environment variable, or `undefined` when it is unset. */
export function readAmbientEnv(name: string): string | undefined {
  return process.env[name];
}

/**
 * Sets or clears one ambient environment variable.
 *
 * `undefined` deletes the key rather than assigning the string "undefined",
 * which is what a caller restoring a previously-absent variable needs.
 */
export function writeAmbientEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

/**
 * Runs `body` with one ambient variable set, restoring the prior value after.
 *
 * The restore runs in a `finally` because Bun runs every test file in one
 * process: a leaked variable is a cross-test contaminant, not a local mess.
 */
export function withAmbientEnv<T>(name: string, value: string, body: () => T): T {
  const previous = readAmbientEnv(name);
  writeAmbientEnv(name, value);
  try {
    return body();
  } finally {
    writeAmbientEnv(name, previous);
  }
}
