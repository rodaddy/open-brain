/**
 * The reader slot `registerConfigReaders` owns, and the undo it hands back.
 *
 * These are the M13a probes for issue 864 L6 items 7 and 8. The slot is
 * module-level and process-wide, which is exactly why the restore matters: a
 * probe that installed a reader and walked away would leave the next test file
 * in this process reading a dead config. So each probe asserts the value it
 * installed AND that the restore puts back the value it recorded first.
 *
 * No database and no server: `registerConfigReaders` takes a `ServerConfig` and
 * touches one setter, so the probe is the function plus a parsed config.
 */
import { describe, expect, it } from "vitest";
import { expectDefined } from "./testing/expect-defined.ts";
import { parseServerConfig } from "./config.ts";
import { readLegacyLoggerSettings } from "./logging/legacy-logger-settings.ts";
import { registerConfigReaders } from "./main.ts";

/** The baseline `server/config-src-readers.test.ts` uses, for the same reason. */
const REQUIRED = {
  DB_HOST: "db.internal",
  DB_NAME: "open_brain_test",
  DB_USER: "open_brain",
  LOG_FILE: "logs/open-brain.log",
  AUTH_TOKEN_ADMIN: "probe-admin-token",
};

function configFrom(overrides: Record<string, string | undefined> = {}) {
  const result = parseServerConfig({ ...REQUIRED, ...overrides });
  if (!result.ok) {
    throw new Error(`expected valid configuration: ${JSON.stringify(result.issues)}`);
  }
  return result.config;
}

describe("registerConfigReaders", () => {
  it("points the reader slot at the config, and restores the previous one", () => {
    const hostNameBefore = readLegacyLoggerSettings().hostName;

    const config = configFrom({ HOSTNAME: "probe-host" });
    const restore = registerConfigReaders(config);

    expect(readLegacyLoggerSettings().hostName).toBe("probe-host");

    restore();

    expect(readLegacyLoggerSettings().hostName).toBe(hostNameBefore);
  });

  it("falls back to the transport identity when unset", () => {
    const hostNameBefore = readLegacyLoggerSettings().hostName;

    // No key set: the logger identity is the `/health` identity.
    const config = configFrom();
    expect(config.loggerIdentity.hostName).toBeUndefined();

    const restore = registerConfigReaders(config);

    const identity = expectDefined(config.transport.hostname, "transport.hostname");
    expect(readLegacyLoggerSettings().hostName).toBe(identity);

    restore();

    expect(readLegacyLoggerSettings().hostName).toBe(hostNameBefore);
  });
});
