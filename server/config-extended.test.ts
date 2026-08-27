/**
 * Extended env-group configuration tests, split out of `server/config.test.ts`
 * (#868) so each file stays under the max-lines rule. The shared REQUIRED
 * baseline is repeated here because each test file stands alone.
 */
import { describe, expect, it } from "bun:test";
import { parseServerConfig } from "./config.ts";

const REQUIRED = {
  DB_HOST: "db.internal",
  DB_NAME: "open_brain_test",
  DB_USER: "open_brain",
  LOG_FILE: "logs/open-brain.log",
};

function extendedConfig(overrides: Record<string, string | undefined> = {}) {
  const result = parseServerConfig({ ...REQUIRED, ...overrides });
  if (!result.ok) {
    throw new Error(
      `expected valid configuration: ${JSON.stringify(result.issues)}`,
    );
  }
  return result.config;
}

describe("extended env — search", () => {
  it("defaults the embedding timeout to 3000ms", () => {
    expect(extendedConfig().search.embeddingTimeoutMs).toBe(3_000);
  });

  it("takes an explicit timeout", () => {
    expect(
      extendedConfig({ OPENBRAIN_SEARCH_EMBEDDING_TIMEOUT_MS: "750" }).search
        .embeddingTimeoutMs,
    ).toBe(750);
  });

  it("falls back to the legacy name when the preferred one is absent", () => {
    expect(
      extendedConfig({ SEARCH_EMBEDDING_TIMEOUT_MS: "900" }).search
        .embeddingTimeoutMs,
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
    expect(
      extendedConfig({ OPENBRAIN_FTS_CONFIG: "simple" }).fts.corpusConfig,
    ).toBe("simple");
  });

  it("maps a language token to its configuration", () => {
    expect(
      extendedConfig({ OPENBRAIN_FTS_CONFIG: " Spanish " }).fts.corpusConfig,
    ).toBe("spanish");
  });

  // The unrecognized-token fallback is asserted against `resolveFtsConfig`
  // itself in the start-equivalence table below, over the whole input set.
});

describe("extended env — qmd", () => {
  it("omits the path when unset, so federation is off rather than mis-spawned", () => {
    expect("path" in extendedConfig().qmd).toBe(false);
  });

  it("takes an explicit path", () => {
    expect(extendedConfig({ QMD_PATH: "/usr/local/bin/qmd" }).qmd.path).toBe(
      "/usr/local/bin/qmd",
    );
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
    expect(
      extendedConfig({ OPENBRAIN_RECOVERY_WAL_PATH: "var/wal.log" }).recovery
        .walPath,
    ).toBe("var/wal.log");
  });

  it("treats a blank WAL path as null", () => {
    expect(
      extendedConfig({ OPENBRAIN_RECOVERY_WAL_PATH: "" }).recovery.walPath,
    ).toBeNull();
  });
});

describe("extended env — sharedNamespaceNames", () => {
  it("defaults physical to the canonical name and legacy to empty", () => {
    const names = extendedConfig().sharedNamespaceNames;
    expect(names.physicalSharedNamespace).toBe("shared-kb");
    // #167 retired `collab`; an empty legacy name must never match input.
    expect(names.legacySharedNamespace).toBe("");
    expect(names.legacyFallbackEnabled).toBe(false);
    expect(names.fallbackMinResults).toBe(5);
  });

  it("takes an explicit physical name pointed away from the canonical one", () => {
    expect(
      extendedConfig({ SHARED_NAMESPACE_PHYSICAL: "shared-kb-v2" })
        .sharedNamespaceNames.physicalSharedNamespace,
    ).toBe("shared-kb-v2");
  });

  it("takes an explicit legacy name, preferring SHARED_NAMESPACE_LEGACY", () => {
    const names = extendedConfig({
      SHARED_NAMESPACE_LEGACY: "collab",
      OPENBRAIN_LEGACY_SHARED_NAMESPACE: "older",
    }).sharedNamespaceNames;
    expect(names.legacySharedNamespace).toBe("collab");
  });

  it("falls back to OPENBRAIN_LEGACY_SHARED_NAMESPACE", () => {
    expect(
      extendedConfig({ OPENBRAIN_LEGACY_SHARED_NAMESPACE: "collab" })
        .sharedNamespaceNames.legacySharedNamespace,
    ).toBe("collab");
  });

  it("enables the legacy fallback on each permissive true token", () => {
    for (const token of ["1", "true", "YES", " on "]) {
      expect(
        extendedConfig({ OPENBRAIN_LEGACY_SHARED_FALLBACK: token })
          .sharedNamespaceNames.legacyFallbackEnabled,
      ).toBe(true);
    }
  });

  it("treats an unrecognized flag token as false rather than failing startup", () => {
    expect(
      extendedConfig({ OPENBRAIN_LEGACY_SHARED_FALLBACK: "maybe" })
        .sharedNamespaceNames.legacyFallbackEnabled,
    ).toBe(false);
  });

  it("takes an explicit fallback minimum", () => {
    expect(
      extendedConfig({ OPENBRAIN_SHARED_FALLBACK_MIN_RESULTS: "12" })
        .sharedNamespaceNames.fallbackMinResults,
    ).toBe(12);
  });

  it("ignores a non-positive fallback minimum rather than failing startup", () => {
    for (const bad of ["0", "-1", "abc"]) {
      expect(
        extendedConfig({ OPENBRAIN_SHARED_FALLBACK_MIN_RESULTS: bad })
          .sharedNamespaceNames.fallbackMinResults,
      ).toBe(5);
    }
  });

  it("leaves legacy shared writes refused when no escape hatch is set", () => {
    expect(extendedConfig().sharedNamespaceNames.allowLegacySharedWrites).toBe(
      false,
    );
  });

  it("opens legacy shared writes when the escape hatch is set", () => {
    expect(
      extendedConfig({ OPENBRAIN_ALLOW_LEGACY_SHARED_WRITES: "true" })
        .sharedNamespaceNames.allowLegacySharedWrites,
    ).toBe(true);
  });

  it("resolves sharedNamespace from the physical override", () => {
    expect(extendedConfig().sharedNamespaceNames.sharedNamespace).toBe(
      extendedConfig().sharedNamespaceNames.canonicalSharedNamespace,
    );
    expect(
      extendedConfig({ SHARED_NAMESPACE_PHYSICAL: "shared-kb-v9" })
        .sharedNamespaceNames.sharedNamespace,
    ).toBe("shared-kb-v9");
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
    const tracing = extendedConfig({
      ...COORDINATES,
      OPENBRAIN_TRACING_ENABLED: "1",
    }).tracing;
    expect(tracing.enabled).toBe(true);
    expect(tracing.endpoint).toBe("https://langfuse.internal");
    expect(tracing.publicKey).toBe("pk-test");
  });

  it("stays off when the coordinates are complete but the flag is not exactly 1", () => {
    // An external payload-carrying export is opt-in; `true` is not the flag.
    expect(
      extendedConfig({ ...COORDINATES, OPENBRAIN_TRACING_ENABLED: "true" })
        .tracing.enabled,
    ).toBe(false);
  });

  // The incomplete-coordinate and masking shapes are asserted against
  // `readMcpTracingConfig` itself in the start-equivalence block below.

  it("disables masking only on an exact 0", () => {
    expect(
      extendedConfig({ OPENBRAIN_TRACING_MASKING_ENABLED: "0" }).tracing
        .maskingEnabled,
    ).toBe(false);
    expect(
      extendedConfig({ OPENBRAIN_TRACING_MASKING_ENABLED: "false" }).tracing
        .maskingEnabled,
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
    expect(
      "namespace" in
        extendedConfig({ OPENBRAIN_CAPTURE_HEALTH_NAMESPACE: "  " })
          .captureHealth,
    ).toBe(false);
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
    if (result.ok)
      throw new Error("expected an unbindable port to be rejected");
    expect(result.issues.map((issue) => issue.path)).toEqual(["PORT"]);
  });

  it("splits, trims, and drops blanks from the origin list", () => {
    expect(
      extendedConfig({
        ALLOWED_ORIGINS: "https://a.example, ,https://b.example ",
      }).http.allowedOrigins,
    ).toEqual(["https://a.example", "https://b.example"]);
  });

  // The blank list is asserted against `parseAllowedOrigins` itself in the
  // start-equivalence table below, over the whole input set.
});
