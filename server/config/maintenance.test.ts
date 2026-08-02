/**
 * Maintenance settings at the config boundary.
 *
 * Design authority: `src/maintenance-bootstrap.ts` is the behavior being
 * preserved (`maintenanceQueueEnabled` plus the three optional tuning reads);
 * `_plans/463-server-rewrite-charter.md` section 3 is why the parsing moves to
 * `server/config/`. No rule changes here — only ownership.
 */
import { describe, expect, it } from "bun:test";
import { parseMaintenanceConfig } from "./maintenance.ts";

describe("maintenance config boundary", () => {
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
