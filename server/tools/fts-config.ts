/**
 * Language-aware full-text-search configuration selection for the search arms.
 *
 * Design authority: issue #341 (SOURCE-5). The lexical arm builds its
 * tsvector/tsquery with a Postgres text-search configuration ("regconfig") that
 * controls stemming and stopword handling. When the query arm analyzes text with
 * a different configuration than the indexed text was analyzed with, recall and
 * ranking degrade silently -- a German document keeps its un-stemmed German
 * tokens and an English tsquery never matches them.
 *
 * Two properties of that design are load-bearing here and are asserted by
 * tests rather than left to review:
 *
 * 1. `english` is the default and is byte-identical to the pre-#341 behavior:
 *    it reads the stored, GIN-indexed `search_vector` column. A non-default
 *    configuration recomputes `to_tsvector(<config>, <same source columns>)` on
 *    the fly, so the query arm and the analyzed text always share one config
 *    without a migration or a per-row language column.
 *
 * 2. The configuration is validated against a Zod enum BEFORE it can reach SQL.
 *    Only that enum's values are ever interpolated -- the same discipline this
 *    repo applies to table names. Query text and every namespace or scope
 *    predicate stay fully parameterized; nothing caller-supplied is inlined.
 */
import { z } from "zod";

/**
 * Allowlist of selectable Postgres text-search configurations.
 *
 * Every entry ships with a default PostgreSQL install (snowball dictionaries
 * plus the language-neutral `simple`). This list IS the supported-language
 * policy and is deliberately conservative: a language belongs here only when
 * Postgres can stem it out of the box. Widening it is a tested change, never
 * something a caller can do at runtime.
 */
export const SUPPORTED_FTS_CONFIGS = [
  "english",
  "simple",
  "spanish",
  "french",
  "german",
  "portuguese",
] as const;

export type FtsConfig = (typeof SUPPORTED_FTS_CONFIGS)[number];

/** Default configuration; preserves the pre-#341 english-only behavior. */
export const DEFAULT_FTS_CONFIG: FtsConfig = "english";

/**
 * Zod enum guarding every value that reaches SQL interpolation. A value absent
 * from the allowlist can never become a configuration literal.
 */
export const ftsConfigSchema = z.enum(SUPPORTED_FTS_CONFIGS);

/**
 * Recognized language tokens mapped to a supported regconfig. Keys are
 * lowercased; bare ISO-639-1 codes, common BCP-47 region variants (`en-US`),
 * and English language names are all accepted.
 */
const LANGUAGE_TOKEN_TO_CONFIG: Readonly<Record<string, FtsConfig>> = {
  en: "english",
  eng: "english",
  english: "english",
  es: "spanish",
  spa: "spanish",
  spanish: "spanish",
  fr: "french",
  fra: "french",
  fre: "french",
  french: "french",
  de: "german",
  deu: "german",
  ger: "german",
  german: "german",
  pt: "portuguese",
  por: "portuguese",
  portuguese: "portuguese",
  // Language-neutral: an operator can pin a mixed-language or code-like corpus
  // to `simple` when stemming would hurt more than it helps.
  simple: "simple",
  und: "simple",
};

/** Normalize a language token to its lowercased primary subtag. */
function primarySubtag(language: string): string {
  const [primary] = language.trim().toLowerCase().split(/[-_]/);
  return (primary ?? "").trim();
}

/**
 * Resolve any free-text language token to a supported configuration.
 *
 * @param raw Caller- or operator-supplied token, possibly unrecognized.
 * @returns The mapped configuration, or the english default when unrecognized.
 */
export function resolveFtsConfig(raw: string | undefined): FtsConfig {
  if (!raw) return DEFAULT_FTS_CONFIG;
  const normalized = raw.trim().toLowerCase();
  const direct = ftsConfigSchema.safeParse(normalized);
  if (direct.success) return direct.data;
  return (
    LANGUAGE_TOKEN_TO_CONFIG[normalized] ??
    LANGUAGE_TOKEN_TO_CONFIG[primarySubtag(normalized)] ??
    DEFAULT_FTS_CONFIG
  );
}

/**
 * Resolve the configuration for one request.
 *
 * An unrecognized explicit token falls back to the deployment default rather
 * than to english, so an operator who pinned a corpus keeps that pinning; an
 * explicitly recognized english token stays english.
 *
 * THE DEPLOYMENT DEFAULT IS NOW A PARAMETER, NOT AN ENV READ. It arrives from
 * `config.fts.corpusConfig`, which `server/config/env-groups.ts` derives by
 * calling `resolveFtsConfig` on `OPENBRAIN_FTS_CONFIG` — the same function this
 * module exports, so there is one allowlist and one alias table rather than two
 * opinions on the same question. `server/config/` owns env parsing
 * (`_plans/463-server-rewrite-charter.md:108,119`); the former
 * `corpusFtsConfig(env)` reader was the duplicate half and is gone.
 *
 * @param requested The request's `fts_config` argument, if any.
 * @param corpusDefault The deployment-wide default; english when unset, which
 *   is what an unset `OPENBRAIN_FTS_CONFIG` resolved to.
 */
export function requestFtsConfig(
  requested: string | undefined,
  corpusDefault: FtsConfig = DEFAULT_FTS_CONFIG,
): FtsConfig {
  const raw = requested?.trim();
  if (!raw) return corpusDefault;
  const normalized = raw.toLowerCase();
  const resolved = resolveFtsConfig(normalized);
  if (resolved !== DEFAULT_FTS_CONFIG) return resolved;
  // resolveFtsConfig answers english for anything unrecognized, so distinguish
  // "the caller genuinely asked for english" from "the token meant nothing".
  const knownEnglishToken =
    ftsConfigSchema.safeParse(normalized).success ||
    LANGUAGE_TOKEN_TO_CONFIG[normalized] !== undefined ||
    LANGUAGE_TOKEN_TO_CONFIG[primarySubtag(normalized)] !== undefined;
  return knownEnglishToken ? "english" : corpusDefault;
}

/**
 * Re-assert the allowlist immediately before interpolation.
 *
 * Callers already hold an `FtsConfig`, so this never rejects in practice. It
 * exists so the single place a configuration becomes SQL text is also the place
 * the allowlist is enforced, which keeps that guarantee true even if a future
 * caller reaches this module without passing through the schema.
 *
 * @throws When the value is not on the allowlist.
 */
export function ftsConfigLiteral(config: FtsConfig): FtsConfig {
  const parsed = ftsConfigSchema.safeParse(config);
  if (!parsed.success) {
    throw new Error(`Unsupported text search configuration: ${String(config)}`);
  }
  return parsed.data;
}
