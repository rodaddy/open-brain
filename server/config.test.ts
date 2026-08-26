/**
 * Configuration boundary tests.
 * Design authority: `docs/code-brain-design.md` R3 and
 * `docs/decisions/shared-kb-canonical-namespace.md`.
 */
import { describe, expect, it, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { loadServerConfig, OPTIONAL_SECRET_KEYS, parseServerConfig } from "./config.ts";
import { resolveFtsConfig } from "./tools/fts-config.ts";
import { resolveQmdPath } from "./tools/search-all.ts";
import { parseAllowedOrigins } from "./transport/rest.ts";
import { readMcpTracingConfig } from "./observability/langfuse-tracing.ts";

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
 * `/opt/open-brain-local/local-clone.env` legitimately sets
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

/**
 * The three states `EMBEDDING_API_KEY` is actually observed in (#548).
 *
 * The issue reported a restart-path rejection of the empty form. The empty case
 * was already fixed by #507 and is asserted above; what had NO coverage was the
 * pair of neighbours that make the rule a rule rather than one special case —
 * absent must behave identically to empty, and a REAL key must still arrive
 * intact. Without the third assertion, "treat blank as absent" could be
 * satisfied by a schema that dropped the field unconditionally, which would
 * disable provider auth everywhere and pass every other test in this file.
 */
describe("EMBEDDING_API_KEY across every observed state", () => {
  it("absent: no key reaches the transport", () => {
    const result = parseServerConfig({ ...REQUIRED });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected valid configuration");
    expect("embeddingApiKey" in result.config.transport).toBe(false);
  });

  it("empty: parses, and is indistinguishable from absent", () => {
    const result = parseServerConfig({ ...REQUIRED, EMBEDDING_API_KEY: "" });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected valid configuration");
    expect("embeddingApiKey" in result.config.transport).toBe(false);
  });

  it("set: the configured key reaches the transport byte-for-byte", () => {
    const key = `real-${randomUUID()}`;
    const result = parseServerConfig({ ...REQUIRED, EMBEDDING_API_KEY: key });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected valid configuration");
    expect(result.config.transport.embeddingApiKey).toBe(key);
  });

  /**
   * Whitespace-only is the form that survived #507 and still reached the wire.
   *
   * `min(1)` counts a space, so `" "` parsed as a real key and
   * `server/transport/health.ts` took its `if (input.embeddingApiKey)` branch
   * and sent `Authorization: Bearer  `. Meanwhile the launcher that starts this
   * process (`scripts/local-clone.ts`) reads `EMBEDDING_API_KEY?.trim()` and
   * sent no header at all — preflight and server disagreeing about one
   * variable. This asserts the config boundary now matches the launcher.
   */
  it("whitespace-only: treated as absent, matching the launcher's own check", () => {
    for (const blank of [" ", "   ", "\t", "\n", " \t\n "]) {
      const result = parseServerConfig({ ...REQUIRED, EMBEDDING_API_KEY: blank });
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("expected valid configuration");
      expect("embeddingApiKey" in result.config.transport).toBe(false);
    }
  });

  it("preserves internal and surrounding characters of a key that has content", () => {
    // Only the blank/non-blank DECISION is normalized. A key whose padding is
    // genuine must not be silently altered into a different credential.
    const padded = "  padded-key  ";
    const result = parseServerConfig({ ...REQUIRED, EMBEDDING_API_KEY: padded });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected valid configuration");
    expect(result.config.transport.embeddingApiKey).toBe(padded);
  });

  it("applies the blank rule to every optional secret, not just the embedding key", () => {
    // Same reasoning as the empty-string parameterization above: the defect is
    // in the shared schema, so a whitespace value in ANY of them must be absent.
    const blanks = Object.fromEntries(OPTIONAL_SECRET_KEYS.map((key) => [key, "   "]));
    const result = parseServerConfig({ ...REQUIRED, ...blanks });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected valid configuration");
    expect(result.config.authTokens).toEqual([]);
    expect("password" in result.config.database).toBe(false);
    expect("embeddingApiKey" in result.config.transport).toBe(false);
  });
});

/**
 * The composition root, which is the function that actually threw on 2026-08-02.
 *
 * Everything above tests `parseServerConfig`, which takes an environment as an
 * argument. The crash stack named `loadServerConfig` — the wrapper that reads
 * the real `process.env` — and it had no test at all. That gap is why the empty
 * form could be fixed in the schema while nothing proved the STARTUP path a
 * launchd service takes was fixed with it.
 */
describe("loadServerConfig against a real process.env", () => {
  const OWNED = [...OPTIONAL_SECRET_KEYS, ...Object.keys(REQUIRED)];

  function withEnv<T>(overrides: Record<string, string | undefined>, run: () => T): T {
    const saved = new Map(OWNED.map((key) => [key, process.env[key]]));
    try {
      for (const key of OWNED) delete process.env[key];
      for (const [key, value] of Object.entries({ ...REQUIRED, ...overrides })) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      return run();
    } finally {
      for (const [key, value] of saved) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  }

  it("starts with EMBEDDING_API_KEY empty, which is the shape that crashed launchd", () => {
    const config = withEnv({ EMBEDDING_API_KEY: "" }, () => loadServerConfig());
    expect("embeddingApiKey" in config.transport).toBe(false);
  });

  it("starts with EMBEDDING_API_KEY absent", () => {
    const config = withEnv({ EMBEDDING_API_KEY: undefined }, () => loadServerConfig());
    expect("embeddingApiKey" in config.transport).toBe(false);
  });

  it("starts with EMBEDDING_API_KEY set, and carries the key through", () => {
    const key = `real-${randomUUID()}`;
    const config = withEnv({ EMBEDDING_API_KEY: key }, () => loadServerConfig());
    expect(config.transport.embeddingApiKey).toBe(key);
  });

  it("still throws a named, field-identifying error on a genuinely invalid environment", () => {
    // The empty-as-absent rule must not have turned the boundary into one that
    // accepts anything: a missing REQUIRED field still has to stop startup, and
    // the message still has to say which field.
    // `load` is named rather than inlined so this stays inside the
    // max-nested-callbacks limit: describe > it > expect-thunk > withEnv-thunk
    // is four deep, and the last two say the same thing.
    const load = () => loadServerConfig();
    expect(() => withEnv({ DB_HOST: "" }, load)).toThrow(
      /server_configuration_invalid.*DB_HOST/,
    );
  });
});

/**
 * The env groups added by #750 lane L2a.
 *
 * Design authority: `_plans/463-server-rewrite-charter.md:108` — `server/config/`
 * owns ALL env parsing and startup validation. Field-by-field scope and the
 * reader each one mirrors are in `_plans/l2-composition-root-inventory.md`.
 *
 * The bar every case below holds to is START-EQUIVALENCE, not tidiness: the
 * assertion is that the schema answers what the CURRENT reader answers for the
 * same input, including the inputs the current reader shrugs off. That is why
 * the "rejection" cases assert a FALLBACK rather than `ok: false` — several of
 * these readers deliberately ignore an unusable value (`abc` → 3000 at
 * `server/tools/search-engine.ts:148`; `-1` → 5 at
 * `server/tools/shared-namespace.ts:52`), and turning that into a startup
 * rejection here would stop a deployment that boots today. A test asserting
 * `ok: false` would be asserting a behavior change nobody asked for.
 */
/**
 * A valid configuration with `overrides` applied, or a failure naming the
 * issues. Shared by every group block below.
 */
function extendedConfig(overrides: Record<string, string | undefined> = {}) {
  const result = parseServerConfig({ ...REQUIRED, ...overrides });
  if (!result.ok) {
    throw new Error(`expected valid configuration: ${JSON.stringify(result.issues)}`);
  }
  return result.config;
}

describe("extended env — search", () => {
  it("defaults the embedding timeout to 3000ms", () => {
    expect(extendedConfig().search.embeddingTimeoutMs).toBe(3_000);
  });

  it("takes an explicit timeout", () => {
    expect(
      extendedConfig({ OPENBRAIN_SEARCH_EMBEDDING_TIMEOUT_MS: "750" }).search.embeddingTimeoutMs,
    ).toBe(750);
  });

  it("falls back to the legacy name when the preferred one is absent", () => {
    expect(
      extendedConfig({ SEARCH_EMBEDDING_TIMEOUT_MS: "900" }).search.embeddingTimeoutMs,
    ).toBe(900);
  });

  it("prefers the current name over the legacy one when both are set", () => {
    expect(
      extendedConfig({
        OPENBRAIN_SEARCH_EMBEDDING_TIMEOUT_MS: "100",
        SEARCH_EMBEDDING_TIMEOUT_MS: "900",
      }).search.embeddingTimeoutMs,
    ).toBe(100);
  });

  it("ignores a below-minimum timeout, and does NOT fall through to the legacy name", () => {
    // The name is chosen before the value is parsed, so an unusable preferred
    // value lands on the DEFAULT, not on whatever the legacy name holds. The
    // unparseable case (`abc`) is covered against the reader itself in the
    // start-equivalence table below.
    expect(
      extendedConfig({
        OPENBRAIN_SEARCH_EMBEDDING_TIMEOUT_MS: "0",
        SEARCH_EMBEDDING_TIMEOUT_MS: "900",
      }).search.embeddingTimeoutMs,
    ).toBe(3_000);
  });
});

describe("extended env — fts", () => {
  it("defaults the corpus configuration to english", () => {
    expect(extendedConfig().fts.corpusConfig).toBe("english");
  });

  it("takes an explicit supported configuration", () => {
    expect(extendedConfig({ OPENBRAIN_FTS_CONFIG: "simple" }).fts.corpusConfig).toBe("simple");
  });

  it("maps a language token to its configuration", () => {
    expect(extendedConfig({ OPENBRAIN_FTS_CONFIG: " Spanish " }).fts.corpusConfig).toBe("spanish");
  });

  // The unrecognized-token fallback is asserted against `resolveFtsConfig`
  // itself in the start-equivalence table below, over the whole input set.
});

describe("extended env — qmd", () => {
  it("omits the path when unset, so federation is off rather than mis-spawned", () => {
    expect("path" in extendedConfig().qmd).toBe(false);
  });

  it("takes an explicit path", () => {
    expect(extendedConfig({ QMD_PATH: "/usr/local/bin/qmd" }).qmd.path).toBe("/usr/local/bin/qmd");
  });

  it("treats a blank path as unset, which is the dogfood shape QMD_PATH=", () => {
    // `docs/qmd-ob-layered-recall.md`: `QMD_PATH=` (empty, not absent) made a
    // `?? default` resolution spawn `bun "" search …` and fail open forever.
    expect("path" in extendedConfig({ QMD_PATH: "   " }).qmd).toBe(false);
  });
});

describe("extended env — recovery", () => {
  it("defaults the WAL path to null", () => {
    expect(extendedConfig().recovery.walPath).toBeNull();
  });

  it("takes an explicit WAL path", () => {
    expect(extendedConfig({ OPENBRAIN_RECOVERY_WAL_PATH: "var/wal.log" }).recovery.walPath).toBe(
      "var/wal.log",
    );
  });

  it("treats a blank WAL path as null", () => {
    expect(extendedConfig({ OPENBRAIN_RECOVERY_WAL_PATH: "" }).recovery.walPath).toBeNull();
  });
});

describe("extended env — sharedNamespaceNames", () => {
  it("defaults physical to the canonical name and legacy to empty", () => {
    const names = extendedConfig().sharedNamespaceNames;
    expect(names.physical).toBe("shared-kb");
    // #167 retired `collab`; an empty legacy name must never match input.
    expect(names.legacy).toBe("");
    expect(names.legacyFallbackEnabled).toBe(false);
    expect(names.fallbackMinResults).toBe(5);
  });

  it("takes an explicit physical name pointed away from the canonical one", () => {
    expect(
      extendedConfig({ SHARED_NAMESPACE_PHYSICAL: "shared-kb-v2" }).sharedNamespaceNames.physical,
    ).toBe("shared-kb-v2");
  });

  it("takes an explicit legacy name, preferring SHARED_NAMESPACE_LEGACY", () => {
    const names = extendedConfig({
      SHARED_NAMESPACE_LEGACY: "collab",
      OPENBRAIN_LEGACY_SHARED_NAMESPACE: "older",
    }).sharedNamespaceNames;
    expect(names.legacy).toBe("collab");
  });

  it("falls back to OPENBRAIN_LEGACY_SHARED_NAMESPACE", () => {
    expect(
      extendedConfig({ OPENBRAIN_LEGACY_SHARED_NAMESPACE: "collab" }).sharedNamespaceNames.legacy,
    ).toBe("collab");
  });

  it("enables the legacy fallback on each permissive true token", () => {
    for (const token of ["1", "true", "YES", " on "]) {
      expect(
        extendedConfig({ OPENBRAIN_LEGACY_SHARED_FALLBACK: token }).sharedNamespaceNames
          .legacyFallbackEnabled,
      ).toBe(true);
    }
  });

  it("treats an unrecognized flag token as false rather than failing startup", () => {
    expect(
      extendedConfig({ OPENBRAIN_LEGACY_SHARED_FALLBACK: "maybe" }).sharedNamespaceNames
        .legacyFallbackEnabled,
    ).toBe(false);
  });

  it("takes an explicit fallback minimum", () => {
    expect(
      extendedConfig({ OPENBRAIN_SHARED_FALLBACK_MIN_RESULTS: "12" }).sharedNamespaceNames
        .fallbackMinResults,
    ).toBe(12);
  });

  it("ignores a non-positive fallback minimum rather than failing startup", () => {
    for (const bad of ["0", "-1", "abc"]) {
      expect(
        extendedConfig({ OPENBRAIN_SHARED_FALLBACK_MIN_RESULTS: bad }).sharedNamespaceNames
          .fallbackMinResults,
      ).toBe(5);
    }
  });
});

describe("extended env — tracing", () => {
  const COORDINATES = {
    OPENBRAIN_TRACING_ENDPOINT: "https://langfuse.internal",
    OPENBRAIN_TRACING_PUBLIC_KEY: "pk-test",
    OPENBRAIN_TRACING_SECRET_KEY: "sk-test",
  };

  it("is off by default, with empty coordinates and masking on", () => {
    const tracing = extendedConfig().tracing;
    expect(tracing.enabled).toBe(false);
    expect(tracing.maskingEnabled).toBe(true);
    expect(tracing.endpoint).toBe("");
  });

  it("is on only when the flag is set AND all three coordinates are present", () => {
    const tracing = extendedConfig({ ...COORDINATES, OPENBRAIN_TRACING_ENABLED: "1" }).tracing;
    expect(tracing.enabled).toBe(true);
    expect(tracing.endpoint).toBe("https://langfuse.internal");
    expect(tracing.publicKey).toBe("pk-test");
  });

  it("stays off when the coordinates are complete but the flag is not exactly 1", () => {
    // An external payload-carrying export is opt-in; `true` is not the flag.
    expect(
      extendedConfig({ ...COORDINATES, OPENBRAIN_TRACING_ENABLED: "true" }).tracing.enabled,
    ).toBe(false);
  });

  // The incomplete-coordinate and masking shapes are asserted against
  // `readMcpTracingConfig` itself in the start-equivalence block below.

  it("disables masking only on an exact 0", () => {
    expect(extendedConfig({ OPENBRAIN_TRACING_MASKING_ENABLED: "0" }).tracing.maskingEnabled).toBe(
      false,
    );
    expect(
      extendedConfig({ OPENBRAIN_TRACING_MASKING_ENABLED: "false" }).tracing.maskingEnabled,
    ).toBe(true);
  });
});

describe("extended env — captureHealth", () => {
  it("omits the namespace when unset — no observer, never a guessed tenant", () => {
    const capture = extendedConfig().captureHealth;
    expect("namespace" in capture).toBe(false);
    expect(capture.windowMinutes).toBe(360);
    expect(capture.refreshMs).toBe(60_000);
  });

  it("takes an explicit namespace, window, and refresh", () => {
    const capture = extendedConfig({
      OPENBRAIN_CAPTURE_HEALTH_NAMESPACE: "rico",
      OPENBRAIN_CAPTURE_HEALTH_WINDOW_MINUTES: "60",
      OPENBRAIN_CAPTURE_HEALTH_REFRESH_MS: "5000",
    }).captureHealth;
    expect(capture.namespace).toBe("rico");
    expect(capture.windowMinutes).toBe(60);
    expect(capture.refreshMs).toBe(5_000);
  });

  it("treats a blank namespace as unset, which is what disables the observer", () => {
    expect("namespace" in extendedConfig({ OPENBRAIN_CAPTURE_HEALTH_NAMESPACE: "  " }).captureHealth).toBe(
      false,
    );
  });

  // The unparseable and non-positive cases are asserted against
  // `readPositiveInteger` itself in the start-equivalence table below.
});

describe("extended env — http", () => {
  it("defaults to port 3100 and an EMPTY origin allowlist, never a wildcard", () => {
    const http = extendedConfig().http;
    expect(http.port).toBe(3_100);
    expect(http.allowedOrigins).toEqual([]);
  });

  it("takes an explicit port", () => {
    expect(extendedConfig({ PORT: "7150" }).http.port).toBe(7_150);
  });

  it("rejects an unbindable port by name instead of substituting a default", () => {
    // The reader is `Number(process.env.PORT ?? DEFAULT_PORT)`
    // (`server/main.ts:362`) and `Number("not-a-port")` is `NaN`, which
    // `listen` throws on — so this deployment does NOT start today. A silent
    // 3100 here would boot it on a port nobody configured; a named config
    // issue is the same crash, reached earlier. Full equivalence table is in
    // the start-equivalence block below.
    const result = parseServerConfig({ ...REQUIRED, PORT: "not-a-port" });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected an unbindable port to be rejected");
    expect(result.issues.map((issue) => issue.path)).toEqual(["PORT"]);
  });

  it("splits, trims, and drops blanks from the origin list", () => {
    expect(
      extendedConfig({ ALLOWED_ORIGINS: "https://a.example, ,https://b.example " }).http
        .allowedOrigins,
    ).toEqual(["https://a.example", "https://b.example"]);
  });

  // The blank list is asserted against `parseAllowedOrigins` itself in the
  // start-equivalence table below, over the whole input set.
});


/**
 * START-EQUIVALENCE: the schema must answer what the READER answers.
 *
 * The blocks above assert the schema against a hand-written expected value,
 * which is what let three divergences pass their own suite (PR #778 review):
 * every input they chose is one on which reader and schema happen to agree.
 * These drive the assertion from the reader instead, over the reviewer's
 * divergence-finding input set, so the equivalence claim is falsifiable.
 *
 * An exported reader is IMPORTED and called. A module-private one has its exact
 * expression written out beside its file and line, so an edit to either side
 * fails a test rather than drifting apart quietly.
 */
const DIVERGENCE_INPUTS = [
  "3000ms", "10.5", "1e3", " 42 ", "0x10", "abc", "-1", "0", "", "   ",
  undefined, "007", "3,000", "+5", "Infinity",
] as const;

/** `server/capture/liveness-observer.ts:535-550`, reproduced: `Number`, not `parseInt`. */
function readPositiveInteger(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number(raw.trim());
  const ok = Number.isFinite(parsed) && Number.isInteger(parsed) && parsed > 0;
  return ok ? parsed : fallback;
}

/** `server/tools/search-engine.ts:147-152`, reproduced: `??` does NOT skip `""`. */
function searchEmbeddingTimeoutMs(
  preferred: string | undefined,
  legacy: string | undefined,
): number {
  const raw = preferred ?? legacy;
  if (!raw) return 3_000;
  const parsed = Number.parseInt(raw, 10);
  return Number.isNaN(parsed) || parsed < 1 ? 3_000 : parsed;
}

/**
 * `server/main.ts:362` is `Number(process.env.PORT ?? DEFAULT_PORT)` handed to
 * `server.listen(port)`, which THROWS on a non-integer or an out-of-range one —
 * so those environments crash today and a named rejection is that same crash,
 * earlier. A silent 3100 would instead boot a deployment that does not boot.
 */
function expectPortMatchesReader(input: string | undefined): void {
  const expected = Number(input ?? 3_100);
  const bindable = Number.isInteger(expected) && expected >= 0 && expected <= 65_535;
  const result = parseServerConfig({ ...REQUIRED, PORT: input });
  if (bindable) {
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected valid configuration");
    expect(result.config.http.port).toBe(expected);
    return;
  }
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error(`expected PORT=${String(input)} rejected`);
  expect(result.issues.map((issue) => issue.path)).toEqual(["PORT"]);
}

function expectCaptureHealthMatchesReader(input: string | undefined): void {
  const capture = extendedConfig({
    OPENBRAIN_CAPTURE_HEALTH_WINDOW_MINUTES: input,
    OPENBRAIN_CAPTURE_HEALTH_REFRESH_MS: input,
  }).captureHealth;
  expect(capture.windowMinutes).toBe(readPositiveInteger(input, 360));
  expect(capture.refreshMs).toBe(readPositiveInteger(input, 60_000));
}

function expectSearchTimeoutMatchesReader(input: string | undefined): void {
  expect(
    extendedConfig({ OPENBRAIN_SEARCH_EMBEDDING_TIMEOUT_MS: input }).search.embeddingTimeoutMs,
  ).toBe(searchEmbeddingTimeoutMs(input, undefined));
  expect(
    extendedConfig({ SEARCH_EMBEDDING_TIMEOUT_MS: input }).search.embeddingTimeoutMs,
  ).toBe(searchEmbeddingTimeoutMs(undefined, input));
}

/** The readers that ARE exported are imported and called, not reproduced. */
function expectExportedReadersAgree(input: string | undefined): void {
  const config = extendedConfig({
    OPENBRAIN_FTS_CONFIG: input,
    ALLOWED_ORIGINS: input,
    QMD_PATH: input,
  });
  expect(config.fts.corpusConfig).toEqual(resolveFtsConfig(input?.trim()));
  expect(config.http.allowedOrigins).toEqual(parseAllowedOrigins(input));
  expect(config.qmd.path).toBe(resolveQmdPath({ QMD_PATH: input }));
}

describe("start-equivalence — every field answers what its reader answers", () => {
  test.each([...DIVERGENCE_INPUTS])("every reader agrees for %o", (input) => {
    expectPortMatchesReader(input);
    expectCaptureHealthMatchesReader(input);
    expectSearchTimeoutMatchesReader(input);
    expectExportedReadersAgree(input);
  });

  it("binds the ephemeral port for PORT= rather than substituting 3100", () => {
    // `Number("")` is 0, and 0 asks the OS for an ephemeral port. That is a real
    // deployment shape — the same one `QMD_PATH=` produced a live defect with.
    expect(extendedConfig({ PORT: "" }).http.port).toBe(0);
    expect(extendedConfig({ PORT: "   " }).http.port).toBe(0);
  });

  it("takes Number's reading of exponent, hex, and padded port forms", () => {
    expect(extendedConfig({ PORT: "1e3" }).http.port).toBe(1_000);
    expect(extendedConfig({ PORT: "0x10" }).http.port).toBe(16);
    expect(extendedConfig({ PORT: " 42 " }).http.port).toBe(42);
  });

  it("does not fall through to the legacy timeout name when the preferred is blank", () => {
    // `??` is not `||`: a present-but-empty preferred name is still PRESENT, so
    // the reader answers 3000 and never looks at the legacy value.
    const answer = extendedConfig({
      OPENBRAIN_SEARCH_EMBEDDING_TIMEOUT_MS: "",
      SEARCH_EMBEDDING_TIMEOUT_MS: "900",
    }).search.embeddingTimeoutMs;
    expect(answer).toBe(searchEmbeddingTimeoutMs("", "900"));
    expect(answer).toBe(3_000);
  });
});

/**
 * Canonical shared-namespace precedence.
 *
 * `server/tools/shared-namespace.ts:79-82` is
 * `envString(["SHARED_NAMESPACE_CANONICAL", "OPENBRAIN_SHARED_NAMESPACE"], …)`
 * — the first NON-EMPTY trimmed value in THAT order, so the canonical name
 * wins. The schema declares it as a literal with a default
 * (`server/config.ts:167`), so `parsed` cannot express "unset" and the RAW
 * environment value has to decide. Namespace resolution is a security boundary
 * (`docs/sme/security.md`); the same value propagates into `physical`.
 */
describe("start-equivalence — shared-namespace canonical precedence", () => {
  test.each([
    // canonical unset -> the override is what `envString` reaches next
    [{ OPENBRAIN_SHARED_NAMESPACE: "other" }, "other"],
    // both set -> the CANONICAL name wins; the group had this inverted
    [{ SHARED_NAMESPACE_CANONICAL: "shared-kb", OPENBRAIN_SHARED_NAMESPACE: "other" }, "shared-kb"],
    // an explicit physical name outranks either canonical coordinate
    [{ OPENBRAIN_SHARED_NAMESPACE: "other", SHARED_NAMESPACE_PHYSICAL: "shared-kb-v2" }, "shared-kb-v2"],
  ])("resolves the physical name from %o", (env, expected) => {
    expect(extendedConfig(env).sharedNamespaceNames.physical).toBe(expected);
  });

  it("matches readMcpTracingConfig on the complete and incomplete shapes", () => {
    const complete = {
      OPENBRAIN_TRACING_ENABLED: "1",
      OPENBRAIN_TRACING_ENDPOINT: "https://langfuse.internal",
      OPENBRAIN_TRACING_PUBLIC_KEY: "pk",
      OPENBRAIN_TRACING_SECRET_KEY: "sk",
    };
    const incomplete = { ...complete, OPENBRAIN_TRACING_ENDPOINT: "  " };
    for (const shape of [{}, { OPENBRAIN_TRACING_ENABLED: "1" }, complete, incomplete]) {
      const reader = readMcpTracingConfig(shape);
      const schema = extendedConfig(shape).tracing;
      expect(schema.enabled).toBe(reader.enabled);
      expect(schema.maskingEnabled).toBe(reader.maskingEnabled);
      expect(schema.endpoint).toBe(reader.endpoint);
      expect(schema.publicKey).toBe(reader.publicKey);
    }
  });
});
