/**
 * Maintenance settings at the config boundary.
 *
 * Design authority: `src/maintenance-bootstrap.ts` is the behavior being
 * preserved (`maintenanceQueueEnabled` plus the three optional tuning reads);
 * `_plans/463-server-rewrite-charter.md` section 3 is why the parsing moves to
 * `server/config/`. No rule changes here — only ownership.
 */
import { describe, expect, it } from "vitest";
import { MaintenanceConfigError, parseMaintenanceConfig } from "./maintenance.ts";

describe("maintenance config boundary", () => {
  it("keeps REM disabled by default", () => {
    expect(parseMaintenanceConfig({}).rem).toEqual({ enabled: false });
  });

  it("requires every REM threshold when explicitly enabled", () => {
    expect(() =>
      parseMaintenanceConfig({ OPEN_BRAIN_MAINTENANCE_REM_ENABLED: "1" }),
    ).toThrow(/REM configuration requires explicit positive integers/);

    expect(() =>
      parseMaintenanceConfig({
        OPEN_BRAIN_MAINTENANCE_REM_ENABLED: "1",
        OPEN_BRAIN_MAINTENANCE_REM_BACKLOG_HIGH_WATER: "10turns",
        OPEN_BRAIN_MAINTENANCE_REM_MAX_REQUESTS_PER_MINUTE: "3",
        OPEN_BRAIN_MAINTENANCE_REM_MIN_HEADROOM_BYTES: "1000",
        OPEN_BRAIN_MAINTENANCE_REM_FORCED_SLICE_SIZE: "25",
      }),
    ).toThrow(/REM configuration requires explicit positive integers/);

    expect(
      parseMaintenanceConfig({
        OPEN_BRAIN_MAINTENANCE_REM_ENABLED: "1",
        OPEN_BRAIN_MAINTENANCE_REM_BACKLOG_HIGH_WATER: "10",
        OPEN_BRAIN_MAINTENANCE_REM_MAX_REQUESTS_PER_MINUTE: "3",
        OPEN_BRAIN_MAINTENANCE_REM_MIN_HEADROOM_BYTES: "1000",
        OPEN_BRAIN_MAINTENANCE_REM_FORCED_SLICE_SIZE: "25",
      }).rem,
    ).toEqual({
      enabled: true,
      backlogHighWater: 10,
      maxRequestsPerMinute: 3,
      minHeadroomBytes: 1000,
      forcedSliceSize: 25,
      minGapMs: 900_000,
    });
  });
});

describe("REM minimum gap (issue 1488)", () => {
  const remBase = {
    OPEN_BRAIN_MAINTENANCE_REM_ENABLED: "1",
    OPEN_BRAIN_MAINTENANCE_REM_BACKLOG_HIGH_WATER: "10",
    OPEN_BRAIN_MAINTENANCE_REM_MAX_REQUESTS_PER_MINUTE: "3",
    OPEN_BRAIN_MAINTENANCE_REM_MIN_HEADROOM_BYTES: "1000",
    OPEN_BRAIN_MAINTENANCE_REM_FORCED_SLICE_SIZE: "25",
  };

  it("parses an explicit REM minimum gap, including 0 and 6 h", () => {
    for (const [raw, parsed] of [
      ["60000", 60_000],
      ["0", 0],
      ["21600000", 21_600_000],
    ] as const) {
      expect(
        parseMaintenanceConfig({
          ...remBase,
          OPEN_BRAIN_MAINTENANCE_REM_MIN_GAP_MS: raw,
        }).rem,
      ).toMatchObject({ enabled: true, minGapMs: parsed });
    }
  });

  it("invalidates REM on a negative, non-integer, or over-6h minimum gap", () => {
    for (const raw of ["-1", "1.5", "21600001"]) {
      expect(() =>
        parseMaintenanceConfig({
          ...remBase,
          OPEN_BRAIN_MAINTENANCE_REM_MIN_GAP_MS: raw,
        }),
      ).toThrow(/REM configuration requires explicit positive integers/);
    }
  });
});

describe("maintenance enable and tuning knobs", () => {
  it("is enabled when the variable is absent", () => {
    // The default has to be ON. The variable is unset in essentially every
    // environment, so an OFF default would silently stop maintenance fleetwide.
    expect(parseMaintenanceConfig({}).enabled).toBe(true);
  });

  it("opts a process out on either recorded off value", () => {
    for (const value of ["0", "false", "FALSE", " false "]) {
      expect(
        parseMaintenanceConfig({ OPEN_BRAIN_MAINTENANCE_ENABLED: value }).enabled,
      ).toBe(false);
    }
  });

  it("treats any other value as enabled rather than guessing", () => {
    for (const value of ["1", "true", "yes", "no"]) {
      expect(
        parseMaintenanceConfig({ OPEN_BRAIN_MAINTENANCE_ENABLED: value }).enabled,
      ).toBe(true);
    }
  });

  it("passes through the optional tuning values when they are usable", () => {
    const config = parseMaintenanceConfig({
      OPEN_BRAIN_MAINTENANCE_CONCURRENCY: "4",
      OPEN_BRAIN_MAINTENANCE_POLL_MS: "1500",
      OPEN_BRAIN_MAINTENANCE_LEASE_MS: "45000",
    });
    expect(config.concurrency).toBe(4);
    expect(config.pollIntervalMs).toBe(1_500);
    expect(config.leaseMs).toBe(45_000);
  });

  it("omits an unusable tuning value so the runner's own default applies", () => {
    // Absent, not zero, and not a startup failure. These are optional knobs;
    // the current behavior is that a bad value falls back to the runner default
    // and the process still starts.
    const config = parseMaintenanceConfig({
      OPEN_BRAIN_MAINTENANCE_CONCURRENCY: "0",
      OPEN_BRAIN_MAINTENANCE_POLL_MS: "not-a-number",
      OPEN_BRAIN_MAINTENANCE_LEASE_MS: "  ",
    });
    expect(config).not.toHaveProperty("concurrency");
    expect(config).not.toHaveProperty("pollIntervalMs");
    expect(config).not.toHaveProperty("leaseMs");
  });

  it("omits a negative value rather than passing it to the runner", () => {
    expect(
      parseMaintenanceConfig({ OPEN_BRAIN_MAINTENANCE_CONCURRENCY: "-2" }),
    ).not.toHaveProperty("concurrency");
  });
});

describe("DREAM route producer config (issue 1525)", () => {
  const valid = {
    OPEN_BRAIN_MAINTENANCE_ROUTE_ENABLED: "1",
    OPEN_BRAIN_MAINTENANCE_ROUTE_BACKEND: "fake",
    OPEN_BRAIN_MAINTENANCE_ROUTE_SLICE_SIZE: "50",
    OPEN_BRAIN_MAINTENANCE_ROUTE_MIN_GAP_MS: "120000",
    OPEN_BRAIN_MAINTENANCE_ROUTE_MAX_USD_PER_RUN: "0.25",
  };
  const routeError = (env: Record<string, string | undefined>): unknown => {
    try {
      parseMaintenanceConfig(env);
    } catch (error) {
      return error;
    }
    return undefined;
  };

  it("is disabled when unset or not exactly 1", () => {
    expect(parseMaintenanceConfig({}).route).toEqual({ enabled: false });
    expect(
      parseMaintenanceConfig({ ...valid, OPEN_BRAIN_MAINTENANCE_ROUTE_ENABLED: "0" })
        .route,
    ).toEqual({ enabled: false });
  });

  it("parses a full valid set", () => {
    expect(parseMaintenanceConfig(valid).route).toEqual({
      enabled: true,
      backend: "fake",
      sliceSize: 50,
      minGapMs: 120_000,
      maxUsdPerRun: 0.25,
    });
  });

  it("never implies a backend", () => {
    const error = routeError({
      ...valid,
      OPEN_BRAIN_MAINTENANCE_ROUTE_BACKEND: undefined,
    });
    expect(error).toBeInstanceOf(MaintenanceConfigError);
    expect((error as MaintenanceConfigError).path).toBe("OPEN_BRAIN_MAINTENANCE_ROUTE");
    expect((error as Error).message).toMatch(/DREAM route configuration requires/);
  });

  it.each([
    ["backend paid", { OPEN_BRAIN_MAINTENANCE_ROUTE_BACKEND: "paid" }],
    ["slice 201", { OPEN_BRAIN_MAINTENANCE_ROUTE_SLICE_SIZE: "201" }],
    ["slice abc", { OPEN_BRAIN_MAINTENANCE_ROUTE_SLICE_SIZE: "abc" }],
    ["gap 86400001", { OPEN_BRAIN_MAINTENANCE_ROUTE_MIN_GAP_MS: "86400001" }],
    ["usd 0", { OPEN_BRAIN_MAINTENANCE_ROUTE_MAX_USD_PER_RUN: "0" }],
    ["usd 1.5", { OPEN_BRAIN_MAINTENANCE_ROUTE_MAX_USD_PER_RUN: "1.5" }],
    ["usd abc", { OPEN_BRAIN_MAINTENANCE_ROUTE_MAX_USD_PER_RUN: "abc" }],
  ])("rejects %s", (_label, override) => {
    const error = routeError({ ...valid, ...override });
    expect((error as MaintenanceConfigError | undefined)?.path).toBe(
      "OPEN_BRAIN_MAINTENANCE_ROUTE",
    );
  });

  it("defaults the gap to 60 s and accepts 0", () => {
    const unset = parseMaintenanceConfig({
      ...valid,
      OPEN_BRAIN_MAINTENANCE_ROUTE_MIN_GAP_MS: undefined,
    }).route;
    expect(unset).toMatchObject({ minGapMs: 60_000 });
    const zero = parseMaintenanceConfig({
      ...valid,
      OPEN_BRAIN_MAINTENANCE_ROUTE_MIN_GAP_MS: "0",
    }).route;
    expect(zero).toMatchObject({ minGapMs: 0 });
  });

  it("still reports the REM path for a REM failure", () => {
    const error = routeError({ OPEN_BRAIN_MAINTENANCE_REM_ENABLED: "1" });
    expect((error as MaintenanceConfigError).path).toBe("OPEN_BRAIN_MAINTENANCE_REM");
  });
});
