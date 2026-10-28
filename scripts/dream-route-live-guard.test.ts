import { afterEach, describe, expect, test, vi } from "vitest";
import { main as cohortMain } from "./dream-route-cohort.ts";
import {
  LIVE_DATABASE_NAMES,
  assertNotLiveDatabase,
  resolvedDatabaseName,
} from "./dream-route-live-guard.ts";
import { main as runMain } from "./dream-route-run.ts";

const LIVE = "open_brain_local_20260724";
const REFUSAL =
  `refusing to write dream_run schemas into the live database ${LIVE}; ` +
  "pass --allow-live-db to override";

describe("assertNotLiveDatabase", () => {
  test("lists exactly the dogfood database as live", () => {
    expect(LIVE_DATABASE_NAMES).toEqual([LIVE]);
  });

  test("refuses the live database without opt-in", () => {
    expect(() =>
      assertNotLiveDatabase({ databaseName: LIVE, allowLive: false }),
    ).toThrow(REFUSAL);
  });

  test("allows the live database with opt-in", () => {
    expect(() =>
      assertNotLiveDatabase({ databaseName: LIVE, allowLive: true }),
    ).not.toThrow();
  });

  test("allows any other database", () => {
    expect(() =>
      assertNotLiveDatabase({ databaseName: "open_brain_test_x", allowLive: false }),
    ).not.toThrow();
  });
});

describe("resolvedDatabaseName", () => {
  test("reads DB_NAME, defaulting like createPool", () => {
    expect(resolvedDatabaseName({ DB_NAME: LIVE })).toBe(LIVE);
    expect(resolvedDatabaseName({})).toBe("open_brain");
  });
});

describe("script entry points", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  test("the cohort freezer refuses the live database before opening a pool", async () => {
    vi.stubEnv("DB_NAME", LIVE);
    const createPool = vi.fn();
    await expect(cohortMain(["--namespace", "unit"], { createPool })).rejects.toThrow(
      REFUSAL,
    );
    expect(createPool).not.toHaveBeenCalled();
  });

  test("the route runner refuses the live database before opening a pool", async () => {
    vi.stubEnv("DB_NAME", LIVE);
    const createPool = vi.fn();
    await expect(
      runMain(["--schema", "dream_run_001"], { createPool }),
    ).rejects.toThrow(REFUSAL);
    expect(createPool).not.toHaveBeenCalled();
  });
});
