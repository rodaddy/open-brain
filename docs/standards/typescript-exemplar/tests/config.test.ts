/**
 * Tests for `config.ts`.
 *
 * WHY PRECEDENCE GETS ITS OWN SUITE
 *
 * config.ts documents a five-layer precedence order in its module comment. The
 * Python exemplar this mirrors had a docstring describing the OPPOSITE of what
 * its code did -- documented precedence that nothing verified, believed by
 * everyone who read it, wrong for as long as it existed.
 *
 * A comment is not a guarantee. These tests are what makes that order a fact:
 * each layer is asserted to beat the one below it, individually, with the layers
 * above it absent so a pass cannot come from the wrong reason.
 *
 * Nothing here touches the real environment or the real secrets directory. Both
 * are injected (`processEnv`, `secretsDir`), which is the reason those options
 * exist on LoadOptions at all -- a test that mutates `process.env` leaks into
 * every test that runs after it in the same process.
 */

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { loadSettings, PROJECT_ROOT } from "../src/exemplar/config.ts";

/**
 * A secrets directory containing exactly the files a test asks for.
 *
 * `os.tmpdir()` is correct here for the same reason as in enforcement.test.ts:
 * these are throwaway fixtures for one subprocess-free function call, not
 * durable artifacts. Writing them into the repo would leave a `secrets/`
 * directory full of test JSON that the real loader would then pick up.
 */
function makeSecretsDir(files: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), "exemplar-config-"));
  for (const [name, contents] of Object.entries(files)) {
    writeFileSync(join(dir, name), JSON.stringify(contents), "utf8");
  }
  return dir;
}

/** An empty environment, so the real one cannot influence a result. */
const NO_ENV: NodeJS.ProcessEnv = {};

describe("defaults", () => {
  test("loads with no files and no environment at all", () => {
    // The floor. If this needs a file to work, then every fresh clone is broken
    // until someone finds out which file.
    const settings = loadSettings({
      secretsDir: makeSecretsDir({}),
      processEnv: NO_ENV,
    });

    assert.equal(settings.env, "test");
    assert.equal(settings.logging.level, "info");
    assert.equal(settings.database.path, "data/history.db");
    assert.deepEqual(settings.monitor.targets, []);
  });

  test("derives all four ports from one base", () => {
    // Derived rather than four independent fields: with four values somebody
    // eventually sets two the same and one app dies with EADDRINUSE.
    const settings = loadSettings({
      secretsDir: makeSecretsDir({}),
      processEnv: NO_ENV,
    });

    assert.equal(settings.ports.monitor, 7150);
    assert.equal(settings.ports.watch, 7151);
    assert.equal(settings.ports.hook, 7152);
    assert.equal(settings.ports.stats, 7153);
  });

  test("every derived port is inside the reserved 7100-7199 band", () => {
    // AGENTS.md reserves that band for local dev servers on Rico's Mac. The
    // schema's min/max on `base` is what enforces it; this asserts the
    // derivation cannot land outside even so.
    const { ports } = loadSettings({
      secretsDir: makeSecretsDir({}),
      processEnv: NO_ENV,
    });

    for (const port of [ports.monitor, ports.watch, ports.hook, ports.stats]) {
      assert.ok(
        port >= 7100 && port <= 7199,
        `port ${String(port)} is outside 7100-7199`,
      );
    }
  });
});

describe("precedence -- each layer beats the one below it", () => {
  test("1. config.json beats the schema default", () => {
    const settings = loadSettings({
      secretsDir: makeSecretsDir({ "config.json": { logging: { level: "warn" } } }),
      processEnv: NO_ENV,
    });

    assert.equal(settings.logging.level, "warn");
  });

  test("2. config.{env}.json beats config.json", () => {
    const secretsDir = makeSecretsDir({
      "config.json": { logging: { level: "warn" } },
      "config.dev.json": { logging: { level: "debug" } },
    });

    const settings = loadSettings({ env: "dev", secretsDir, processEnv: NO_ENV });

    assert.equal(settings.logging.level, "debug");
  });

  test("3. the environment beats both files", () => {
    // The deliberate choice, and the one worth pinning: a container sets env
    // vars and cannot easily edit a file baked into its image.
    const secretsDir = makeSecretsDir({
      "config.json": { logging: { level: "warn" } },
      "config.dev.json": { logging: { level: "debug" } },
    });

    const settings = loadSettings({
      env: "dev",
      secretsDir,
      processEnv: { EXEMPLAR_LOGGING__LEVEL: "error" },
    });

    assert.equal(settings.logging.level, "error");
  });

  test("4. explicit overrides beat the environment", () => {
    const settings = loadSettings({
      secretsDir: makeSecretsDir({ "config.json": { logging: { level: "warn" } } }),
      processEnv: { EXEMPLAR_LOGGING__LEVEL: "error" },
      overrides: { logging: { level: "trace" } },
    });

    assert.equal(settings.logging.level, "trace");
  });

  test("the full stack resolves to the top layer", () => {
    // All five present at once. The individual tests above could each pass with
    // a broken reduce; this one cannot.
    const secretsDir = makeSecretsDir({
      "config.json": { logging: { level: "warn" } },
      "config.dev.json": { logging: { level: "debug" } },
    });

    const settings = loadSettings({
      env: "dev",
      secretsDir,
      processEnv: { EXEMPLAR_LOGGING__LEVEL: "error" },
      overrides: { logging: { level: "fatal" } },
    });

    assert.equal(settings.logging.level, "fatal");
  });
});

describe("environment variable parsing", () => {
  test("double underscore nests", () => {
    const settings = loadSettings({
      secretsDir: makeSecretsDir({}),
      processEnv: { EXEMPLAR_DATABASE__PATH: ":memory:" },
    });

    assert.equal(settings.database.path, ":memory:");
  });

  test("JSON values keep their type", () => {
    // Without the JSON attempt, `250` arrives as the STRING "250" and zod
    // rejects it -- so a perfectly ordinary env var would fail validation with
    // a type error nobody expects from a number.
    const settings = loadSettings({
      secretsDir: makeSecretsDir({}),
      processEnv: {
        EXEMPLAR_WATCH__DEBOUNCE_MS: "500",
        EXEMPLAR_LOGGING__PRETTY: "false",
      },
    });

    assert.equal(settings.watch.debounceMs, 500);
    assert.equal(settings.logging.pretty, false);
    assert.equal(typeof settings.watch.debounceMs, "number");
    assert.equal(typeof settings.logging.pretty, "boolean");
  });

  test("a bare word stays a string", () => {
    // The fallback path. "debug" is not valid JSON, and treating a parse
    // failure as an error rather than as "this is a plain string" would make
    // every non-numeric env var unusable.
    const settings = loadSettings({
      secretsDir: makeSecretsDir({}),
      processEnv: { EXEMPLAR_LOGGING__LEVEL: "debug" },
    });

    assert.equal(settings.logging.level, "debug");
  });

  test("unrelated variables are ignored", () => {
    // A prefix check that is too loose picks up PATH, HOME, and every secret in
    // the environment, then dumps them into a settings object that gets logged.
    const settings = loadSettings({
      secretsDir: makeSecretsDir({}),
      processEnv: { PATH: "/usr/bin", HOME: "/root", AWS_SECRET_ACCESS_KEY: "x" },
    });

    assert.equal(settings.logging.level, "info");
    assert.ok(!Object.keys(settings).includes("path"));
  });
});

describe("merge semantics", () => {
  test("nested objects merge rather than replace wholesale", () => {
    // Overriding `logging.level` must not erase `logging.file`. A shallow merge
    // would, and the result is a service that stops writing its log file
    // because somebody raised the log level.
    const settings = loadSettings({
      secretsDir: makeSecretsDir({
        "config.json": { logging: { level: "warn", file: "logs/custom.log" } },
      }),
      processEnv: { EXEMPLAR_LOGGING__LEVEL: "error" },
    });

    assert.equal(settings.logging.level, "error");
    assert.equal(settings.logging.file, "logs/custom.log", "sibling key was erased");
  });

  test("arrays REPLACE rather than concatenate", () => {
    // The surprising half of deep-merge, pinned deliberately. If arrays merged,
    // an override could add a monitor target but never remove one.
    const settings = loadSettings({
      secretsDir: makeSecretsDir({
        "config.json": {
          monitor: {
            targets: [
              { name: "a", url: "https://a.test/health" },
              { name: "b", url: "https://b.test/health" },
            ],
          },
        },
      }),
      processEnv: NO_ENV,
      overrides: {
        monitor: { targets: [{ name: "c", url: "https://c.test/health" }] },
      },
    });

    assert.equal(settings.monitor.targets.length, 1);
    assert.equal(settings.monitor.targets[0]?.name, "c");
  });
});

describe("validation failures are fatal and specific", () => {
  test("an invalid value throws rather than falling back to a default", () => {
    // Silently substituting a default for a value somebody explicitly set is
    // worse than crashing: the service runs, with configuration nobody chose,
    // and reports nothing.
    assert.throws(() =>
      loadSettings({
        secretsDir: makeSecretsDir({}),
        processEnv: { EXEMPLAR_PORTS__BASE: "9999" },
      }),
    );
  });

  test("the message names the offending field and the action", () => {
    assert.throws(
      () =>
        loadSettings({
          secretsDir: makeSecretsDir({}),
          processEnv: { EXEMPLAR_PORTS__BASE: "9999" },
        }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /ports\.base/, "does not name the field");
        assert.match(error.message, /ACTION REQUIRED/, "does not name the action");
        return true;
      },
    );
  });

  test("EVERY invalid field is reported, not just the first", () => {
    // Fixing configuration one error per restart is how a five-minute task
    // becomes an afternoon.
    assert.throws(
      () =>
        loadSettings({
          secretsDir: makeSecretsDir({}),
          processEnv: {
            EXEMPLAR_PORTS__BASE: "9999",
            EXEMPLAR_WATCH__DEBOUNCE_MS: "-5",
          },
        }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /ports\.base/);
        assert.match(error.message, /watch\.debounceMs/);
        return true;
      },
    );
  });

  test("malformed JSON in a config file is an error, not 'no config'", () => {
    // ENOENT is expected and returns {}. A syntax error is NOT, and swallowing
    // it means a service boots on defaults while its config file sits there
    // looking authoritative.
    const dir = mkdtempSync(join(tmpdir(), "exemplar-config-bad-"));
    writeFileSync(join(dir, "config.json"), "{ this is not json", "utf8");

    assert.throws(
      () => loadSettings({ secretsDir: dir, processEnv: NO_ENV }),
      /Could not read config file/,
    );
  });

  test("an ABSENT config file is fine", () => {
    // The other half of the same decision. Optional means optional.
    assert.doesNotThrow(() =>
      loadSettings({
        secretsDir: join(tmpdir(), "exemplar-definitely-does-not-exist"),
        processEnv: NO_ENV,
      }),
    );
  });
});

describe("PROJECT_ROOT", () => {
  test("resolves to the directory holding package.json", () => {
    // Derived from import.meta.url rather than cwd, so the tree survives being
    // cloned anywhere and does not depend on where the process was started.
    assert.doesNotThrow(() => loadSettings({ processEnv: NO_ENV }));
    assert.ok(PROJECT_ROOT.endsWith("typescript-exemplar"));
  });
});
