/**
 * Test-only narrowing helper, shared by the server suites and their harness
 * modules; no runtime code imports it.
 */

/** Narrows an optional value, throwing a labelled error when it is absent. */
export function expectDefined<T>(value: T | null | undefined, label: string): T {
  if (value === null || value === undefined) {
    throw new Error(`expected ${label} to be defined`);
  }
  return value;
}
