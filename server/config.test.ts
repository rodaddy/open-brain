/**
 * Configuration boundary tests.
 * Design authority: `docs/code-brain-design.md` R3 and
 * `docs/decisions/shared-kb-canonical-namespace.md`.
 */
import { describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { parseServerConfig } from "./config.ts";

const REQUIRED = {
  DB_HOST: "db.internal",
  DB_NAME: "open_brain_test",
  DB_USER: "open_brain",
  LOG_FILE: "logs/open-brain.log",
};

describe("server configuration boundary", () => {
  it("returns structured field errors instead of a partial config", () => {
    const result = parseServerConfig({ LOG_FILE: "logs/test.log" });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected invalid configuration");
    expect(result.issues.map((issue) => issue.path)).toEqual(["DB_HOST", "DB_NAME", "DB_USER"]);
  });

  it("rejects malformed configured user tokens visibly", () => {
    const result = parseServerConfig({ ...REQUIRED, AUTH_TOKEN_USER_BILBY: "agent" });
    expect(result).toEqual({
      ok: false,
      issues: [{ path: "AUTH_TOKEN_USER_BILBY", message: "Invalid option: expected one of \"admin\"|\"agent\"|\"discord\"|\"ob-admin\"|\"promoter\"|\"readonly\"" }],
    });
  });

  it("normalizes configured token identities without exposing token values", () => {
    const result = parseServerConfig({
      ...REQUIRED,
      AUTH_TOKEN_AGENT: randomUUID(),
      AUTH_TOKEN_USER_OPENBRAIN_PROMOTER: `promoter:${randomUUID()}`,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected valid configuration");
    expect(result.config.authTokens.map(({ role, clientId }) => ({ role, clientId }))).toEqual([
      { role: "agent", clientId: "agent" },
      { role: "promoter", clientId: "openbrain-promoter" },
    ]);
    expect(result.config.sharedNamespace).toBe("shared-kb");
  });
});
