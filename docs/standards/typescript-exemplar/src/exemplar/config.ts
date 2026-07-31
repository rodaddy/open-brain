/**
 * config.ts -- THE KEYSTONE.
 *
 * One module owns configuration, validates it at startup, and hands it down.
 * Nothing else in this codebase reads `process.env`; `eslint` cannot enforce
 * that on its own, so `_githooks/pre-commit` greps for stray reads and blocks
 * the commit.
 *
 * WHY ONE MODULE
 *
 * Scattered `process.env.FOO` reads mean configuration is whatever the
 * environment happened to contain at the moment each line ran. A typo yields
 * `undefined`, which becomes the string "undefined" in a URL, and the failure
 * appears wherever that URL is used rather than at startup. Reading everything
 * in one place, once, converts every configuration error into a startup error
 * with the field name in it.
 *
 * PRECEDENCE, HIGHEST WINS
 *
 *   1. explicit overrides passed to `loadSettings()`  (tests)
 *   2. environment variables                          (deployment)
 *   3. secrets/config.{env}.json                      (per-environment)
 *   4. secrets/config.json                            (shared)
 *   5. schema defaults                                (the floor)
 *
 * Environment above files is the deliberate choice: a container sets env vars
 * and cannot easily edit a file baked into an image.
 *
 * This ORDER IS TESTED (`tests/config.test.ts`). The Python exemplar's
 * docstring once described the opposite of what its code did -- documented
 * precedence that nothing verified. A comment is not a guarantee.
 *
 * @see _DOCS/STANDARDS-typescript.md ## Configuration
 * @see _DOCS/STANDARDS-python.md ## config.py -- the keystone
 */

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { z } from "zod";

import { CheckTarget } from "./models/check.ts";

/**
 * Repo root, derived from this file rather than hardcoded, so the tree survives
 * being cloned anywhere.
 */
export const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/**
 * Local development servers use 7100-7199 across the repo set (AGENTS.md).
 * Each app appends a digit to this base, so the four cannot collide.
 */
const PORT_BASE = 715;

/** Which environment the process is running as. A union, not a TS `enum`. */
export const Environment = z.enum(["test", "dev", "prod"]);
export type Environment = z.infer<typeof Environment>;

/**
 * Ports, derived from one base.
 *
 * Derived rather than four independent fields: with four separate values
 * somebody eventually sets two the same, and the failure is an EADDRINUSE at
 * startup on whichever app loses the race.
 */
const PortSettings = z
  .object({
    base: z
      .number()
      .int()
      // 710-719 so derived ports land inside the reserved 7100-7199 band. A
      // base of 800 would yield 8000 and collide with whatever else on the
      // machine already uses the conventional default.
      .min(710)
      .max(719)
      .default(PORT_BASE),
  })
  .transform((value) => ({
    base: value.base,
    monitor: Number(`${String(value.base)}0`),
    watch: Number(`${String(value.base)}1`),
    hook: Number(`${String(value.base)}2`),
    stats: Number(`${String(value.base)}3`),
  }));

/** Logging configuration. Mirrors `utils/logging.ts`'s options. */
const LogSettings = z.object({
  level: z.enum(["trace", "debug", "info", "warn", "error", "fatal"]).default("info"),
  /** Relative to PROJECT_ROOT. Null disables the file sink. */
  file: z.string().nullable().default("logs/exemplar.log"),
  /** Pretty console output. Off in prod, where a log shipper wants JSON. */
  pretty: z.boolean().default(true),
});

/** Database configuration. */
const DatabaseSettings = z.object({
  /** Relative to PROJECT_ROOT, or ":memory:" for tests. */
  path: z.string().default("data/history.db"),
});

/** Monitor app configuration. */
const MonitorSettings = z.object({
  intervalSeconds: z.number().int().positive().max(86_400).default(60),
  targets: z.array(CheckTarget).default([]),
});

/** Webhook receiver configuration. */
const HookSettings = z.object({
  /** Where to forward received payloads. Null disables forwarding. */
  forwardUrl: z.string().url().nullable().default(null),
  /** HMAC secret for signature verification. Never logged. */
  signingSecret: z.string().nullable().default(null),
});

/** Filesystem watcher configuration. */
const WatchSettings = z.object({
  /** Directories to watch, relative to PROJECT_ROOT. */
  paths: z.array(z.string()).default(["data"]),
  /** Milliseconds of quiet before a burst of events is treated as settled. */
  debounceMs: z.number().int().nonnegative().max(60_000).default(250),
});

/** The whole configuration for every app. */
const Settings = z.object({
  env: Environment.default("test"),
  ports: PortSettings.default({}),
  logging: LogSettings.default({}),
  database: DatabaseSettings.default({}),
  monitor: MonitorSettings.default({}),
  hook: HookSettings.default({}),
  watch: WatchSettings.default({}),
});
export type Settings = z.infer<typeof Settings>;

/** Read and parse a JSON file, returning `{}` when it is absent. */
function readJsonIfPresent(path: string): Record<string, unknown> {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch (error: unknown) {
    // ENOENT is expected -- these files are optional by design. Anything else
    // (malformed JSON, a permission problem) is a real fault and must not be
    // swallowed: silently treating a syntax error as "no config" is exactly
    // how a service boots with defaults nobody chose.
    if (
      error instanceof Error &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return {};
    }
    throw new Error(
      `Could not read config file ${path}: ${error instanceof Error ? error.message : String(error)}. ` +
        "ACTION REQUIRED: fix the file's syntax or remove it.",
    );
  }
}

/** Recursively merge `source` over `target`. Objects merge; arrays replace. */
function deepMerge(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...target };
  for (const [key, value] of Object.entries(source)) {
    const existing = out[key];
    const bothPlainObjects =
      typeof value === "object" &&
      value !== null &&
      !Array.isArray(value) &&
      typeof existing === "object" &&
      existing !== null &&
      !Array.isArray(existing);

    // Arrays REPLACE rather than concatenate. Merging them means an override
    // can never shorten a list -- you could add a monitor target but never
    // remove one, which is the surprising half of "deep merge".
    out[key] = bothPlainObjects
      ? deepMerge(existing as Record<string, unknown>, value as Record<string, unknown>)
      : value;
  }
  return out;
}

/**
 * Environment variables, as a nested object.
 *
 * `EXEMPLAR_LOGGING__LEVEL=debug` becomes `{ logging: { level: "debug" } }`.
 * The double underscore is the nesting separator, because a single one is
 * common inside key names.
 */
function envOverrides(env: NodeJS.ProcessEnv): Record<string, unknown> {
  const out: Record<string, unknown> = {};

  for (const [rawKey, rawValue] of Object.entries(env)) {
    if (!rawKey.startsWith("EXEMPLAR_") || rawValue === undefined) continue;

    const path = rawKey
      .slice("EXEMPLAR_".length)
      .toLowerCase()
      .split("__")
      .map((segment) => segment.replace(/_(.)/g, (_, c: string) => c.toUpperCase()));

    // JSON first so numbers, booleans, and arrays survive; fall back to the
    // raw string, which is what a plain word like `debug` is.
    let value: unknown;
    try {
      value = JSON.parse(rawValue);
    } catch {
      // Not JSON, so it is a bare string. This catch is intentionally empty of
      // logging: there is nothing wrong, and `value` is assigned on the next
      // line. It is NOT a swallowed error -- the fallback IS the handling.
      value = rawValue;
    }

    let cursor = out;
    for (const [index, segment] of path.entries()) {
      if (index === path.length - 1) {
        cursor[segment] = value;
        break;
      }
      cursor[segment] ??= {};
      cursor = cursor[segment] as Record<string, unknown>;
    }
  }

  return out;
}

/** Options for {@link loadSettings}. */
export interface LoadOptions {
  /** Which environment. Defaults to `EXEMPLAR_ENV`, then "test". */
  env?: Environment;
  /** Directory holding config.json. Defaults to `<root>/secrets`. */
  secretsDir?: string;
  /** Highest-priority values. For tests. */
  overrides?: Record<string, unknown>;
  /** Environment to read. Injectable so tests need not mutate the real one. */
  processEnv?: NodeJS.ProcessEnv;
}

/**
 * Load, merge, and validate configuration. Call ONCE, at startup.
 *
 * @param options - Environment, secrets directory, overrides.
 * @returns Fully validated settings.
 * @throws {Error} With every invalid field named, when validation fails.
 *   Deliberately fatal: a service that starts with bad configuration fails
 *   later, in production, with a stack trace pointing at a symptom.
 *
 * @example
 * ```ts
 * const settings = loadSettings({ env: "dev" });
 * const logger = createLogger({ service: "monitor", ...settings.logging });
 * ```
 */
export function loadSettings(options: LoadOptions = {}): Settings {
  const processEnv = options.processEnv ?? process.env;
  const env =
    options.env ??
    Environment.catch("test").parse(processEnv["EXEMPLAR_ENV"] ?? "test");
  const secretsDir = options.secretsDir ?? join(PROJECT_ROOT, "secrets");

  const merged = [
    readJsonIfPresent(join(secretsDir, "config.json")),
    readJsonIfPresent(join(secretsDir, `config.${env}.json`)),
    envOverrides(processEnv),
    { env },
    options.overrides ?? {},
  ].reduce<Record<string, unknown>>((acc, layer) => deepMerge(acc, layer), {});

  const parsed = Settings.safeParse(merged);
  if (!parsed.success) {
    // Every failing field at once, not just the first. Fixing configuration
    // one error per restart is how a five-minute task becomes an afternoon.
    const detail = parsed.error.issues
      .map((issue) => `  ${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("\n");
    throw new Error(
      `Invalid configuration for env=${env}:\n${detail}\n` +
        `ACTION REQUIRED: fix ${secretsDir}/config.json, the matching ` +
        `config.${env}.json, or the EXEMPLAR_* environment variables.`,
    );
  }

  return parsed.data;
}
