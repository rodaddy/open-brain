import { describe, it, expect } from "bun:test";
import {
  SUPPORTED_FTS_CONFIGS,
  DEFAULT_FTS_CONFIG,
  DEFAULT_FTS_STATEMENT_TIMEOUT_MS,
  ftsConfigSchema,
  ftsStatementTimeoutMs,
  resolveFtsConfig,
  corpusFtsConfig,
  requestFtsConfig,
  ftsConfigLiteral,
} from "../fts-config.ts";

describe("fts-config supported-language policy", () => {
  it("keeps english as the default so unset corpora behave exactly as before", () => {
    expect(DEFAULT_FTS_CONFIG).toBe("english");
    expect(SUPPORTED_FTS_CONFIGS[0]).toBe("english");
  });

  it("only allows Postgres-shipped regconfigs on the allowlist", () => {
    // Guard against accidentally adding a config Postgres does not ship by
    // default. Widening this set is a deliberate, tested change.
    expect(new Set(SUPPORTED_FTS_CONFIGS)).toEqual(
      new Set([
        "english",
        "simple",
        "spanish",
        "french",
        "german",
        "portuguese",
      ]),
    );
  });

  it("rejects any value not on the allowlist at the schema boundary", () => {
    expect(ftsConfigSchema.safeParse("english").success).toBe(true);
    expect(ftsConfigSchema.safeParse("german").success).toBe(true);
    expect(ftsConfigSchema.safeParse("klingon").success).toBe(false);
    // An injection attempt must never validate.
    expect(
      ftsConfigSchema.safeParse("english'); DROP TABLE thoughts; --").success,
    ).toBe(false);
  });
});

describe("resolveFtsConfig -- source language metadata -> config", () => {
  it("maps recognized ISO-639-1 codes to their stemmer config", () => {
    expect(resolveFtsConfig("en")).toBe("english");
    expect(resolveFtsConfig("es")).toBe("spanish");
    expect(resolveFtsConfig("fr")).toBe("french");
    expect(resolveFtsConfig("de")).toBe("german");
    expect(resolveFtsConfig("pt")).toBe("portuguese");
  });

  it("accepts BCP-47 region variants by their primary subtag", () => {
    expect(resolveFtsConfig("en-US")).toBe("english");
    expect(resolveFtsConfig("de-DE")).toBe("german");
    expect(resolveFtsConfig("pt_BR")).toBe("portuguese");
    expect(resolveFtsConfig("es-419")).toBe("spanish");
  });

  it("accepts full language names case-insensitively", () => {
    expect(resolveFtsConfig("German")).toBe("german");
    expect(resolveFtsConfig("  FRENCH  ")).toBe("french");
  });

  it("maps mixed/unknown-language markers to the language-neutral simple config", () => {
    expect(resolveFtsConfig("simple")).toBe("simple");
    expect(resolveFtsConfig("und")).toBe("simple");
  });

  it("falls back to english for empty, null, or unrecognized languages", () => {
    expect(resolveFtsConfig(null)).toBe("english");
    expect(resolveFtsConfig(undefined)).toBe("english");
    expect(resolveFtsConfig("")).toBe("english");
    expect(resolveFtsConfig("klingon")).toBe("english");
    expect(resolveFtsConfig("zz-ZZ")).toBe("english");
  });
});

describe("corpusFtsConfig -- deployment env resolution", () => {
  it("defaults to english when OPENBRAIN_FTS_CONFIG is unset or blank", () => {
    expect(corpusFtsConfig({})).toBe("english");
    expect(corpusFtsConfig({ OPENBRAIN_FTS_CONFIG: "" })).toBe("english");
    expect(corpusFtsConfig({ OPENBRAIN_FTS_CONFIG: "   " })).toBe("english");
  });

  it("accepts a direct supported regconfig name", () => {
    expect(corpusFtsConfig({ OPENBRAIN_FTS_CONFIG: "german" })).toBe("german");
    expect(corpusFtsConfig({ OPENBRAIN_FTS_CONFIG: "SPANISH" })).toBe(
      "spanish",
    );
  });

  it("accepts a source-style language token via the same allowlist", () => {
    expect(corpusFtsConfig({ OPENBRAIN_FTS_CONFIG: "de-DE" })).toBe("german");
    expect(corpusFtsConfig({ OPENBRAIN_FTS_CONFIG: "pt" })).toBe("portuguese");
  });

  it("never disables lexical search on a typo -- unknown falls back to english", () => {
    expect(corpusFtsConfig({ OPENBRAIN_FTS_CONFIG: "gernam" })).toBe("english");
  });
});

describe("requestFtsConfig -- explicit per-request selection", () => {
  it("uses the corpus default when no explicit config is given", () => {
    expect(requestFtsConfig(undefined, {})).toBe("english");
    expect(requestFtsConfig(null, {})).toBe("english");
    expect(requestFtsConfig("  ", {})).toBe("english");
    expect(
      requestFtsConfig(undefined, { OPENBRAIN_FTS_CONFIG: "german" }),
    ).toBe("german");
  });

  it("an explicit supported regconfig wins over the env default", () => {
    expect(
      requestFtsConfig("spanish", { OPENBRAIN_FTS_CONFIG: "german" }),
    ).toBe("spanish");
    expect(requestFtsConfig("GERMAN", {})).toBe("german");
  });

  it("accepts an explicit language token via the same allowlist", () => {
    expect(requestFtsConfig("de-DE", {})).toBe("german");
    expect(requestFtsConfig("pt", {})).toBe("portuguese");
  });

  it("honors an explicit english token even when the corpus default differs", () => {
    // A caller explicitly asking for english must get english, not the corpus.
    expect(requestFtsConfig("en", { OPENBRAIN_FTS_CONFIG: "german" })).toBe(
      "english",
    );
    expect(
      requestFtsConfig("english", { OPENBRAIN_FTS_CONFIG: "spanish" }),
    ).toBe("english");
  });

  it("unrecognized explicit values fall back to the corpus default, not english", () => {
    // A typo must never silently override a configured corpus with english.
    expect(requestFtsConfig("gernam", { OPENBRAIN_FTS_CONFIG: "german" })).toBe(
      "german",
    );
    // With no corpus configured, an unrecognized value degrades to english.
    expect(requestFtsConfig("klingon", {})).toBe("english");
  });

  it("never yields a value off the allowlist for a hostile input", () => {
    const hostile = "english'); DROP TABLE thoughts; --";
    const result = requestFtsConfig(hostile, {});
    expect(SUPPORTED_FTS_CONFIGS).toContain(result);
  });
});

describe("ftsStatementTimeoutMs -- non-default FTS cost bound", () => {
  it("defaults to 5000 ms when the env knob is unset or blank", () => {
    expect(DEFAULT_FTS_STATEMENT_TIMEOUT_MS).toBe(5000);
    expect(ftsStatementTimeoutMs({})).toBe(5000);
    expect(
      ftsStatementTimeoutMs({ OPENBRAIN_FTS_STATEMENT_TIMEOUT_MS: "" }),
    ).toBe(5000);
    expect(
      ftsStatementTimeoutMs({ OPENBRAIN_FTS_STATEMENT_TIMEOUT_MS: "   " }),
    ).toBe(5000);
  });

  it("accepts a positive integer override (whitespace tolerated)", () => {
    expect(
      ftsStatementTimeoutMs({ OPENBRAIN_FTS_STATEMENT_TIMEOUT_MS: "250" }),
    ).toBe(250);
    expect(
      ftsStatementTimeoutMs({ OPENBRAIN_FTS_STATEMENT_TIMEOUT_MS: " 15000 " }),
    ).toBe(15000);
  });

  it("falls back to the default for anything that is not a positive integer", () => {
    for (const invalid of [
      "abc",
      "-5",
      "0",
      "2.5",
      "1e3",
      "0x10",
      "5000ms",
      "5; DROP TABLE thoughts",
      "9007199254740993", // beyond Number.MAX_SAFE_INTEGER
    ]) {
      expect(
        ftsStatementTimeoutMs({ OPENBRAIN_FTS_STATEMENT_TIMEOUT_MS: invalid }),
      ).toBe(5000);
    }
  });

  it("falls back to the default above the 32-bit statement_timeout maximum", () => {
    expect(
      ftsStatementTimeoutMs({
        OPENBRAIN_FTS_STATEMENT_TIMEOUT_MS: "2147483647",
      }),
    ).toBe(2147483647);
    for (const overflow of ["2147483648", "3000000000", "9007199254740991"]) {
      expect(
        ftsStatementTimeoutMs({ OPENBRAIN_FTS_STATEMENT_TIMEOUT_MS: overflow }),
      ).toBe(5000);
    }
  });

  it("always returns a finite positive number, never env text", () => {
    for (const raw of ["german", "'; --", "NaN", "Infinity", "01000"]) {
      const value = ftsStatementTimeoutMs({
        OPENBRAIN_FTS_STATEMENT_TIMEOUT_MS: raw,
      });
      expect(typeof value).toBe("number");
      expect(Number.isSafeInteger(value)).toBe(true);
      expect(value).toBeGreaterThan(0);
    }
  });
});

describe("ftsConfigLiteral -- SQL interpolation backstop", () => {
  it("returns the config unchanged for allowlisted values", () => {
    for (const config of SUPPORTED_FTS_CONFIGS) {
      expect(ftsConfigLiteral(config)).toBe(config);
    }
  });

  it("throws if a non-allowlisted value reaches interpolation", () => {
    // Simulate a caller bypassing the type system.
    expect(() =>
      ftsConfigLiteral("english'; DROP TABLE thoughts; --" as never),
    ).toThrow(/Unsupported FTS configuration/);
  });
});
