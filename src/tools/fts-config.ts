import { z } from "zod";

/**
 * Language-aware PostgreSQL full-text-search (FTS) configuration selection for
 * hybrid retrieval (Issue #341, SOURCE-5).
 *
 * WHY THIS EXISTS
 * The hybrid lexical arm (src/tools/search-brain.ts buildFtsCTE) builds its
 * tsvector/tsquery with a Postgres text-search configuration ("regconfig").
 * That config controls stemming and stopword handling. If the query arm uses a
 * different config than the one the indexed text was analyzed with, recall and
 * ranking silently degrade -- a German document analyzed as English keeps its
 * un-stemmed German tokens, and an English tsquery never matches them.
 *
 * SCOPE (deliberately narrow)
 * - `english` is the default and preserves today's behavior byte-for-byte.
 * - Only Postgres-shipped regconfigs on an explicit allowlist are selectable.
 *   The selected value is validated against a Zod enum BEFORE it is ever
 *   interpolated into SQL, so the config literal can be inlined safely (same
 *   discipline the repo applies to interpolated table names). tsquery text and
 *   all namespace / source-scope predicates stay fully parameterized.
 * - The public `search_brain` handler selects its config from the request's
 *   `fts_config` argument or the operator-controlled OPENBRAIN_FTS_CONFIG env
 *   default, then passes the resolved value explicitly to the shared search
 *   primitive. Other executeSearch callers always retain the english default.
 *   A free-text source language (`ob_sources.language`, BCP-47-ish) is only a
 *   candidate value for that public setting -- resolveFtsConfig maps such a
 *   token to a supported regconfig (english fallback for the unrecognized). It
 *   is NOT auto-linked to a row's retrieval: `thoughts` has no source_id, so an
 *   ob_sources row cannot, on its own, control the config a search analyzes
 *   with. This never invents a config Postgres does not ship, and never widens
 *   an isolation boundary.
 *
 * NON-GOALS
 * - No per-row language column, no generated-column rewrite, no migration. The
 *   default path keeps using the stored `search_vector` GIN column; a non-default
 *   corpus config recomputes `to_tsvector(config, <same source columns>)` on the
 *   fly so the query arm and the analyzed text always share one config.
 * - No language framework, no auto-detection, no embedding-model change.
 */

/**
 * Allowlist of selectable Postgres text-search configurations. Every entry is a
 * configuration PostgreSQL ships in a default install (`snowball` dictionaries
 * plus the language-neutral `simple`). `english` is first and is the default.
 *
 * This list is the supported-language policy. It is intentionally conservative:
 * a language is supported only when Postgres can actually stem it out of the box
 * and we have a fixture proving the ranking behavior. Widening it is a
 * deliberate, tested change -- not something a caller can do at runtime.
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

/** Default configuration -- preserves the pre-#341 english-only behavior. */
export const DEFAULT_FTS_CONFIG: FtsConfig = "english";

/**
 * Zod enum guarding every value that reaches SQL interpolation. A value that is
 * not on the allowlist can never be turned into a config literal.
 */
export const ftsConfigSchema = z.enum(SUPPORTED_FTS_CONFIGS);

/**
 * Map of recognized `ob_sources.language` tokens to a supported regconfig. Keys
 * are lowercased; we accept both bare ISO-639-1 codes and common BCP-47 region
 * variants (e.g. `en`, `en-US`) plus the English language name. Anything not
 * present resolves to the default via resolveFtsConfig.
 */
const LANGUAGE_TOKEN_TO_CONFIG: Record<string, FtsConfig> = {
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
  // Language-neutral: an operator can pin a corpus to `simple` when its content
  // is mixed-language or code-like and stemming would hurt more than help.
  simple: "simple",
  und: "simple",
};

/** Normalize a language token to its primary subtag, lowercased. */
function primarySubtag(language: string): string {
  const trimmed = language.trim().toLowerCase();
  // Split BCP-47 on `-`/`_` and keep the leading language subtag.
  const [primary] = trimmed.split(/[-_]/);
  return (primary ?? "").trim();
}

/**
 * Resolve an approved source's free-text language into a supported FTS config.
 * Unknown, empty, or unsupported values fall back to the english default so a
 * corpus without a recognized language keeps exactly today's behavior.
 *
 * This is a pure mapping and does NOT by itself wire a source to a search: a
 * thought carries no source_id, so nothing links a stored ob_sources.language
 * to a given row's retrieval. Agreement happens only when a caller or route
 * feeds a declared language into the search path as an explicit setting -- see
 * requestFtsConfig, which the public `search_brain` `fts_config` argument uses.
 */
export function resolveFtsConfig(
  language: string | null | undefined,
): FtsConfig {
  if (!language) return DEFAULT_FTS_CONFIG;
  const exact = LANGUAGE_TOKEN_TO_CONFIG[language.trim().toLowerCase()];
  if (exact) return exact;
  const primary = LANGUAGE_TOKEN_TO_CONFIG[primarySubtag(language)];
  return primary ?? DEFAULT_FTS_CONFIG;
}

/**
 * Resolve the operator-controlled corpus FTS config for the public search
 * handler. Retrieval does not carry a per-row language, so a deployment opts
 * into its corpus FTS config out of band via env; unset or unsupported keeps
 * the english default.
 *
 * OPENBRAIN_FTS_CONFIG accepts either a supported regconfig name directly
 * (`german`) or a source-style language token (`de`, `de-DE`); both resolve
 * through the same allowlist. An unrecognized value logs nothing and falls back
 * to english so a typo can never disable lexical search.
 */
export function corpusFtsConfig(
  env: NodeJS.ProcessEnv = process.env,
): FtsConfig {
  const raw = env.OPENBRAIN_FTS_CONFIG?.trim();
  if (!raw) return DEFAULT_FTS_CONFIG;
  const direct = ftsConfigSchema.safeParse(raw.toLowerCase());
  if (direct.success) return direct.data;
  return resolveFtsConfig(raw);
}

/**
 * Resolve the FTS config for one public `search_brain` request. An explicit
 * caller setting (`fts_config`) wins when it names a supported regconfig or a
 * recognized language token; anything else falls back to the deployment corpus
 * default (OPENBRAIN_FTS_CONFIG, else english).
 *
 * This is the caller-visible, provenance-bound selector: the config is carried
 * by the request itself, not inferred from an unlinked source row, so what a
 * caller (or an ingest route that knows a corpus's language) asks for is what
 * the real search path actually analyzes with. An unrecognized value can never
 * disable lexical search -- it degrades to the corpus default.
 */
export function requestFtsConfig(
  requested: string | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
): FtsConfig {
  const raw = requested?.trim();
  if (!raw) return corpusFtsConfig(env);
  const direct = ftsConfigSchema.safeParse(raw.toLowerCase());
  if (direct.success) return direct.data;
  const resolved = resolveFtsConfig(raw);
  // resolveFtsConfig returns english for anything unrecognized; when the caller
  // passed an unrecognized token, prefer the corpus default over silently
  // forcing english (which may not be the deployment's configured corpus).
  if (resolved !== DEFAULT_FTS_CONFIG) return resolved;
  const knownEnglishToken =
    LANGUAGE_TOKEN_TO_CONFIG[raw.toLowerCase()] === "english" ||
    LANGUAGE_TOKEN_TO_CONFIG[primarySubtag(raw)] === "english";
  return knownEnglishToken ? "english" : corpusFtsConfig(env);
}

/**
 * Assert a config is on the allowlist and return it as a bare regconfig literal
 * safe to interpolate. Throws on anything unexpected -- a defensive backstop in
 * case a caller bypasses the schema. Callers already hold an FtsConfig, so this
 * never throws in normal flow; it exists so a future refactor cannot smuggle an
 * arbitrary string into the SQL config literal.
 */
export function ftsConfigLiteral(config: FtsConfig): string {
  const parsed = ftsConfigSchema.safeParse(config);
  if (!parsed.success) {
    throw new Error(`Unsupported FTS configuration: ${String(config)}`);
  }
  return parsed.data;
}
