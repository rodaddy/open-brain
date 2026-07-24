import { afterAll, describe, expect, it } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { validateLocalCloneMode } from "./local-clone-mode.ts";

const localCloneTestDir = mkdtempSync(join(tmpdir(), "open-brain-clone-"));
const localCloneRoot = join(localCloneTestDir, "clone");
const outsideRoot = join(localCloneTestDir, "outside");
mkdirSync(localCloneRoot);
mkdirSync(outsideRoot);

afterAll(() => {
  rmSync(localCloneTestDir, { recursive: true, force: true });
});

function validCloneEnv(
  overrides: Record<string, string | undefined> = {},
): Record<string, string | undefined> {
  return {
    OPENBRAIN_LOCAL_CLONE: "1",
    OPEN_BRAIN_BIND_HOST: "127.0.0.1",
    DB_HOST: "127.0.0.1",
    DB_NAME: "open_brain_local_issue_370",
    DB_USER: "open_brain_local_clone",
    EMBEDDING_BASE_URL: "http://127.0.0.1:8791/v1",
    QMD_PATH: "",
    OPEN_BRAIN_RUN_MIGRATIONS: "0",
    OPENBRAIN_LOCAL_CLONE_ROOT: localCloneRoot,
    AUTH_TOKEN_ADMIN: "local-admin",
    AUTH_TOKEN_AGENT: "local-agent",
    AUTH_TOKEN_DISCORD: "local-discord",
    AUTH_TOKEN_OB_ADMIN: "local-ob-admin",
    AUTH_TOKEN_PROMOTER: "local-promoter",
    AUTH_TOKEN_READONLY: "local-readonly",
    ...overrides,
  };
}

describe("validateLocalCloneMode", () => {
  it("preserves non-clone behavior", () => {
    expect(validateLocalCloneMode({})).toEqual({ enabled: false });
  });

  it("accepts an isolated loopback-only clone", () => {
    expect(validateLocalCloneMode(validCloneEnv())).toEqual({
      enabled: true,
      bindHost: "127.0.0.1",
    });
  });

  it("accepts literal IPv6 loopback values", () => {
    expect(
      validateLocalCloneMode(
        validCloneEnv({
          OPEN_BRAIN_BIND_HOST: "::1",
          DB_HOST: "::1",
          EMBEDDING_BASE_URL: "http://[::1]:8791/v1",
        }),
      ),
    ).toEqual({ enabled: true, bindHost: "::1" });
  });

  it.each([
    ["OPEN_BRAIN_BIND_HOST", "localhost"],
    ["OPEN_BRAIN_BIND_HOST", "[::1]"],
    ["DB_HOST", "10.71.1.21"],
    ["DB_HOST", "[::1]"],
    ["EMBEDDING_BASE_URL", "http://embedding.internal:8791/v1"],
  ])("rejects non-literal-loopback %s", (key, configured) => {
    expect(() =>
      validateLocalCloneMode(validCloneEnv({ [key]: configured })),
    ).toThrow("literal loopback");
  });

  it.each([
    ["DB_NAME", "open_brain"],
    ["DB_USER", "open_brain"],
    ["OPEN_BRAIN_RUN_MIGRATIONS", "1"],
  ])("rejects unsafe %s", (key, configured) => {
    expect(() =>
      validateLocalCloneMode(validCloneEnv({ [key]: configured })),
    ).toThrow(key);
  });

  it.each([
    "OPEN_BRAIN_BIND_HOST",
    "DB_HOST",
    "EMBEDDING_BASE_URL",
    "DB_NAME",
    "DB_USER",
    "OPENBRAIN_LOCAL_CLONE_ROOT",
  ])("rejects missing required %s", (key) => {
    expect(() =>
      validateLocalCloneMode(validCloneEnv({ [key]: undefined })),
    ).toThrow(key);
  });

  it.each(["not-a-url", "ftp://127.0.0.1/embeddings"])(
    "rejects invalid embedding URL %s",
    (configured) => {
      expect(() =>
        validateLocalCloneMode(
          validCloneEnv({ EMBEDDING_BASE_URL: configured }),
        ),
      ).toThrow("valid loopback URL");
    },
  );

  it.each([
    ["OPENBRAIN_NATS_URL", "nats://127.0.0.1:4222"],
    ["EMBEDDING_WATCHDOG_RESTART_SCRIPT", "/some/restart-script"],
  ])("rejects prohibited %s configuration", (key, configured) => {
    expect(() =>
      validateLocalCloneMode(validCloneEnv({ [key]: configured })),
    ).toThrow("prohibit");
  });

  it.each(["OPENBRAIN_RECOVERY_WAL_PATH", "LOG_FILE"])(
    "accepts existing and nonexistent %s leaves beneath the clone root",
    (key) => {
      const existing = join(localCloneRoot, "existing", key.toLowerCase());
      const nonexistent = join(
        localCloneRoot,
        "nonexistent",
        key.toLowerCase(),
      );
      mkdirSync(dirname(existing), { recursive: true });
      writeFileSync(existing, "");

      expect(
        validateLocalCloneMode(validCloneEnv({ [key]: existing })),
      ).toEqual({ enabled: true, bindHost: "127.0.0.1" });
      expect(
        validateLocalCloneMode(validCloneEnv({ [key]: nonexistent })),
      ).toEqual({ enabled: true, bindHost: "127.0.0.1" });
    },
  );

  it.each(["OPENBRAIN_RECOVERY_WAL_PATH", "LOG_FILE"])(
    "rejects direct %s symlink escapes",
    (key) => {
      const outside = join(outsideRoot, `direct-${key.toLowerCase()}`);
      const configured = join(localCloneRoot, `direct-${key.toLowerCase()}`);
      writeFileSync(outside, "");
      symlinkSync(outside, configured);

      expect(() =>
        validateLocalCloneMode(validCloneEnv({ [key]: configured })),
      ).toThrow("OPENBRAIN_LOCAL_CLONE_ROOT");
    },
  );

  it.each(["OPENBRAIN_RECOVERY_WAL_PATH", "LOG_FILE"])(
    "rejects nested %s symlink escapes",
    (key) => {
      const symlink = join(localCloneRoot, `nested-${key.toLowerCase()}`);
      symlinkSync(outsideRoot, symlink, "dir");
      const configured = join(symlink, "not-yet-created");

      expect(() =>
        validateLocalCloneMode(validCloneEnv({ [key]: configured })),
      ).toThrow("OPENBRAIN_LOCAL_CLONE_ROOT");
    },
  );

  it.each(["OPENBRAIN_RECOVERY_WAL_PATH", "LOG_FILE"])(
    "rejects lexical %s paths outside the clone root",
    (key) => {
      const configured = join(outsideRoot, key.toLowerCase());

      expect(() =>
        validateLocalCloneMode(validCloneEnv({ [key]: configured })),
      ).toThrow("OPENBRAIN_LOCAL_CLONE_ROOT");
    },
  );

  it("rejects a missing clone root when a runtime path is configured", () => {
    const missingRoot = join(localCloneTestDir, "missing-root");
    expect(() =>
      validateLocalCloneMode(
        validCloneEnv({
          OPENBRAIN_LOCAL_CLONE_ROOT: missingRoot,
          LOG_FILE: join(missingRoot, "open-brain.log"),
        }),
      ),
    ).toThrow("OPENBRAIN_LOCAL_CLONE_ROOT");
  });

  it("requires an absolute local clone root", () => {
    expect(() =>
      validateLocalCloneMode(
        validCloneEnv({ OPENBRAIN_LOCAL_CLONE_ROOT: "relative/root" }),
      ),
    ).toThrow("absolute path");
  });

  it.each([undefined, "/Volumes/ThunderBolt/qmd/src/qmd.ts"])(
    "rejects unsafe QMD_PATH %s because absence enables the production default",
    (configured) => {
      expect(() =>
        validateLocalCloneMode(validCloneEnv({ QMD_PATH: configured })),
      ).toThrow("QMD_PATH");
    },
  );

  it("requires every role token explicitly", () => {
    expect(() =>
      validateLocalCloneMode(validCloneEnv({ AUTH_TOKEN_PROMOTER: "" })),
    ).toThrow("AUTH_TOKEN_PROMOTER");
  });

  it("rejects duplicate role and per-user token values", () => {
    expect(() =>
      validateLocalCloneMode(
        validCloneEnv({ AUTH_TOKEN_READONLY: "local-admin" }),
      ),
    ).toThrow("unique local auth tokens");

    expect(() =>
      validateLocalCloneMode(
        validCloneEnv({ AUTH_TOKEN_USER_RICO: "admin:local-admin" }),
      ),
    ).toThrow("unique local auth tokens");
  });

  it.each(["", "admin:"])(
    "rejects an empty configured per-user token value",
    (configured) => {
      expect(() =>
        validateLocalCloneMode(
          validCloneEnv({ AUTH_TOKEN_USER_RICO: configured }),
        ),
      ).toThrow(/non-empty|unique/);
    },
  );

  it("accepts a unique configured per-user token", () => {
    expect(
      validateLocalCloneMode(
        validCloneEnv({ AUTH_TOKEN_USER_RICO: "admin:local-rico" }),
      ),
    ).toEqual({ enabled: true, bindHost: "127.0.0.1" });
  });
});
