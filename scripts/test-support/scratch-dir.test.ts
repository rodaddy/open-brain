/**
 * Functional tests for the shared scratch-directory helper.
 *
 * The assertions are about observable behaviour — a directory that exists,
 * lives under the resolved base, honours the ambient override, and is distinct
 * per call — rather than about the helper's internals. The structural half of
 * the contract (no `tmpdir(`, no `process.env`) is checked by
 * `scripts/done-means/1182-scratch-helper.sh`, which reads the source; a test
 * cannot see the difference between a sanctioned reader and a forbidden one.
 */
import { describe, expect, it } from "vitest";
import { existsSync, mkdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { withAmbientEnv } from "./ambient-env.ts";
import { testScratchBase, testScratchDir } from "./scratch-dir.ts";

describe("testScratchDir", () => {
  it("returns a directory that exists on disk", () => {
    const dir = testScratchDir("scratch-dir-exists-");
    expect(existsSync(dir)).toBe(true);
    expect(statSync(dir).isDirectory()).toBe(true);
  });

  it("creates the directory under the resolved base", () => {
    const dir = testScratchDir("scratch-dir-under-base-");
    expect(dir.startsWith(`${testScratchBase()}/`)).toBe(true);
  });

  it("honours OPENBRAIN_TEST_SCRATCH_DIR when it is set", () => {
    // The override points at a subdirectory of the default base, so this test
    // writes no further out than the rest of the suite does.
    const override = join(testScratchDir("scratch-dir-override-base-"), "nested");
    mkdirSync(override, { recursive: true });

    withAmbientEnv("OPENBRAIN_TEST_SCRATCH_DIR", override, () => {
      expect(testScratchBase()).toBe(override);
      const dir = testScratchDir("scratch-dir-override-");
      expect(dir.startsWith(`${override}/`)).toBe(true);
      expect(existsSync(dir)).toBe(true);
    });
  });

  it("returns a distinct directory on every call", () => {
    const first = testScratchDir("scratch-dir-distinct-");
    const second = testScratchDir("scratch-dir-distinct-");
    expect(first).not.toBe(second);
  });
});
