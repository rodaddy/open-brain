import { describe, expect, it } from "vitest";
import { safeMaintenanceErrorIdentity } from "./maintenance-job.ts";

class PgLikeError extends Error {
  code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = "error";
    this.code = code;
  }
}

describe("safeMaintenanceErrorIdentity (issue 1529)", () => {
  it("returns the class name and a SQLSTATE code for a pg-like error", () => {
    expect(safeMaintenanceErrorIdentity(new PgLikeError("row text", "23502"))).toEqual({
      error_name: "PgLikeError",
      error_code: "23502",
    });
  });

  it("returns an errno-style code", () => {
    expect(
      safeMaintenanceErrorIdentity(new PgLikeError("x", "ENOENT")).error_code,
    ).toBe("ENOENT");
  });

  it("gives a null code for a plain Error and never carries its text", () => {
    const identity = safeMaintenanceErrorIdentity(new Error("secret text"));
    expect(identity).toEqual({ error_name: "Error", error_code: null });
    expect(JSON.stringify(identity)).not.toContain("secret text");
  });

  it("gives both null for a non-Error value", () => {
    expect(safeMaintenanceErrorIdentity("secret text")).toEqual({
      error_name: null,
      error_code: null,
    });
    expect(safeMaintenanceErrorIdentity({ code: "23502" })).toEqual({
      error_name: null,
      error_code: null,
    });
  });

  it("rejects a code with lower-case letters, spaces, or excess length", () => {
    expect(
      safeMaintenanceErrorIdentity(new PgLikeError("x", "enoent")).error_code,
    ).toBeNull();
    expect(
      safeMaintenanceErrorIdentity(new PgLikeError("x", "BAD CODE")).error_code,
    ).toBeNull();
    expect(
      safeMaintenanceErrorIdentity(new PgLikeError("x", "A".repeat(17))).error_code,
    ).toBeNull();
    expect(
      safeMaintenanceErrorIdentity(new PgLikeError("x", "")).error_code,
    ).toBeNull();
  });
});
