import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  buildChildEnvironment,
  describeDroppedChildEnvironment,
} from "./local-clone.ts";

// #1488: the launcher dropped every maintenance key except ENABLED, so REM
// stayed "disabled" on dogfood after it was configured on. This drift test
// fails the suite when server/config/maintenance.ts reads a key CHILD_ENV_KEYS
// does not carry.
const MAINTENANCE_CONFIG = fileURLToPath(
  new URL("../server/config/maintenance.ts", import.meta.url),
);

function maintenanceKeysReadByServer(): string[] {
  const source = readFileSync(MAINTENANCE_CONFIG, "utf8");
  const keys = new Set<string>();
  for (const match of source.matchAll(
    /environment\.(OPEN_BRAIN_MAINTENANCE_[A-Z_]+)/g,
  )) {
    const key = match[1];
    if (key !== undefined) keys.add(key);
  }
  return [...keys].sort();
}

describe("local clone maintenance env passthrough (#1488)", () => {
  it("delivers every maintenance key the server config reads", () => {
    const keys = maintenanceKeysReadByServer();
    expect(keys.length).toBeGreaterThan(0);
    const env = Object.fromEntries(keys.map((key) => [key, "1"]));
    const child = buildChildEnvironment(env);
    expect(keys.filter((key) => child[key] !== "1")).toEqual([]);
    const droppedKeys = describeDroppedChildEnvironment(env).map((entry) => entry.key);
    expect(droppedKeys.filter((key) => keys.includes(key))).toEqual([]);
  });
});
