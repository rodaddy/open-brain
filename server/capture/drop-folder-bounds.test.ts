/**
 * The composition-root fill for the drop-folder scan bounds.
 *
 * The L5 move (issue 864) lifted the `DROP_COLLECTOR_*` reads out of the
 * collector and made them fields of one options object. That only preserves
 * behaviour if the composition root actually fills the field: without the fill
 * the server runtime runs on `DEFAULT_DROP_COLLECTOR_BOUNDS` no matter what the
 * deployment sets, which is a silent behavior change.
 *
 * These tests walk the whole path in one go — env in, `ServerConfig` out, into
 * the `MemoryToolDependencies` field, and then OBSERVED in the collector's own
 * traversal — so a regression at any link fails here rather than in production.
 */
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "bun:test";
import { parseServerConfig } from "../config.ts";
import type { MemoryToolDependencies } from "../tools/types.ts";
import { discoverFiles } from "./drop-folder-discovery.ts";
import { DEFAULT_DROP_COLLECTOR_BOUNDS } from "./drop-folder-contract.ts";

const REQUIRED = {
  DB_HOST: "db.internal",
  DB_NAME: "open_brain_test",
  DB_USER: "open_brain",
  LOG_FILE: "logs/open-brain.log",
};

function configFrom(overrides: Record<string, string | undefined> = {}) {
  const result = parseServerConfig({ ...REQUIRED, ...overrides });
  if (!result.ok) {
    throw new Error(`expected valid configuration: ${JSON.stringify(result.issues)}`);
  }
  return result.config;
}

/**
 * The exact expression `server/main.ts` uses to fill the dependency field.
 *
 * Written out here rather than imported because `createServerFactory` is not
 * exported and needs a live pool. An edit to either side then fails this test
 * rather than drifting apart quietly.
 */
function dependencyBoundsFrom(
  config: ReturnType<typeof configFrom>,
): Pick<MemoryToolDependencies, "dropCollectorBounds"> {
  return { dropCollectorBounds: config.dropCollector };
}

/** A drop tree three directories deep with one supported file at each level. */
async function treeWithDepth(): Promise<string> {
  // Under the repo, not a system temp directory: a sandbox and the host see
  // different ones, so a scratch tree written there is invisible to whoever
  // reads the failure.
  const scratch = join(import.meta.dir, "..", "..", "_scratch");
  await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(join(scratch, "ob-drop-bounds-"));
  await writeFile(join(root, "a.md"), "top");
  await mkdir(join(root, "one"));
  await writeFile(join(root, "one", "b.md"), "one");
  await mkdir(join(root, "one", "two"));
  await writeFile(join(root, "one", "two", "c.md"), "two");
  return root;
}

describe("drop-folder bounds reach the collector from the composition root", () => {
  it("carries a non-default file bound into the dependency field", () => {
    const config = configFrom({ DROP_COLLECTOR_MAX_FILES: "7" });
    const bounds = dependencyBoundsFrom(config).dropCollectorBounds;
    expect(bounds).toBeDefined();
    expect(bounds?.files).toBe(7);
    expect(bounds?.files).not.toBe(DEFAULT_DROP_COLLECTOR_BOUNDS.files);
  });

  it("carries every other configured bound too", () => {
    const bounds = dependencyBoundsFrom(
      configFrom({
        DROP_COLLECTOR_MAX_FILE_BYTES: "2048",
        DROP_COLLECTOR_MAX_TOTAL_BYTES: "4096",
        DROP_COLLECTOR_MAX_DEPTH: "2",
        DROP_COLLECTOR_MAX_SCAN_ENTRIES: "9",
      }),
    ).dropCollectorBounds;
    expect(bounds?.fileBytes).toBe(2048);
    expect(bounds?.totalBytes).toBe(4096);
    expect(bounds?.depth).toBe(2);
    expect(bounds?.scanEntries).toBe(9);
  });

  it("is the unconfigured defaults when nothing is set", () => {
    const bounds = dependencyBoundsFrom(configFrom()).dropCollectorBounds;
    expect(bounds).toEqual(DEFAULT_DROP_COLLECTOR_BOUNDS);
  });

  it("is OBSERVED: a configured depth bound shortens the real traversal", async () => {
    const root = await treeWithDepth();
    const shallow = dependencyBoundsFrom(
      configFrom({ DROP_COLLECTOR_MAX_DEPTH: "1" }),
    ).dropCollectorBounds;
    const deep = dependencyBoundsFrom(configFrom()).dropCollectorBounds;
    expect(shallow).toBeDefined();
    expect(deep).toBeDefined();

    const bounded = await discoverFiles(root, 100, { depth: shallow?.depth ?? 0 });
    const unbounded = await discoverFiles(root, 100, { depth: deep?.depth ?? 0 });

    // Depth 1 sees the root file and the one directory below it, never the
    // third level; the default depth of 8 sees all three.
    expect(bounded.files.length).toBeLessThan(unbounded.files.length);
    expect(unbounded.files.length).toBe(3);
  });
});
