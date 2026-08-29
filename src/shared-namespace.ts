// L5 adapter (issue 864): legacy call form over server/security/shared-namespace.ts; retired with src/ at L6.
//
// The moved module takes its raw environment values as fields of one options
// parameter. Every legacy caller here calls without one, so this adapter reads
// process.env at call time and forwards the set unchanged. It is a src/ file,
// lint-exempt, and retires with src/ at L6.

import type { AuthInfo } from "../server/types.ts";
import type {
  SharedNamespaceConfig,
  SharedNamespaceEnv,
} from "../server/security/shared-namespace.ts";
import {
  canonicalNamespace as canonicalNamespaceWith,
  isLegacySharedNamespace as isLegacySharedNamespaceWith,
  isSharedNamespace as isSharedNamespaceWith,
  physicalNamespace as physicalNamespaceWith,
  sharedNamespaceConfig as sharedNamespaceConfigWith,
  shouldRejectLegacySharedWrite as shouldRejectLegacySharedWriteWith,
} from "../server/security/shared-namespace.ts";

export type { SharedNamespaceConfig };

/** Read the shared-namespace environment at call time, as legacy callers expect. */
function currentEnv(): SharedNamespaceEnv {
  return {
    sharedNamespaceCanonical: process.env["SHARED_NAMESPACE_CANONICAL"],
    sharedNamespacePhysical: process.env["SHARED_NAMESPACE_PHYSICAL"],
    openbrainSharedNamespace: process.env["OPENBRAIN_SHARED_NAMESPACE"],
    sharedNamespaceLegacy: process.env["SHARED_NAMESPACE_LEGACY"],
    openbrainLegacySharedNamespace: process.env["OPENBRAIN_LEGACY_SHARED_NAMESPACE"],
    legacySharedFallback: process.env["OPENBRAIN_LEGACY_SHARED_FALLBACK"],
    sharedFallbackMinResults: process.env["OPENBRAIN_SHARED_FALLBACK_MIN_RESULTS"],
    allowLegacySharedWrites: process.env["OPENBRAIN_ALLOW_LEGACY_SHARED_WRITES"],
  };
}

export function sharedNamespaceConfig(): SharedNamespaceConfig {
  return sharedNamespaceConfigWith(currentEnv());
}

export function isSharedNamespace(namespace: string): boolean {
  return isSharedNamespaceWith(namespace, currentEnv());
}

export function isLegacySharedNamespace(namespace: string): boolean {
  return isLegacySharedNamespaceWith(namespace, currentEnv());
}

export function canonicalNamespace(namespace: string): string {
  return canonicalNamespaceWith(namespace, currentEnv());
}

export function physicalNamespace(namespace: string): string {
  return physicalNamespaceWith(namespace, currentEnv());
}

export function shouldRejectLegacySharedWrite(
  auth: AuthInfo,
  targetNamespace: string,
): boolean {
  return shouldRejectLegacySharedWriteWith(auth, targetNamespace, currentEnv());
}
