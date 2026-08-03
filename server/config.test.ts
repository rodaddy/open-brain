/**
 * Configuration boundary tests.
 * Design authority: `docs/code-brain-design.md` R3 and
 * `docs/decisions/shared-kb-canonical-namespace.md`.
 */
import { describe, expect, it, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { OPTIONAL_SECRET_KEYS, parseServerConfig } from "./config.ts";

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

/**
 * Present-but-EMPTY optional secrets.
 *
 * This is the shape that took the local dogfood service down on 2026-08-02.
 * `/Volumes/ThunderBolt/open-brain-local/local-clone.env` legitimately sets
 * `EMBEDDING_API_KEY=` (empty) because the local MLX embedding server needs no
 * key, and `z.string().min(1).optional()` accepts ABSENT while REJECTING
 * present-and-empty. The entrypoint threw
 * `server_configuration_invalid: EMBEDDING_API_KEY: Too small` and launchd
 * throttle-looped.
 *
 * The bar is start-equivalence with `src/`, so these assert the semantics the
 * runtime env actually uses, read from the source of each consumer:
 *   - `src/auth.ts` `if (!token) { warn; continue; }` — empty is skipped, not fatal
 *   - `src/embedding.ts` `embeddingApiKey()` returns the raw env value
 *   - `src/db/pool.ts` passes `process.env.DB_PASSWORD` straight to pg
 * In every one of them an empty string behaves exactly as an unset variable.
 *
 * Parameterized over the WHOLE class rather than the one field that bit us:
 * the defect is in the shared `optionalSecret` schema, so a test that pinned
 * only `EMBEDDING_API_KEY` would leave the other seven able to fail the same
 * way on the next environment that sets one to empty.
 */
describe("optional secrets that are present but empty", () => {
  test.each([...OPTIONAL_SECRET_KEYS])("%s: empty string parses as absent", (key) => {
    const result = parseServerConfig({ ...REQUIRED, [key]: "" });
    if (!result.ok) {
      throw new Error(
        `empty ${key} must not fail the config boundary: ${JSON.stringify(result.issues)}`,
      );
    }
  });

  it("covers every field declared with the shared optional-secret schema", () => {
    // Guards the parameterization above: a NEW optionalSecret field added to the
    // schema without being listed here would otherwise go untested.
    expect([...OPTIONAL_SECRET_KEYS].sort()).toEqual([
      "AUTH_TOKEN_ADMIN",
      "AUTH_TOKEN_AGENT",
      "AUTH_TOKEN_DISCORD",
      "AUTH_TOKEN_OB_ADMIN",
      "AUTH_TOKEN_PROMOTER",
      "AUTH_TOKEN_READONLY",
      "DB_PASSWORD",
      "EMBEDDING_API_KEY",
    ]);
  });

  it("omits an empty database password rather than sending one", () => {
    const result = parseServerConfig({ ...REQUIRED, DB_PASSWORD: "" });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected valid configuration");
    expect("password" in result.config.database).toBe(false);
  });

  it("omits an empty embedding api key rather than sending one", () => {
    const result = parseServerConfig({ ...REQUIRED, EMBEDDING_API_KEY: "" });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected valid configuration");
    expect("embeddingApiKey" in result.config.transport).toBe(false);
  });

  it("skips an empty role token instead of registering a blank-token role", () => {
    // `src/auth.ts` warns and continues on an empty role token. A blank token
    // registered as a credential would be an auth hole, not a config nicety.
    const result = parseServerConfig({
      ...REQUIRED,
      AUTH_TOKEN_ADMIN: "",
      AUTH_TOKEN_AGENT: "configured-agent-token",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected valid configuration");
    expect(result.config.authTokens.map(({ role }) => role)).toEqual(["agent"]);
  });

  it("still parses when EVERY optional secret is empty at once", () => {
    // The real clone environment sets several of these blank together; the
    // per-field cases above would all pass even if the combination did not.
    const empties = Object.fromEntries(OPTIONAL_SECRET_KEYS.map((key) => [key, ""]));
    const result = parseServerConfig({ ...REQUIRED, ...empties });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected valid configuration");
    expect(result.config.authTokens).toEqual([]);
    expect("password" in result.config.database).toBe(false);
    expect("embeddingApiKey" in result.config.transport).toBe(false);
  });

  it("still rejects a present-but-empty REQUIRED field", () => {
    // The empty-as-absent rule is scoped to OPTIONAL secrets. Widening it to
    // required fields would turn `DB_HOST=` into a silent default.
    const result = parseServerConfig({ ...REQUIRED, DB_HOST: "" });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected invalid configuration");
    expect(result.issues.map((issue) => issue.path)).toEqual(["DB_HOST"]);
  });
});
