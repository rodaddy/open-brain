import type { AuthInfo } from "./types.ts";

const DEFAULT_SHARED_NAMESPACE = "shared-kb";
const DEFAULT_LEGACY_SHARED_NAMESPACE = "collab";
const DEFAULT_FALLBACK_MIN_RESULTS = 5;

function envString(names: string[], defaultValue: string): string {
  for (const name of names) {
    const raw = process.env[name]?.trim();
    if (raw) return raw;
  }
  return defaultValue;
}

function envBoolean(name: string, defaultValue: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return defaultValue;
  return ["1", "true", "yes", "on"].includes(raw.trim().toLowerCase());
}

function envPositiveInteger(name: string, defaultValue: number): number {
  const raw = process.env[name];
  if (!raw) return defaultValue;
  const parsed = Number.parseInt(raw, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : defaultValue;
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

export function sharedNamespaceConfig(): SharedNamespaceConfig {
  const canonicalSharedNamespace = envString(
    ["SHARED_NAMESPACE_CANONICAL", "OPENBRAIN_SHARED_NAMESPACE"],
    DEFAULT_SHARED_NAMESPACE,
  );
  const physicalSharedNamespace = envString(
    ["SHARED_NAMESPACE_PHYSICAL", "OPENBRAIN_SHARED_NAMESPACE"],
    canonicalSharedNamespace,
  );
  return {
    canonicalSharedNamespace,
    physicalSharedNamespace,
    sharedNamespace: physicalSharedNamespace,
    legacySharedNamespace: envString(
      ["SHARED_NAMESPACE_LEGACY", "OPENBRAIN_LEGACY_SHARED_NAMESPACE"],
      DEFAULT_LEGACY_SHARED_NAMESPACE,
    ),
    legacyFallbackEnabled: envBoolean(
      "OPENBRAIN_LEGACY_SHARED_FALLBACK",
      true,
    ),
    fallbackMinResults: envPositiveInteger(
      "OPENBRAIN_SHARED_FALLBACK_MIN_RESULTS",
      DEFAULT_FALLBACK_MIN_RESULTS,
    ),
    allowLegacySharedWrites: envBoolean(
      "OPENBRAIN_ALLOW_LEGACY_SHARED_WRITES",
      false,
    ),
  };
}

export function isSharedNamespace(namespace: string): boolean {
  const config = sharedNamespaceConfig();
  return (
    namespace === config.canonicalSharedNamespace ||
    namespace === config.physicalSharedNamespace
  );
}

export function isLegacySharedNamespace(namespace: string): boolean {
  return namespace === sharedNamespaceConfig().legacySharedNamespace;
}

export function canonicalNamespace(namespace: string): string {
  const config = sharedNamespaceConfig();
  return namespace === config.legacySharedNamespace ||
    namespace === config.physicalSharedNamespace
    ? config.canonicalSharedNamespace
    : namespace;
}

export function physicalNamespace(namespace: string): string {
  const config = sharedNamespaceConfig();
  return namespace === config.canonicalSharedNamespace
    ? config.physicalSharedNamespace
    : namespace;
}

export function shouldRejectLegacySharedWrite(
  auth: AuthInfo,
  targetNamespace: string,
): boolean {
  const config = sharedNamespaceConfig();
  if (config.allowLegacySharedWrites) return false;
  if (targetNamespace !== config.legacySharedNamespace) return false;
  return auth.role !== "admin" && auth.role !== "n8n";
}
