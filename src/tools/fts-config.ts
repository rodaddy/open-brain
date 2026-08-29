// L5 adapter (issue 864): legacy call form over server/tools/legacy-search/fts-config.ts; retired with src/ at L6.
//
// The server/ module takes its environment as a required parameter (the
// server/ lint rules forbid reading process.env there). Legacy src/ callers
// call these three selectors with no environment argument, so this adapter
// keeps that call form by supplying process.env itself.
import {
  corpusFtsConfig as corpusFtsConfigWithEnv,
  ftsStatementTimeoutMs as ftsStatementTimeoutMsWithEnv,
  requestFtsConfig as requestFtsConfigWithEnv,
  type FtsConfig,
} from "../../server/tools/legacy-search/fts-config.ts";

export {
  DEFAULT_FTS_CONFIG,
  DEFAULT_FTS_STATEMENT_TIMEOUT_MS,
  ftsConfigLiteral,
  ftsConfigSchema,
  resolveFtsConfig,
  SUPPORTED_FTS_CONFIGS,
  type FtsConfig,
} from "../../server/tools/legacy-search/fts-config.ts";

export function corpusFtsConfig(env: NodeJS.ProcessEnv = process.env): FtsConfig {
  return corpusFtsConfigWithEnv(env);
}

export function requestFtsConfig(
  requested: string | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
): FtsConfig {
  return requestFtsConfigWithEnv(requested, env);
}

export function ftsStatementTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  return ftsStatementTimeoutMsWithEnv(env);
}
