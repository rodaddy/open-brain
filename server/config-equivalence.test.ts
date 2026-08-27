/**
 * Start-equivalence tests, split out of `server/config.test.ts` (#868) so each
 * file stays under the max-lines rule. The shared REQUIRED baseline and the
 * `extendedConfig` helper are repeated here because each test file stands
 * alone.
 */
import { describe, expect, it, test } from "bun:test";
import { parseServerConfig } from "./config.ts";
import { resolveFtsConfig } from "./tools/fts-config.ts";
import { resolveQmdPath } from "./tools/search-all.ts";
import {
  canonicalNamespace,
  isSharedNamespace,
  physicalNamespace,
  sharedNamespaceConfig,
} from "./tools/shared-namespace.ts";
import { parseAllowedOrigins } from "./transport/rest.ts";
import { readMcpTracingConfig } from "./observability/langfuse-tracing.ts";

const REQUIRED = {
  DB_HOST: "db.internal",
  DB_NAME: "open_brain_test",
  DB_USER: "open_brain",
  LOG_FILE: "logs/open-brain.log",
};

/**
 * A valid configuration with `overrides` applied, or a failure naming the
 * issues.
 */
function extendedConfig(overrides: Record<string, string | undefined> = {}) {
  const result = parseServerConfig({ ...REQUIRED, ...overrides });
  if (!result.ok) {
    throw new Error(
      `expected valid configuration: ${JSON.stringify(result.issues)}`,
    );
  }
  return result.config;
}

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
  "3000ms",
  "10.5",
  "1e3",
  " 42 ",
  "0x10",
  "abc",
  "-1",
  "0",
  "",
  "   ",
  undefined,
  "007",
  "3,000",
  "+5",
  "Infinity",
] as const;

/** `server/capture/liveness-observer.ts:535-550`, reproduced: `Number`, not `parseInt`. */
function readPositiveInteger(
  raw: string | undefined,
  fallback: number,
): number {
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
  const bindable =
    Number.isInteger(expected) && expected >= 0 && expected <= 65_535;
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
    extendedConfig({ OPENBRAIN_SEARCH_EMBEDDING_TIMEOUT_MS: input }).search
      .embeddingTimeoutMs,
  ).toBe(searchEmbeddingTimeoutMs(input, undefined));
  expect(
    extendedConfig({ SEARCH_EMBEDDING_TIMEOUT_MS: input }).search
      .embeddingTimeoutMs,
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
    [
      {
        SHARED_NAMESPACE_CANONICAL: "shared-kb",
        OPENBRAIN_SHARED_NAMESPACE: "other",
      },
      "shared-kb",
    ],
    // an explicit physical name outranks either canonical coordinate
    [
      {
        OPENBRAIN_SHARED_NAMESPACE: "other",
        SHARED_NAMESPACE_PHYSICAL: "shared-kb-v2",
      },
      "shared-kb-v2",
    ],
  ])("resolves the physical name from %o", (env, expected) => {
    expect(
      extendedConfig(env).sharedNamespaceNames.physicalSharedNamespace,
    ).toBe(expected);
  });

  it("matches readMcpTracingConfig on the complete and incomplete shapes", () => {
    const complete = {
      OPENBRAIN_TRACING_ENABLED: "1",
      OPENBRAIN_TRACING_ENDPOINT: "https://langfuse.internal",
      OPENBRAIN_TRACING_PUBLIC_KEY: "pk",
      OPENBRAIN_TRACING_SECRET_KEY: "sk",
    };
    const incomplete = { ...complete, OPENBRAIN_TRACING_ENDPOINT: "  " };
    for (const shape of [
      {},
      { OPENBRAIN_TRACING_ENABLED: "1" },
      complete,
      incomplete,
    ]) {
      const reader = readMcpTracingConfig(shape, {
        info: () => {},
        warn: () => {},
      });
      const schema = extendedConfig(shape).tracing;
      expect(schema.enabled).toBe(reader.enabled);
      expect(schema.maskingEnabled).toBe(reader.maskingEnabled);
      expect(schema.endpoint).toBe(reader.endpoint);
      expect(schema.publicKey).toBe(reader.publicKey);
    }
  });
});

/**
 * Agreement between the validated group and the environment reader it mirrors.
 *
 * L2b-2 rung 5a leaves BOTH paths in force: `sharedNamespaceConfig()` still
 * derives from `process.env`, and `config.sharedNamespaceNames` now carries the
/**
 * The composition root is now the ONLY source of shared-namespace names.
 *
 * L2b-2 is finished: `server/tools/shared-namespace.ts` reads no environment at
 * all, so the previous agreement test between the validated group and an
 * environment reader no longer has two sides to compare. What has to stay true
 * instead is that a call site which never received the names FAILS rather than
 * resolving a default — namespace resolution is a security frontier
 * (`docs/sme/security.md`), and a silent default there would bind an isolation
 * predicate to the wrong partition.
 */
describe("shared-namespace helpers require the validated name set", () => {
  const NAMES = {
    canonicalSharedNamespace: "shared-kb",
    physicalSharedNamespace: "shared-kb-v2",
    legacySharedNamespace: "collab",
    legacyFallbackEnabled: false,
    fallbackMinResults: 5,
    sharedNamespace: "shared-kb-v2",
    allowLegacySharedWrites: false,
  };

  it("uses the passed set", () => {
    expect(isSharedNamespace("shared-kb-v2", NAMES)).toBe(true);
    expect(canonicalNamespace("shared-kb-v2", NAMES)).toBe("shared-kb");
    expect(canonicalNamespace("collab", NAMES)).toBe("shared-kb");
    expect(physicalNamespace("shared-kb", NAMES)).toBe("shared-kb-v2");
  });

  it("throws naming sharedNamespaceNames when the set is missing", () => {
    expect(() => isSharedNamespace("x", undefined)).toThrow(
      /sharedNamespaceNames/,
    );
    expect(() => isSharedNamespace("x", undefined)).toThrow(
      /isSharedNamespace/,
    );
  });

  it("throws from every helper that resolves a name", () => {
    expect(() => canonicalNamespace("x", undefined)).toThrow(
      /sharedNamespaceNames/,
    );
    expect(() => physicalNamespace("x", undefined)).toThrow(
      /sharedNamespaceNames/,
    );
    expect(() => sharedNamespaceConfig(undefined)).toThrow(
      /sharedNamespaceNames/,
    );
  });

  it("carries the same fields as the validated config group", () => {
    expect(sharedNamespaceConfig(NAMES)).toEqual(NAMES);
    expect(Object.keys(extendedConfig({}).sharedNamespaceNames).sort()).toEqual(
      Object.keys(NAMES).sort(),
    );
  });
});
