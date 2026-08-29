/**
 * Canonical vs physical shared-namespace resolution (issue 864, L5).
 *
 * `shared-kb` is the ONE public name for shared truth. The legacy `collab`
 * namespace was retired in #167 — frozen and mirrored, not deleted — so this
 * module carries a deliberate two-name model:
 *
 *   - the CANONICAL name is what callers pass and what results report back, so
 *     a client never has to know which physical partition a row lives in;
 *   - the PHYSICAL name is what the `namespace` column actually holds, which is
 *     what a predicate must bind.
 *
 * They are equal in every normal deployment and diverge only when an operator
 * points them apart during a migration.
 *
 * There is NO default legacy namespace: `legacySharedNamespace` is `""` unless
 * an operator sets one. An empty legacy name must never match caller input, so
 * every legacy check below tests for non-empty FIRST — otherwise an unset
 * config would make `""` "legacy" and match unnamespaced input.
 *
 * This module reads no environment. Every raw value arrives as a field of the
 * one {@link SharedNamespaceEnv} options parameter, filled by the caller that
 * already holds the composition root's config. The legacy zero-argument call
 * form lives on in the L5 adapter at `src/shared-namespace.ts`.
 */

import type { AuthInfo } from "../../src/types.ts";

const DEFAULT_SHARED_NAMESPACE = "shared-kb";
const DEFAULT_LEGACY_SHARED_NAMESPACE = "";
const DEFAULT_FALLBACK_MIN_RESULTS = 5;

/**
 * The raw environment values this module resolves a name set from.
 *
 * Each field mirrors the environment variable of the same purpose and is
 * `undefined` when that variable is unset. The caller reads them; this module
 * only interprets them.
 */
export interface SharedNamespaceEnv {
  /** `SHARED_NAMESPACE_CANONICAL`. */
  sharedNamespaceCanonical?: string | undefined;
  /** `SHARED_NAMESPACE_PHYSICAL`. */
  sharedNamespacePhysical?: string | undefined;
  /** `OPENBRAIN_SHARED_NAMESPACE`, the fallback for both names above. */
  openbrainSharedNamespace?: string | undefined;
  /** `SHARED_NAMESPACE_LEGACY`. */
  sharedNamespaceLegacy?: string | undefined;
  /** `OPENBRAIN_LEGACY_SHARED_NAMESPACE`. */
  openbrainLegacySharedNamespace?: string | undefined;
  /** `OPENBRAIN_LEGACY_SHARED_FALLBACK`. */
  legacySharedFallback?: string | undefined;
  /** `OPENBRAIN_SHARED_FALLBACK_MIN_RESULTS`. */
  sharedFallbackMinResults?: string | undefined;
  /** `OPENBRAIN_ALLOW_LEGACY_SHARED_WRITES`. */
  allowLegacySharedWrites?: string | undefined;
}

export interface SharedNamespaceConfig {
  canonicalSharedNamespace: string;
  physicalSharedNamespace: string;
  /** Physical shared namespace used by existing read/write call sites. */
  sharedNamespace: string;
  legacySharedNamespace: string;
  legacyFallbackEnabled: boolean;
  fallbackMinResults: number;
  allowLegacySharedWrites: boolean;
}

/** First non-empty trimmed candidate, or `defaultValue` when none is set. */
function firstNonEmpty(
  candidates: (string | undefined)[],
  defaultValue: string,
): string {
  for (const candidate of candidates) {
    const raw = candidate?.trim();
    if (raw) return raw;
  }
  return defaultValue;
}

/** Truthy spellings accepted for a boolean flag; blank falls back. */
function asBoolean(raw: string | undefined, defaultValue: boolean): boolean {
  if (raw === undefined || raw.trim() === "") return defaultValue;
  return ["1", "true", "yes", "on"].includes(raw.trim().toLowerCase());
}

/** A positive integer, or `defaultValue` for anything else. */
function asPositiveInteger(raw: string | undefined, defaultValue: number): number {
  if (!raw) return defaultValue;
  const parsed = Number.parseInt(raw, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : defaultValue;
}

/**
 * Resolve the shared-namespace name set from raw values the caller supplies.
 *
 * @param env Raw environment values; every field optional, defaults applied.
 * @returns The resolved canonical/physical/legacy name set and its flags.
 */
export function sharedNamespaceConfig(env: SharedNamespaceEnv): SharedNamespaceConfig {
  const canonicalSharedNamespace = firstNonEmpty(
    [env.sharedNamespaceCanonical, env.openbrainSharedNamespace],
    DEFAULT_SHARED_NAMESPACE,
  );
  const physicalSharedNamespace = firstNonEmpty(
    [env.sharedNamespacePhysical, env.openbrainSharedNamespace],
    canonicalSharedNamespace,
  );
  return {
    canonicalSharedNamespace,
    physicalSharedNamespace,
    sharedNamespace: physicalSharedNamespace,
    legacySharedNamespace: firstNonEmpty(
      [env.sharedNamespaceLegacy, env.openbrainLegacySharedNamespace],
      DEFAULT_LEGACY_SHARED_NAMESPACE,
    ),
    legacyFallbackEnabled: asBoolean(env.legacySharedFallback, false),
    fallbackMinResults: asPositiveInteger(
      env.sharedFallbackMinResults,
      DEFAULT_FALLBACK_MIN_RESULTS,
    ),
    allowLegacySharedWrites: asBoolean(env.allowLegacySharedWrites, false),
  };
}

/** True when `namespace` is either name of the shared partition. */
export function isSharedNamespace(namespace: string, env: SharedNamespaceEnv): boolean {
  const config = sharedNamespaceConfig(env);
  return (
    namespace === config.canonicalSharedNamespace ||
    namespace === config.physicalSharedNamespace
  );
}

/**
 * True only when a non-empty legacy shared namespace is configured and matches.
 * With the default (empty) legacy namespace, no input is ever legacy — this
 * prevents an empty config from matching unnamespaced input.
 */
export function isLegacySharedNamespace(
  namespace: string,
  env: SharedNamespaceEnv,
): boolean {
  const legacy = sharedNamespaceConfig(env).legacySharedNamespace;
  return legacy !== "" && namespace === legacy;
}

/** Translate a physical or legacy name to the canonical one. */
export function canonicalNamespace(namespace: string, env: SharedNamespaceEnv): string {
  const config = sharedNamespaceConfig(env);
  if (
    config.legacySharedNamespace !== "" &&
    namespace === config.legacySharedNamespace
  ) {
    return config.canonicalSharedNamespace;
  }
  return namespace === config.physicalSharedNamespace
    ? config.canonicalSharedNamespace
    : namespace;
}

/** Translate the canonical name to the physical one a predicate must bind. */
export function physicalNamespace(namespace: string, env: SharedNamespaceEnv): string {
  const config = sharedNamespaceConfig(env);
  return namespace === config.canonicalSharedNamespace
    ? config.physicalSharedNamespace
    : namespace;
}

/** True when a non-admin write to the legacy shared namespace must be refused. */
export function shouldRejectLegacySharedWrite(
  auth: AuthInfo,
  targetNamespace: string,
  env: SharedNamespaceEnv,
): boolean {
  const config = sharedNamespaceConfig(env);
  if (config.allowLegacySharedWrites) return false;
  if (config.legacySharedNamespace === "") return false;
  if (targetNamespace !== config.legacySharedNamespace) return false;
  return auth.role !== "admin" && auth.role !== "ob-admin";
}
